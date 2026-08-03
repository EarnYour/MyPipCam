import AVFoundation
import AppKit
import Combine
import SwiftUI

@MainActor
final class CameraManager: ObservableObject {
    private static let selectedDeviceDefaultsKey = "selectedCameraDeviceID"

    @Published private(set) var devices: [AVCaptureDevice] = []
    @Published var selectedDeviceID: String = "" {
        didSet {
            guard oldValue != selectedDeviceID else { return }
            persistSelectedDeviceID()
            guard !suppressDeviceRestart else { return }
            Task { await restartSessionIfNeeded() }
        }
    }
    @Published private(set) var authorizationStatus: AVAuthorizationStatus = .notDetermined
    @Published private(set) var isRunning = false
    @Published var errorMessage: String?

    let session = AVCaptureSession()
    private var isConfigured = false
    private var suppressDeviceRestart = false
    private var startGeneration = 0
    private let sessionQueue = DispatchQueue(label: "com.mypipcam.session")
    private var deviceObservers: [NSObjectProtocol] = []
    /// uniqueID of the device currently wired into `session`, so an activation
    /// that changes nothing can skip the teardown/rebuild entirely.
    private var configuredDeviceID: String?
    private var runtimeErrorObserver: NSObjectProtocol?

    init() {
        authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
        // Restore last-used camera before discovery so we don't overwrite with OBS.
        // Suppress didSet restarts during init — onAppear starts the session once.
        suppressDeviceRestart = true
        let savedID = UserDefaults.standard.string(forKey: Self.selectedDeviceDefaultsKey) ?? ""
        if !savedID.isEmpty {
            selectedDeviceID = savedID
        }
        refreshDevices()
        suppressDeviceRestart = false

        let connect = NotificationCenter.default.addObserver(
            forName: AVCaptureDevice.wasConnectedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshDevices() }
        }
        let disconnect = NotificationCenter.default.addObserver(
            forName: AVCaptureDevice.wasDisconnectedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshDevices() }
        }
        deviceObservers = [connect, disconnect]
        observeRuntimeErrors()
    }

    func refreshDevices() {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [
                .builtInWideAngleCamera,
                .external,
                .continuityCamera,
                .deskViewCamera
            ],
            mediaType: .video,
            position: .unspecified
        )
        var seen = Set<String>()
        devices = discovery.devices.filter { seen.insert($0.uniqueID).inserted }

        // A device that unplugged and came back keeps its uniqueID, so the
        // "nothing changed" fast path in startSession would wrongly skip the
        // rebuild the dead capture graph needs. Forget it while it is absent.
        if let configured = configuredDeviceID,
           !devices.contains(where: { $0.uniqueID == configured }) {
            configuredDeviceID = nil
        }

        if selectedDeviceID.isEmpty || !devices.contains(where: { $0.uniqueID == selectedDeviceID }) {
            selectedDeviceID = Self.preferredDefaultDeviceID(from: devices) ?? ""
        }
    }

    /// Starts the camera when already authorized; prompts only if status is `.notDetermined`.
    /// If denied/restricted, shows guidance and does not re-trigger the system dialog.
    func requestAccessAndStart() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        authorizationStatus = status

        switch status {
        case .authorized:
            errorMessage = nil
            await startSession()
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            authorizationStatus = granted ? .authorized : .denied
            if granted {
                refreshDevices()
                errorMessage = nil
                await startSession()
            } else {
                errorMessage = Self.deniedMessage
            }
        case .denied, .restricted:
            // Do not call requestAccess again — macOS will not show the dialog.
            errorMessage = Self.deniedMessage
        @unknown default:
            errorMessage = "Unable to access the camera."
        }
    }

    /// - Parameter force: rebuild the capture graph even if it already runs the
    ///   selected device (used when the device list changes underneath us).
    func startSession(force: Bool = false) async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        authorizationStatus = status

        guard status == .authorized else {
            // Avoid recursively treating denied as a fresh request loop.
            if status == .notDetermined {
                await requestAccessAndStart()
            } else {
                errorMessage = Self.deniedMessage
            }
            return
        }

        errorMessage = nil
        refreshDevices()

        // Bound once, above the fast path below: a local named `session`
        // shadows the property for the whole function body, so referencing
        // the bare name before this line is a use-before-declaration.
        let session = self.session

        // Tearing down and re-adding the input drops frames — the bubble goes
        // black for a moment, which is visible to anyone capturing it (OBS).
        // Every app activation calls in here, so no-op when nothing changed.
        // `session.isRunning` is the authoritative check: the published
        // `isRunning` can lag if the session stopped on its own. This sits
        // after `refreshDevices()` so an unplugged device has already cleared
        // `configuredDeviceID` and can't be mistaken for "nothing changed".
        if !force, isConfigured, configuredDeviceID == selectedDeviceID, session.isRunning {
            return
        }

        startGeneration += 1
        let generation = startGeneration
        let preferredID = selectedDeviceID
        let fallbackIDs = Self.fallbackDeviceIDs(preferred: preferredID, devices: devices)

        let result: StartResult = await withCheckedContinuation { continuation in
            sessionQueue.async {
                let outcome = Self.configureAndStart(
                    session: session,
                    deviceIDs: fallbackIDs
                )
                continuation.resume(returning: outcome)
            }
        }

        guard generation == startGeneration else { return }

        switch result {
        case .running(let deviceID):
            isConfigured = true
            isRunning = true
            errorMessage = nil
            // Remember what is actually wired in, so the next activation can
            // take the no-op fast path above instead of rebuilding the graph.
            configuredDeviceID = deviceID
            if selectedDeviceID != deviceID {
                suppressDeviceRestart = true
                selectedDeviceID = deviceID
                suppressDeviceRestart = false
            }
        case .failed(let message, let clearSelection):
            isConfigured = false
            isRunning = false
            errorMessage = message
            configuredDeviceID = nil
            if clearSelection, !selectedDeviceID.isEmpty {
                // Drop a stale ID so the next retry can pick a healthy default.
                UserDefaults.standard.removeObject(forKey: Self.selectedDeviceDefaultsKey)
            }
        }

        // Brief settle + one automatic retry — device busy / USB cameras often need a beat.
        if case .failed = result, generation == startGeneration {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard generation == startGeneration else { return }
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
            guard !session.isRunning else {
                isConfigured = true
                isRunning = true
                errorMessage = nil
                return
            }

            startGeneration += 1
            let retryGeneration = startGeneration
            let retryIDs = Self.fallbackDeviceIDs(preferred: selectedDeviceID, devices: devices)
            let retry: StartResult = await withCheckedContinuation { continuation in
                sessionQueue.async {
                    let outcome = Self.configureAndStart(
                        session: session,
                        deviceIDs: retryIDs
                    )
                    continuation.resume(returning: outcome)
                }
            }
            guard retryGeneration == startGeneration else { return }
            switch retry {
            case .running(let deviceID):
                isConfigured = true
                isRunning = true
                errorMessage = nil
                if selectedDeviceID != deviceID {
                    suppressDeviceRestart = true
                    selectedDeviceID = deviceID
                    suppressDeviceRestart = false
                }
                configuredDeviceID = deviceID
            case .failed(let message, _):
                isConfigured = false
                isRunning = false
                errorMessage = message
                configuredDeviceID = nil
            }
        }
    }

    private func restartSessionIfNeeded() async {
        guard isConfigured || isRunning || authorizationStatus == .authorized else { return }
        // The selected device just changed, so the running graph is stale.
        await startSession(force: true)
    }

    func stopSession() {
        startGeneration += 1
        sessionQueue.async { [session] in
            if session.isRunning {
                session.stopRunning()
            }
            DispatchQueue.main.async {
                self.isRunning = false
                self.configuredDeviceID = nil
            }
        }
    }

    /// Opens System Settings → Privacy & Security → Camera.
    func openSystemCameraSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
            "x-apple.systempreferences:com.apple.Settings.PrivacySecurity.extension?Privacy_Camera"
        ]
        for string in candidates {
            if let url = URL(string: string), NSWorkspace.shared.open(url) {
                return
            }
        }
    }

    var needsCameraPermissionInSettings: Bool {
        switch authorizationStatus {
        case .denied, .restricted:
            return true
        default:
            return false
        }
    }

    var canRetryCameraStart: Bool {
        authorizationStatus == .authorized && errorMessage != nil && !isRunning
    }

    private func persistSelectedDeviceID() {
        guard !selectedDeviceID.isEmpty else { return }
        UserDefaults.standard.set(selectedDeviceID, forKey: Self.selectedDeviceDefaultsKey)
    }

    private func observeRuntimeErrors() {
        runtimeErrorObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            let avError = (notification.userInfo?[AVCaptureSessionErrorKey] as? AVError)
            let message = Self.message(for: avError)
            Task { @MainActor in
                self.isRunning = false
                self.isConfigured = false
                self.errorMessage = message
            }
        }
    }

    private enum StartResult {
        case running(deviceID: String)
        case failed(message: String, clearSelection: Bool)
    }

    /// Configure + start on the session queue. Tries each device ID in order.
    private nonisolated static func configureAndStart(
        session: AVCaptureSession,
        deviceIDs: [String]
    ) -> StartResult {
        if session.isRunning {
            session.stopRunning()
        }

        var lastMessage = "Camera session failed to start."
        var sawMissingDevice = false

        for deviceID in deviceIDs {
            session.beginConfiguration()

            for input in session.inputs {
                session.removeInput(input)
            }

            let device = AVCaptureDevice(uniqueID: deviceID)
                ?? (deviceID.isEmpty ? AVCaptureDevice.default(for: .video) : nil)
            guard let device else {
                session.commitConfiguration()
                sawMissingDevice = true
                lastMessage = "No camera found. Connect a camera or start OBS Virtual Camera."
                continue
            }

            let input: AVCaptureDeviceInput
            do {
                input = try AVCaptureDeviceInput(device: device)
            } catch {
                session.commitConfiguration()
                lastMessage = message(for: error, deviceName: device.localizedName)
                if isMissingOrDisconnected(error) {
                    sawMissingDevice = true
                }
                continue
            }

            guard session.canAddInput(input) else {
                session.commitConfiguration()
                lastMessage =
                    "Couldn't attach \(device.localizedName). It may already be in use by another app."
                continue
            }

            session.addInput(input)
            // Preset support depends on the attached input — set after addInput.
            applyBestPreset(to: session)
            session.commitConfiguration()
            session.startRunning()

            if session.isRunning {
                return .running(deviceID: device.uniqueID)
            }

            lastMessage =
                "Couldn't start \(device.localizedName). Quit apps using the camera and try again."
        }

        return .failed(message: lastMessage, clearSelection: sawMissingDevice)
    }

    private nonisolated static func applyBestPreset(to session: AVCaptureSession) {
        // `.high` is unsupported on many Studio Display / UVC / virtual cameras and
        // leaves startRunning() returning with isRunning == false.
        let candidates: [AVCaptureSession.Preset] = [
            .hd1280x720,
            .vga640x480,
            .medium,
            .low,
            .high
        ]
        for preset in candidates {
            if session.canSetSessionPreset(preset) {
                session.sessionPreset = preset
                return
            }
        }
    }

    private nonisolated static func fallbackDeviceIDs(
        preferred: String,
        devices: [AVCaptureDevice]
    ) -> [String] {
        var ids: [String] = []
        if !preferred.isEmpty {
            ids.append(preferred)
        }
        if let defaultID = AVCaptureDevice.default(for: .video)?.uniqueID,
           !ids.contains(defaultID) {
            ids.append(defaultID)
        }
        for device in devices.sorted(by: deviceSort) {
            if !ids.contains(device.uniqueID) {
                ids.append(device.uniqueID)
            }
        }
        if ids.isEmpty {
            ids.append("")
        }
        return ids
    }

    private nonisolated static func preferredDefaultDeviceID(from devices: [AVCaptureDevice]) -> String? {
        if let defaultID = AVCaptureDevice.default(for: .video)?.uniqueID,
           devices.contains(where: { $0.uniqueID == defaultID }) {
            return defaultID
        }
        return devices.sorted(by: deviceSort).first?.uniqueID
    }

    /// Prefer real cameras over virtual / OBS when auto-selecting.
    private nonisolated static func deviceSort(_ a: AVCaptureDevice, _ b: AVCaptureDevice) -> Bool {
        let aVirtual = isVirtualCamera(a)
        let bVirtual = isVirtualCamera(b)
        if aVirtual != bVirtual { return !aVirtual && bVirtual }
        return a.localizedName.localizedCaseInsensitiveCompare(b.localizedName) == .orderedAscending
    }

    private nonisolated static func isVirtualCamera(_ device: AVCaptureDevice) -> Bool {
        let name = device.localizedName.localizedLowercase
        return name.contains("obs")
            || name.contains("virtual")
            || name.contains("webcam utility")
            || name.contains("snap camera")
            || name.contains("mmhmm")
    }

    private nonisolated static func message(for error: Error, deviceName: String) -> String {
        let ns = error as NSError
        if let av = error as? AVError {
            return message(for: av, deviceName: deviceName)
        }
        if ns.domain == AVFoundationErrorDomain {
            return message(for: AVError(_nsError: ns), deviceName: deviceName)
        }
        return "Couldn't open \(deviceName): \(error.localizedDescription)"
    }

    private nonisolated static func message(for error: AVError?, deviceName: String? = nil) -> String {
        guard let error else {
            return "Camera session failed to start. Quit apps using the camera and try again."
        }
        let name = deviceName ?? "camera"
        switch error.code {
        case .applicationIsNotAuthorizedToUseDevice, .applicationIsNotAuthorized:
            return deniedMessage
        case .deviceAlreadyUsedByAnotherSession, .deviceInUseByAnotherApplication:
            return "\(name) is in use by another app. Quit that app, then retry."
        case .deviceWasDisconnected, .deviceNotConnected:
            return "\(name) disconnected. Pick another camera or reconnect it."
        case .deviceLockedForConfigurationByAnotherProcess:
            return "\(name) is busy. Wait a moment and retry."
        default:
            let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            if detail.isEmpty {
                return "Couldn't start \(name)."
            }
            return "Couldn't start \(name): \(detail)"
        }
    }

    private nonisolated static func isMissingOrDisconnected(_ error: Error) -> Bool {
        let ns = error as NSError
        guard ns.domain == AVFoundationErrorDomain else { return false }
        switch AVError.Code(rawValue: ns.code) {
        case .deviceWasDisconnected, .deviceNotConnected:
            return true
        default:
            return false
        }
    }

    private static let deniedMessage =
        "Camera access is blocked. Enable MyPipCam in System Settings → Privacy & Security → Camera."

    deinit {
        for observer in deviceObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        if let runtimeErrorObserver {
            NotificationCenter.default.removeObserver(runtimeErrorObserver)
        }
    }
}

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
            Task { await restartSessionIfNeeded() }
        }
    }
    @Published private(set) var authorizationStatus: AVAuthorizationStatus = .notDetermined
    @Published private(set) var isRunning = false
    @Published var errorMessage: String?

    let session = AVCaptureSession()
    private var isConfigured = false
    private let sessionQueue = DispatchQueue(label: "com.mypipcam.session")
    private var deviceObservers: [NSObjectProtocol] = []
    /// uniqueID of the device currently wired into `session`, so an activation
    /// that changes nothing can skip the teardown/rebuild entirely.
    private var configuredDeviceID: String?

    init() {
        authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
        // Restore last-used camera before discovery so we don't overwrite with OBS.
        let savedID = UserDefaults.standard.string(forKey: Self.selectedDeviceDefaultsKey) ?? ""
        if !savedID.isEmpty {
            selectedDeviceID = savedID
        }
        refreshDevices()
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
        devices = discovery.devices

        // A device that unplugged and came back keeps its uniqueID, so the
        // "nothing changed" fast path in startSession would wrongly skip the
        // rebuild the dead capture graph needs. Forget it while it is absent.
        if let configured = configuredDeviceID,
           !devices.contains(where: { $0.uniqueID == configured }) {
            configuredDeviceID = nil
        }

        if selectedDeviceID.isEmpty || !devices.contains(where: { $0.uniqueID == selectedDeviceID }) {
            if let obs = devices.first(where: { $0.localizedName.localizedCaseInsensitiveContains("OBS") }) {
                selectedDeviceID = obs.uniqueID
            } else if let first = devices.first {
                selectedDeviceID = first.uniqueID
            }
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
        let deviceID = selectedDeviceID

        // Tearing down and re-adding the input drops frames — the bubble goes
        // black for a moment, which is visible to anyone capturing it (OBS).
        // Every app activation calls in here, so no-op when nothing changed.
        // `session.isRunning` is the authoritative check: the published
        // `isRunning` can lag if the session stopped on its own.
        if !force, isConfigured, configuredDeviceID == deviceID, session.isRunning {
            return
        }

        let session = self.session

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            sessionQueue.async {
                if session.isRunning {
                    session.stopRunning()
                }

                session.beginConfiguration()
                session.sessionPreset = .high

                for input in session.inputs {
                    session.removeInput(input)
                }

                guard
                    let device = AVCaptureDevice(uniqueID: deviceID) ?? AVCaptureDevice.default(for: .video),
                    let input = try? AVCaptureDeviceInput(device: device),
                    session.canAddInput(input)
                else {
                    session.commitConfiguration()
                    DispatchQueue.main.async {
                        self.errorMessage = "Couldn't open that camera. Is OBS Virtual Camera started?"
                        self.isRunning = false
                        self.isConfigured = false
                        self.configuredDeviceID = nil
                    }
                    continuation.resume()
                    return
                }

                session.addInput(input)
                session.commitConfiguration()
                session.startRunning()

                let openedDeviceID = device.uniqueID
                DispatchQueue.main.async {
                    self.isConfigured = true
                    self.isRunning = session.isRunning
                    self.configuredDeviceID = session.isRunning ? openedDeviceID : nil
                    if !session.isRunning {
                        self.errorMessage = "Camera session failed to start."
                    }
                }
                continuation.resume()
            }
        }
    }

    private func restartSessionIfNeeded() async {
        guard isConfigured || isRunning || authorizationStatus == .authorized else { return }
        // The selected device just changed, so the running graph is stale.
        await startSession(force: true)
    }

    func stopSession() {
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

    private func persistSelectedDeviceID() {
        guard !selectedDeviceID.isEmpty else { return }
        UserDefaults.standard.set(selectedDeviceID, forKey: Self.selectedDeviceDefaultsKey)
    }

    private static let deniedMessage =
        "Camera access is blocked. Enable MyPipCam in System Settings → Privacy & Security → Camera."

    deinit {
        for observer in deviceObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}

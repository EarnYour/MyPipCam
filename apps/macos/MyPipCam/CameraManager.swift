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

    func startSession() async {
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
                    }
                    continuation.resume()
                    return
                }

                session.addInput(input)
                session.commitConfiguration()
                session.startRunning()

                DispatchQueue.main.async {
                    self.isConfigured = true
                    self.isRunning = session.isRunning
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
        await startSession()
    }

    func stopSession() {
        sessionQueue.async { [session] in
            if session.isRunning {
                session.stopRunning()
            }
            DispatchQueue.main.async {
                self.isRunning = false
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

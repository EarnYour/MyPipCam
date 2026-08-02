import AVFoundation
import Combine
import SwiftUI

@MainActor
final class CameraManager: ObservableObject {
    @Published private(set) var devices: [AVCaptureDevice] = []
    @Published var selectedDeviceID: String = "" {
        didSet {
            guard oldValue != selectedDeviceID else { return }
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

    func requestAccessAndStart() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        authorizationStatus = status

        switch status {
        case .authorized:
            await startSession()
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            authorizationStatus = granted ? .authorized : .denied
            if granted {
                refreshDevices()
                await startSession()
            } else {
                errorMessage = "Camera access was denied. Enable it in System Settings → Privacy & Security → Camera."
            }
        case .denied, .restricted:
            errorMessage = "Camera access is blocked. Enable it in System Settings → Privacy & Security → Camera."
        @unknown default:
            errorMessage = "Unable to access the camera."
        }
    }

    func startSession() async {
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            await requestAccessAndStart()
            return
        }

        authorizationStatus = .authorized
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

    deinit {
        for observer in deviceObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}

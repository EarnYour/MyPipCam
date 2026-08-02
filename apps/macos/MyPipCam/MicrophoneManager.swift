import AVFoundation
import AppKit
import Combine
import SwiftUI

/// Enumerates and persists the preferred microphone. The macOS bubble does not
/// record audio itself — OBS / system capture or the Chrome extension owns the
/// final mix — but the selection is stored for parity and future use.
@MainActor
final class MicrophoneManager: ObservableObject {
    private static let selectedDeviceDefaultsKey = "selectedMicrophoneID"

    @Published private(set) var devices: [AVCaptureDevice] = []
    @Published var selectedDeviceID: String = "" {
        didSet {
            guard oldValue != selectedDeviceID else { return }
            persistSelectedDeviceID()
        }
    }
    @Published private(set) var authorizationStatus: AVAuthorizationStatus = .notDetermined
    @Published var errorMessage: String?

    private var deviceObservers: [NSObjectProtocol] = []

    init() {
        authorizationStatus = AVCaptureDevice.authorizationStatus(for: .audio)
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
                .microphone,
                .external
            ],
            mediaType: .audio,
            position: .unspecified
        )
        // Deduplicate by uniqueID (some devices appear under multiple types).
        var seen = Set<String>()
        devices = discovery.devices.filter { device in
            seen.insert(device.uniqueID).inserted
        }

        if selectedDeviceID.isEmpty || !devices.contains(where: { $0.uniqueID == selectedDeviceID }) {
            if let defaultMic = AVCaptureDevice.default(for: .audio),
               devices.contains(where: { $0.uniqueID == defaultMic.uniqueID }) {
                selectedDeviceID = defaultMic.uniqueID
            } else if let first = devices.first {
                selectedDeviceID = first.uniqueID
            }
        }
    }

    /// Refreshes the device list without ever showing the system mic prompt.
    /// Use when simply opening a menu: this app never captures audio, so a
    /// permission dialog raised by hovering the controls looks like spyware.
    func refreshWithoutPrompting() {
        authorizationStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        if authorizationStatus == .authorized {
            errorMessage = nil
        }
        refreshDevices()
    }

    /// Prompts for mic access when status is `.notDetermined` so device labels appear.
    /// Call ONLY from an explicit user action that selects a microphone.
    func ensureAccess() async {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        authorizationStatus = status

        switch status {
        case .authorized:
            errorMessage = nil
            refreshDevices()
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            authorizationStatus = granted ? .authorized : .denied
            if granted {
                errorMessage = nil
                refreshDevices()
            } else {
                errorMessage = Self.deniedMessage
            }
        case .denied, .restricted:
            errorMessage = Self.deniedMessage
        @unknown default:
            errorMessage = "Unable to access the microphone."
        }
    }

    /// Opens System Settings → Privacy & Security → Microphone.
    func openSystemMicrophoneSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            "x-apple.systempreferences:com.apple.Settings.PrivacySecurity.extension?Privacy_Microphone"
        ]
        for string in candidates {
            if let url = URL(string: string), NSWorkspace.shared.open(url) {
                return
            }
        }
    }

    var needsMicrophonePermissionInSettings: Bool {
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
        "Microphone access is blocked. Enable MyPipCam in System Settings → Privacy & Security → Microphone."

    deinit {
        for observer in deviceObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}

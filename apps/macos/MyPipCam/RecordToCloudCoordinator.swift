import AppKit
import Combine
import SwiftUI

/// Orchestrates Record: setup sheet → ScreenCaptureKit capture → library folder save.
@MainActor
final class RecordToCloudCoordinator: ObservableObject {
    static let shared = RecordToCloudCoordinator()

    let recorder = ScreenCloudRecorder()

    @Published private(set) var isSetupPresented = false
    @Published private(set) var isRecording = false
    @Published var lastStatusMessage: String?

    private weak var camera: CameraManager?
    private weak var microphone: MicrophoneManager?
    private weak var settings: BubbleSettings?
    private var setupWindow: NSWindow?
    private var hudWindow: NSWindow?
    private var cancellables = Set<AnyCancellable>()

    private init() {
        recorder.$isRecording
            .receive(on: RunLoop.main)
            .sink { [weak self] recording in
                self?.isRecording = recording
            }
            .store(in: &cancellables)
    }

    func bind(
        camera: CameraManager,
        microphone: MicrophoneManager,
        settings: BubbleSettings
    ) {
        self.camera = camera
        self.microphone = microphone
        self.settings = settings
    }

    func presentSetup() {
        guard let camera, let microphone, let settings else {
            presentAlert(
                title: "Record",
                message: "Camera bubble is not ready yet. Try again in a moment."
            )
            return
        }
        if recorder.isRecording {
            presentAlert(title: "Already Recording", message: "Stop the current recording first.")
            return
        }

        let root = RecordToCloudSetupView(
            camera: camera,
            microphone: microphone,
            settings: settings,
            recorder: recorder,
            onCancel: { [weak self] in self?.dismissSetup() },
            onStart: { [weak self] config in
                await self?.startRecording(config)
            }
        )

        let hosting = NSHostingController(rootView: root)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 560),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Record"
        window.contentViewController = hosting
        window.center()
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        setupWindow = window
        isSetupPresented = true

        Task {
            await microphone.ensureAccess()
            recorder.noteLaunchIdentity()
            _ = recorder.ensureScreenCaptureAccess()
            await recorder.refreshShareableContent()
        }
    }

    func dismissSetup() {
        setupWindow?.close()
        setupWindow = nil
        isSetupPresented = false
    }

    struct StartConfig {
        var target: CloudCaptureTarget
        var displayID: CGDirectDisplayID?
        var windowID: CGWindowID?
        var includeSystemAudio: Bool
        var includeMicrophone: Bool
    }

    private func startRecording(_ config: StartConfig) async {
        guard let settings else { return }

        let store = LibraryFolderStore.shared
        if !store.hasLibrary {
            guard store.ensureDefaultLibrary(settings: settings) || store.chooseFolder(settings: settings) else {
                return
            }
        }

        await microphone?.ensureAccess()
        if camera?.authorizationStatus != .authorized {
            await camera?.requestAccessAndStart()
        }

        dismissSetup()
        try? await Task.sleep(nanoseconds: 350_000_000)

        let micID: String? = {
            guard config.includeMicrophone else { return nil }
            let id = microphone?.selectedDeviceID ?? ""
            return id.isEmpty ? nil : id
        }()

        do {
            showHUD()
            let hudID = hudWindow.map { CGWindowID($0.windowNumber) }
            _ = try await recorder.start(
                target: config.target,
                displayID: config.displayID,
                windowID: config.windowID,
                microphoneDeviceID: micID,
                includeSystemAudio: config.includeSystemAudio,
                excludeWindowIDs: hudID.map { [$0] } ?? []
            )
            lastStatusMessage = nil
        } catch {
            hideHUD()
            let mapped = ScreenCloudRecorderError.mapCaptureError(error)
            if ScreenCloudRecorderError.isScreenCaptureTCCError(mapped) {
                presentScreenRecordingHelp()
            } else {
                presentAlert(title: "Couldn’t Start Recording", message: mapped.localizedDescription)
            }
        }
    }

    func stopRecording() async {
        guard recorder.isRecording else { return }
        hideHUD()

        do {
            let result = try await recorder.stop()
            let title = Self.defaultTitle(for: Date())
            let saved = try LibraryFolderStore.shared.saveNewRecording(
                fromTempVideo: result.url,
                durationMs: result.durationMs,
                title: title,
                settings: settings
            )

            LibraryFolderStore.shared.refresh()
            lastStatusMessage = "Saved “\(saved.title)” to your library."

            let alert = NSAlert()
            alert.messageText = "Recording Saved"
            alert.informativeText = """
            Saved to your MyPipCam library folder (same layout as the Chrome extension).

            Path: \(LibraryFolderStore.shared.displayPath)

            Google Drive upload still runs through the Chrome extension when Connect Google + auto-upload are enabled — open Library in Chrome to sync.
            """
            alert.alertStyle = .informational
            alert.addButton(withTitle: "Open Library")
            alert.addButton(withTitle: "Open in Chrome")
            alert.addButton(withTitle: "Reveal in Finder")
            alert.addButton(withTitle: "OK")
            let response = alert.runModal()
            if let settings {
                switch response {
                case .alertFirstButtonReturn:
                    LibraryWindowPresenter.open(settings: settings, chooseIfNeeded: false)
                case .alertSecondButtonReturn:
                    let override = settings.chromeExtensionId.trimmingCharacters(in: .whitespacesAndNewlines)
                    ExtensionLibraryOpener.openRecordingLibrary(
                        extensionID: override.isEmpty ? nil : override,
                        recordingID: saved.id
                    )
                case .alertThirdButtonReturn:
                    LibraryFolderStore.shared.revealRecordingInFinder(id: saved.id)
                default:
                    break
                }
            }
        } catch {
            presentAlert(title: "Recording Failed", message: error.localizedDescription)
        }
    }

    private static func defaultTitle(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, yyyy h:mm a"
        return "Desktop \(formatter.string(from: date))"
    }

    private func showHUD() {
        hideHUD()

        let root = RecordingHUDView(
            recorder: recorder,
            onStop: { [weak self] in
                Task { await self?.stopRecording() }
            }
        )
        let hosting = NSHostingController(rootView: root)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 220, height: 52),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.contentViewController = hosting
        panel.isReleasedWhenClosed = false

        if let screen = NSScreen.main {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(
                NSPoint(
                    x: visible.midX - 110,
                    y: visible.maxY - 72
                )
            )
        }
        panel.orderFrontRegardless()
        hudWindow = panel
    }

    private func hideHUD() {
        hudWindow?.close()
        hudWindow = nil
    }

    private func presentAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func presentScreenRecordingHelp() {
        // Kick the APIs that can surface a fresh system Allow dialog before we send the user to Settings.
        _ = recorder.ensureScreenCaptureAccess()
        Task { await recorder.refreshShareableContent() }

        let alert = NSAlert()
        alert.messageText = "Screen Recording Permission Needed"
        alert.informativeText = ScreenCloudRecorderError.permissionHelpText
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Open Screen Recording Settings")
        alert.addButton(withTitle: "Quit MyPipCam")
        alert.addButton(withTitle: "Try Again")
        alert.addButton(withTitle: "OK")
        let response = alert.runModal()
        switch response {
        case .alertFirstButtonReturn:
            ScreenCloudRecorder.openScreenRecordingSettings()
        case .alertSecondButtonReturn:
            NSApp.terminate(nil)
        case .alertThirdButtonReturn:
            presentSetup()
        default:
            break
        }
    }
}

struct RecordingHUDView: View {
    @ObservedObject var recorder: ScreenCloudRecorder
    var onStop: () -> Void

    private var timeLabel: String {
        let total = max(0, Int(recorder.elapsedSeconds.rounded()))
        let m = total / 60
        let s = total % 60
        return String(format: "%d:%02d", m, s)
    }

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color(red: 1, green: 0.37, blue: 0.16))
                .frame(width: 10, height: 10)
            Text(timeLabel)
                .font(.system(size: 14, weight: .semibold, design: .monospaced))
                .foregroundStyle(.white)
            Button(action: onStop) {
                Text("Stop")
                    .font(.system(size: 13, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.white.opacity(0.16), in: Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
        .padding(4)
    }
}

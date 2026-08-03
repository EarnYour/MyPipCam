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

        // Mid-session SCStream death used to flip isRecording off with no alert.
        recorder.$fatalSessionError
            .compactMap { $0 }
            .receive(on: RunLoop.main)
            .sink { [weak self] message in
                self?.handleFatalSessionError(message)
            }
            .store(in: &cancellables)
    }

    private func handleFatalSessionError(_ message: String) {
        hideHUD()
        let diag = recorder.lastFailureDiagnostic ?? ""
        recorder.clearFatalSessionError()
        if ScreenCloudRecorderError.isScreenCaptureTCCError(
            ScreenCloudRecorderError.permissionDenied
        ), recorder.needsScreenRecordingPermission {
            presentScreenRecordingHelp(diagnostic: diag)
            return
        }
        if recorder.needsScreenRecordingPermission {
            presentScreenRecordingHelp(diagnostic: diag.isEmpty ? message : diag)
            return
        }
        presentFailureAlert(
            title: "Recording Stopped",
            message: message,
            diagnostic: diag
        )
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
        ensureAlertCanPresent()

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
        guard let settings else {
            presentFailureAlert(
                title: "Couldn’t Start Recording",
                message: "Internal error: settings not bound. Quit & reopen MyPipCam, then try Record again.",
                diagnostic: "settings=nil"
            )
            return
        }

        let store = LibraryFolderStore.shared
        if !store.hasLibrary {
            if !store.ensureDefaultLibrary(settings: settings) {
                if !store.chooseFolder(settings: settings) {
                    presentFailureAlert(
                        title: "Couldn’t Start Recording",
                        message: "Choose a MyPipCam library folder to save recordings, then try again.",
                        diagnostic: "libraryFolder=missing"
                    )
                    return
                }
            }
        }

        await microphone?.ensureAccess()
        if camera?.authorizationStatus != .authorized {
            await camera?.requestAccessAndStart()
        }

        // Keep the setup window until capture actually starts so validation/SCK errors
        // are never lost behind a dismissed sheet + accessory activation policy.
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
            dismissSetup()
            lastStatusMessage = nil
        } catch {
            hideHUD()
            let mapped = ScreenCloudRecorderError.mapCaptureError(error)
            let diag = recorder.lastFailureDiagnostic
                ?? ScreenCloudRecorderError.diagnosticSummary(error)
            NSLog(
                "[MyPipCam] startRecording failed %{public}@",
                diag
            )
            if ScreenCloudRecorderError.isScreenCaptureTCCError(mapped) {
                presentScreenRecordingHelp(diagnostic: diag, underlying: error)
            } else {
                presentFailureAlert(
                    title: "Couldn’t Start Recording",
                    message: mapped.localizedDescription,
                    diagnostic: diag,
                    underlying: error
                )
            }
        }
    }

    func stopRecording() async {
        // Allow salvage when the stream already died but left a temp file.
        guard recorder.isRecording || recorder.errorMessage != nil else { return }
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

            ensureAlertCanPresent()
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
            presentFailureAlert(
                title: "Recording Failed",
                message: error.localizedDescription,
                diagnostic: ScreenCloudRecorderError.diagnosticSummary(error),
                underlying: error
            )
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
            contentRect: NSRect(x: 0, y: 0, width: 280, height: 64),
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
                    x: visible.midX - 140,
                    y: visible.maxY - 80
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

    /// Menu-bar apps suppress modal alerts unless briefly regular + frontmost.
    private func ensureAlertCanPresent() {
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    private func presentAlert(title: String, message: String) {
        ensureAlertCanPresent()
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func presentFailureAlert(
        title: String,
        message: String,
        diagnostic: String,
        underlying: Error? = nil
    ) {
        ensureAlertCanPresent()
        var detail = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let diagLine: String
        if let underlying {
            diagLine = ScreenCloudRecorderError.diagnosticSummary(underlying)
        } else {
            diagLine = diagnostic
        }
        if !diagLine.isEmpty {
            detail += "\n\nTechnical detail: \(diagLine)"
        }
        if !diagnostic.isEmpty, diagnostic != diagLine {
            detail += "\nProbe: \(diagnostic)"
        }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Copy Details")
        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(detail, forType: .string)
        }
    }

    private func presentScreenRecordingHelp(diagnostic: String? = nil, underlying: Error? = nil) {
        let perm = ScreenRecordingPermission.shared
        perm.refresh()
        // Do NOT open Settings before the alert — that hid the dialog and looked like a silent fail.
        perm.startPolling()

        ensureAlertCanPresent()
        let alert = NSAlert()
        let pendingRelaunch = perm.status == .grantedPendingRelaunch
        alert.messageText = pendingRelaunch
            ? "Quit & Relaunch Required"
            : "Screen Recording Permission Needed"
        var body = pendingRelaunch
            ? ScreenCloudRecorderError.relaunchHelpText
            : ScreenCloudRecorderError.permissionHelpText
        let diag = diagnostic
            ?? (underlying.map { ScreenCloudRecorderError.diagnosticSummary($0) })
            ?? recorder.lastFailureDiagnostic
        if let diag, !diag.isEmpty {
            body += "\n\nTechnical detail: \(diag)"
        }
        if let underlying {
            let ns = underlying as NSError
            body += "\nNSError: domain=\(ns.domain) code=\(ns.code) \(ns.localizedDescription)"
        }
        alert.informativeText = body
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit & Relaunch")
        alert.addButton(withTitle: "Open Screen Recording Settings")
        alert.addButton(withTitle: "Try Again")
        alert.addButton(withTitle: "OK")
        let response = alert.runModal()
        perm.stopPolling()
        switch response {
        case .alertFirstButtonReturn:
            perm.relaunch()
        case .alertSecondButtonReturn:
            ScreenCloudRecorder.openScreenRecordingSettings()
        case .alertThirdButtonReturn:
            // Setup sheet may still be open; refresh content and leave it.
            Task {
                _ = recorder.ensureScreenCaptureAccess()
                await recorder.refreshShareableContent()
            }
            if !isSetupPresented {
                presentSetup()
            }
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
        HStack(spacing: 14) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color(red: 1, green: 0.37, blue: 0.16))
                    .frame(width: 10, height: 10)
                Text(timeLabel)
                    .font(.system(size: 15, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.white)
                    .fixedSize()
            }
            Button(action: onStop) {
                Text("Stop")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(Color(red: 1, green: 0.37, blue: 0.16), in: Capsule())
            }
            .buttonStyle(.plain)
            .help("Stop recording and save to library")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            Capsule()
                .fill(Color.black.opacity(0.82))
        )
        .overlay(
            Capsule()
                .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.35), radius: 10, y: 2)
        .padding(4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recording \(timeLabel)")
    }
}

import AppKit
import Combine
import CoreGraphics

/// Manages `kTCCServiceScreenCapture` with the macOS invariant that ScreenCaptureKit
/// does **not** honor a grant in the same process — Quit & Relaunch is required.
///
/// On Darwin 25 / macOS 15+, TCC also logs
/// `Service kTCCServiceScreenCapture does not allow prompting; returning denied`
/// for `CGRequestScreenCaptureAccess()` — there is often **no** system Allow sheet.
/// The user must enable MyPipCam under Screen & System Audio Recording, then relaunch.
@MainActor
final class ScreenRecordingPermission: ObservableObject {
    static let shared = ScreenRecordingPermission()

    enum Status: Equatable {
        case notGranted
        /// Preflight flipped true during this process — SCK still fails until relaunch.
        case grantedPendingRelaunch
        /// Preflight was already true at process start — SCK is safe to call.
        case granted
    }

    @Published private(set) var status: Status
    @Published private(set) var relaunchError: Error?

    var isReadyForCapture: Bool { status == .granted }

    /// Sticky: once we see preflight false in this process, a later true means relaunch needed.
    private var hasObservedFalse: Bool
    private var pollTimer: Timer?

    private init() {
        let initial = CGPreflightScreenCaptureAccess()
        hasObservedFalse = !initial
        status = initial ? .granted : .notGranted
    }

    func refresh() {
        let now = CGPreflightScreenCaptureAccess()
        if now {
            status = hasObservedFalse ? .grantedPendingRelaunch : .granted
        } else {
            hasObservedFalse = true
            status = .notGranted
        }
    }

    /// Registers the app with TCC. Does not make SCK work mid-session.
    /// Callers that need Settings should open it from an explicit button — auto-opening
    /// Settings before an alert made failures look silent on Tahoe.
    func requestPermission(openSettingsIfDenied: Bool = false) {
        prepareFrontmost()
        let granted = CGRequestScreenCaptureAccess()
        refresh()
        if openSettingsIfDenied, !granted || status == .notGranted {
            openSystemSettings()
        }
    }

    func openSystemSettings() {
        ScreenCloudRecorder.openScreenRecordingSettings()
    }

    func startPolling(interval: TimeInterval = 1.0) {
        stopPolling()
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        if let pollTimer {
            RunLoop.main.add(pollTimer, forMode: .common)
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    /// Quit + relaunch so ScreenCaptureKit observes the TCC grant.
    func relaunch() {
        relaunchError = nil
        let bundleURL = Bundle.main.bundleURL
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true

        NSWorkspace.shared.openApplication(at: bundleURL, configuration: configuration) { [weak self] _, error in
            Task { @MainActor in
                if let error {
                    self?.relaunchError = error
                    NSLog(
                        "%@",
                        "[MyPipCam] Screen Recording relaunch failed: \(error.localizedDescription)"
                    )
                    return
                }
                NSApp.terminate(nil)
            }
        }
    }

    private func prepareFrontmost() {
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
        }
        NSApp.activate(ignoringOtherApps: true)
    }
}

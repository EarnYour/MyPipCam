import AVFoundation
import AppKit
import Combine
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import Security

enum CloudCaptureTarget: String, CaseIterable, Identifiable {
    case screen
    case window

    var id: String { rawValue }

    var label: String {
        switch self {
        case .screen: return "Screen"
        case .window: return "Window"
        }
    }
}

struct CapturableDisplay: Identifiable, Hashable {
    let id: CGDirectDisplayID
    let name: String
    let width: Int
    let height: Int
}

struct CapturableWindow: Identifiable, Hashable {
    let id: CGWindowID
    let title: String
    let appName: String
    let width: Int
    let height: Int

    var label: String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return appName }
        return "\(appName) — \(t)"
    }
}

enum ScreenCloudRecorderError: LocalizedError {
    case noDisplay
    case noWindow
    case permissionDenied
    case unsupported
    case alreadyRecording
    case notRecording
    case writerFailed(String)
    case startFailed(String)

    /// User-facing guidance when Screen Recording TCC is missing or stale (common after reinstall).
    /// On Darwin 25, TCC often refuses an Allow sheet (`does not allow prompting`) — Settings + relaunch.
    static let permissionHelpText = """
    macOS blocked display/window capture for this copy of MyPipCam.

    On recent macOS there is often NO “Allow” sheet — only a Settings toggle — and ScreenCaptureKit only works AFTER a full Quit & Relaunch.

    Fix:
    1. Open Screen & System Audio Recording (or Screen Recording) settings
    2. Turn MyPipCam ON (remove any LoomCam / old MyPipCam rows first)
    3. Click Quit & Relaunch below (required — a toggle alone in this session is not enough)
    4. Start Record again from /Applications/MyPipCam.app
    """

    static let relaunchHelpText = """
    Screen Recording was just enabled for MyPipCam, but macOS will not let ScreenCaptureKit use it until the app fully restarts.

    Click Quit & Relaunch, then start Record again.
    """

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "No display available to capture."
        case .noWindow: return "Select a window to capture."
        case .permissionDenied: return Self.permissionHelpText
        case .unsupported: return "That capture mode isn’t available here."
        case .alreadyRecording: return "A recording is already in progress."
        case .notRecording: return "Nothing is recording."
        case .writerFailed(let detail): return detail
        case .startFailed(let detail): return detail
        }
    }

    /// Compact diagnostics for alerts / probe logs (never treat as user-facing alone).
    static func diagnosticSummary(_ error: Error) -> String {
        let ns = error as NSError
        let desc = ns.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return "domain=\(ns.domain) code=\(ns.code) desc=\(desc)"
    }

    /// Known non-screen-TCC SCStream codes that must never be shown as Screen Recording help.
    private static let nonScreenTCCStreamCodes: Set<Int> = [
        SCStreamError.noDisplayList.rawValue, // -3814
        SCStreamError.noWindowList.rawValue, // -3813
        SCStreamError.noCaptureSource.rawValue, // -3815
        SCStreamError.missingEntitlements.rawValue, // -3803
        SCStreamError.failedToStartAudioCapture.rawValue, // -3818
        -3820 // SCStreamErrorFailedToStartMicrophoneCapture (macOS 15+)
    ]

    /// Only true Screen Recording TCC / user-decline — not mic/system-audio/entitlement failures.
    static func isScreenCaptureTCCError(_ error: Error) -> Bool {
        if let err = error as? ScreenCloudRecorderError, case .permissionDenied = err {
            return true
        }
        let ns = error as NSError
        let isStreamDomain =
            ns.domain == SCStreamErrorDomain
            || ns.domain.contains("ScreenCaptureKit")
            || ns.domain.contains("SCStream")

        // Explicit non-TCC stream failures first (mic/audio/entitlements/empty lists).
        if isStreamDomain, nonScreenTCCStreamCodes.contains(ns.code) {
            return false
        }

        // SCStreamErrorUserDeclined = -3801
        if isStreamDomain, ns.code == SCStreamError.userDeclined.rawValue {
            return true
        }

        let blob = "\(ns.localizedDescription) \(ns.localizedFailureReason ?? "")".lowercased()
        // Exact Apple phrasing from SCK when Screen Recording TCC is denied.
        if blob.contains("declined tcc")
            && (blob.contains("display") || blob.contains("window") || blob.contains("application")) {
            return true
        }
        if blob.contains("screen recording")
            && (blob.contains("denied") || blob.contains("not authorized") || blob.contains("permission")) {
            return true
        }
        // Do NOT match bare "tcc"+"capture" — that false-positives microphone/system-audio TCC.
        return false
    }

    static func mapCaptureError(_ error: Error) -> Error {
        let ns = error as NSError
        if ns.domain == SCStreamErrorDomain || ns.domain.contains("ScreenCaptureKit") || ns.domain.contains("SCStream") {
            // Map specific codes before the broad TCC check so mic/audio never become permissionDenied.
            switch ns.code {
            case SCStreamError.noDisplayList.rawValue, SCStreamError.noCaptureSource.rawValue:
                // Empty display list after a denied Screen Recording grant often surfaces as -3814.
                if !CGPreflightScreenCaptureAccess() {
                    return ScreenCloudRecorderError.permissionDenied
                }
                return ScreenCloudRecorderError.noDisplay
            case SCStreamError.noWindowList.rawValue:
                return ScreenCloudRecorderError.noWindow
            case -3820: // SCStreamErrorFailedToStartMicrophoneCapture (macOS 15+)
                return ScreenCloudRecorderError.startFailed(
                    "Microphone capture failed. Grant Microphone access in System Settings, or start again with microphone turned off. (\(diagnosticSummary(error)))"
                )
            case SCStreamError.failedToStartAudioCapture.rawValue:
                return ScreenCloudRecorderError.startFailed(
                    "System audio capture failed. Try again with “Include system audio” turned off. (\(diagnosticSummary(error)))"
                )
            case SCStreamError.missingEntitlements.rawValue:
                return ScreenCloudRecorderError.startFailed(
                    "Capture failed due to missing entitlements. Reinstall MyPipCam with the install script, then try again. (\(diagnosticSummary(error)))"
                )
            default:
                break
            }
        }
        if isScreenCaptureTCCError(error) { return ScreenCloudRecorderError.permissionDenied }
        if ns.domain == SCStreamErrorDomain || ns.domain.contains("ScreenCaptureKit") || ns.domain.contains("SCStream") {
            let detail = ns.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            if !detail.isEmpty {
                return ScreenCloudRecorderError.startFailed("\(detail) (code \(ns.code))")
            }
        }
        return error
    }
}

/// Tracks code-signing identity so we can warn after reinstalls invalidate Screen Recording TCC.
enum ScreenCaptureSigningIdentity {
    private static let defaultsKey = "mypipcam.lastScreenCaptureSigningIdentity"

    /// Stable fingerprint of the running binary (CDHash when available).
    static func current() -> String {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else {
            return fallbackIdentity()
        }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(rawValue: 0), &staticCode) == errSecSuccess,
              let staticCode
        else {
            return fallbackIdentity()
        }
        var infoCF: CFDictionary?
        let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(staticCode, flags, &infoCF) == errSecSuccess,
              let info = infoCF as? [String: Any]
        else {
            return fallbackIdentity()
        }
        if let unique = info[kSecCodeInfoUnique as String] as? Data {
            return unique.base64EncodedString()
        }
        let team = info[kSecCodeInfoTeamIdentifier as String] as? String ?? ""
        return "\(team)|\(Bundle.main.bundlePath)"
    }

    private static func fallbackIdentity() -> String {
        let path = Bundle.main.bundlePath
        let mtime = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)?
            .timeIntervalSince1970 ?? 0
        return "\(path)|\(mtime)"
    }

    /// Returns true when this launch’s binary identity differs from the last recorded one.
    @discardableResult
    static func detectIdentityChange() -> Bool {
        let current = current()
        let previous = UserDefaults.standard.string(forKey: defaultsKey)
        UserDefaults.standard.set(current, forKey: defaultsKey)
        guard let previous, !previous.isEmpty else { return false }
        return previous != current
    }
}

/// Screen / window capture via ScreenCaptureKit → MP4 temp file.
@MainActor
final class ScreenCloudRecorder: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var elapsedSeconds: TimeInterval = 0
    @Published var errorMessage: String?
    /// True when ScreenCaptureKit rejected capture (TCC missing/stale), even if Settings looks enabled.
    @Published private(set) var needsScreenRecordingPermission = false
    /// True after a reinstall / code-signature change until capture succeeds again.
    @Published private(set) var signingIdentityChanged = false
    /// Last underlying NSError summary from a failed SCK call (domain/code/desc).
    @Published private(set) var lastFailureDiagnostic: String?

    @Published private(set) var displays: [CapturableDisplay] = []
    @Published private(set) var windows: [CapturableWindow] = []

    private var stream: SCStream?
    private var recordingOutput: AnyObject?
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var micSession: AVCaptureSession?
    private var writerStarted = false
    private var outputURL: URL?
    private var startedAt: Date?
    private var timer: Timer?
    private let sampleQueue = DispatchQueue(label: "com.mypipcam.desktop-recorder.samples")
    private var excludeWindowIDs: [CGWindowID] = []
    private var restoredActivationPolicy: NSApplication.ActivationPolicy?

    func noteLaunchIdentity() {
        if ScreenCaptureSigningIdentity.detectIdentityChange() {
            signingIdentityChanged = true
            // Preflight can stay true for a stale TCC row; force a real SCK probe later.
            needsScreenRecordingPermission = false
        }
    }

    private func rememberFailure(_ error: Error) {
        let summary = ScreenCloudRecorderError.diagnosticSummary(error)
        lastFailureDiagnostic = summary
        NSLog("[MyPipCam capture] FAIL %{public}@", summary)
    }

    /// Menu-bar (LSUIElement) apps often never get a system Allow sheet unless briefly regular + frontmost.
    private func prepareForScreenCapturePrompt() {
        if restoredActivationPolicy == nil {
            restoredActivationPolicy = NSApp.activationPolicy()
        }
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    private func restoreActivationPolicyIfNeeded() {
        guard let previous = restoredActivationPolicy else { return }
        restoredActivationPolicy = nil
        if previous != .regular {
            NSApp.setActivationPolicy(previous)
        }
    }

    func refreshShareableContent() async {
        _ = ensureScreenCaptureAccess()
        do {
            let content = try await fetchShareableContent()
            displays = content.displays.map { display in
                let name: String
                if let screen = NSScreen.screens.first(where: {
                    ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
                        .uint32Value == display.displayID
                }) {
                    name = screen.localizedName
                } else {
                    name = "Display \(display.displayID)"
                }
                return CapturableDisplay(
                    id: display.displayID,
                    name: name,
                    width: display.width,
                    height: display.height
                )
            }
            windows = content.windows
                .filter { window in
                    guard window.frame.width >= 120, window.frame.height >= 80 else { return false }
                    let app = window.owningApplication?.applicationName ?? ""
                    if app == "MyPipCam" { return false }
                    return window.owningApplication != nil
                }
                .map { window in
                    CapturableWindow(
                        id: window.windowID,
                        title: window.title ?? "",
                        appName: window.owningApplication?.applicationName ?? "App",
                        width: Int(window.frame.width),
                        height: Int(window.frame.height)
                    )
                }
                .sorted { $0.appName.localizedCaseInsensitiveCompare($1.appName) == .orderedAscending }
            errorMessage = nil
            lastFailureDiagnostic = nil
            needsScreenRecordingPermission = false
            signingIdentityChanged = false
        } catch {
            rememberFailure(error)
            let mapped = ScreenCloudRecorderError.mapCaptureError(error)
            if ScreenCloudRecorderError.isScreenCaptureTCCError(mapped) {
                needsScreenRecordingPermission = true
                errorMessage = ScreenCloudRecorderError.permissionHelpText
            } else {
                needsScreenRecordingPermission = false
                errorMessage = mapped.localizedDescription
            }
            displays = []
            windows = []
        }
    }

    /// Best-effort prompt trigger. On modern macOS, `CGRequestScreenCaptureAccess()` often returns
    /// `false` immediately (opens Settings) without waiting — do **not** treat that as a hard deny.
    /// Always follow with `SCShareableContent` / `startCapture`, which are what surface the real Allow dialog.
    @discardableResult
    func ensureScreenCaptureAccess() -> Bool {
        prepareForScreenCapturePrompt()
        if CGPreflightScreenCaptureAccess() { return true }
        // Fire the legacy request so Settings can list this app; ignore the boolean gate.
        _ = CGRequestScreenCaptureAccess()
        return CGPreflightScreenCaptureAccess()
    }

    /// True only after a successful SCShareableContent fetch in this session.
    var hasVerifiedScreenCaptureAccess: Bool {
        !needsScreenRecordingPermission && (!displays.isEmpty || errorMessage == nil)
    }

    /// Diagnostic entry point for `--probe-screencapture` (writes Application Support + unified log).
    static func runLaunchProbe() async {
        let bundlePath = Bundle.main.bundlePath
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        // Become regular so TCC can show a sheet for this UIElement app.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        func writeProbe(_ lines: [String]) {
            let text = lines.joined(separator: "\n") + "\n"
            if let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
                let folder = dir.appendingPathComponent("MyPipCam", isDirectory: true)
                try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let url = folder.appendingPathComponent("screencapture-probe.txt")
                try? text.write(to: url, atomically: true, encoding: .utf8)
                NSLog("[MyPipCam probe] wrote %{public}@", url.path)
            }
            // Also dump to sandbox tmp for agents that cannot read the container AS folder.
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("mypipcam-screencapture-probe.txt")
            try? text.write(to: tmp, atomically: true, encoding: .utf8)
            NSLog("[MyPipCam probe] tmp=%{public}@", tmp.path)
        }

        let pre1 = CGPreflightScreenCaptureAccess()
        writeProbe([
            "bundlePath=\(bundlePath)",
            "version=\(version) (\(build))",
            "preflightBefore=\(pre1)",
            "result=REQUESTING"
        ])
        _ = CGRequestScreenCaptureAccess()
        let pre2 = CGPreflightScreenCaptureAccess()
        writeProbe([
            "bundlePath=\(bundlePath)",
            "version=\(version) (\(build))",
            "preflightBefore=\(pre1)",
            "preflightAfterRequest=\(pre2)",
            "result=WAITING_SHAREABLE_CONTENT"
        ])
        NSLog(
            "[MyPipCam probe] path=%{public}@ v=%{public}@ preflight before=%{public}@ afterRequest=%{public}@",
            bundlePath,
            "\(version)(\(build))",
            "\(pre1)",
            "\(pre2)"
        )
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            writeProbe([
                "bundlePath=\(bundlePath)",
                "version=\(version) (\(build))",
                "preflightBefore=\(pre1)",
                "preflightAfterRequest=\(pre2)",
                "result=OK",
                "displays=\(content.displays.count)",
                "windows=\(content.windows.count)"
            ])
            NSLog(
                "[MyPipCam probe] SCShareableContent OK displays=%d windows=%d",
                content.displays.count,
                content.windows.count
            )
        } catch {
            let ns = error as NSError
            writeProbe([
                "bundlePath=\(bundlePath)",
                "version=\(version) (\(build))",
                "preflightBefore=\(pre1)",
                "preflightAfterRequest=\(pre2)",
                "result=FAIL",
                "domain=\(ns.domain)",
                "code=\(ns.code)",
                "desc=\(ns.localizedDescription)"
            ])
            NSLog(
                "[MyPipCam probe] SCShareableContent FAILED domain=%{public}@ code=%d desc=%{public}@",
                ns.domain,
                ns.code,
                ns.localizedDescription
            )
            if let data = "[MyPipCam probe] FAIL domain=\(ns.domain) code=\(ns.code) desc=\(ns.localizedDescription)\n"
                .data(using: .utf8) {
                FileHandle.standardError.write(data)
            }
        }
    }

    static func openScreenRecordingSettings() {
        // macOS 15+ / Darwin 25: “Screen & System Audio Recording”; older: “Screen Recording”.
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            "x-apple.systempreferences:com.apple.Settings.PrivacySecurity.extension?Privacy_ScreenCapture",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        ]
        for string in candidates {
            if let url = URL(string: string), NSWorkspace.shared.open(url) { return }
        }
    }

    private func fetchShareableContent() async throws -> SCShareableContent {
        prepareForScreenCapturePrompt()
        do {
            return try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
        } catch {
            rememberFailure(error)
            throw ScreenCloudRecorderError.mapCaptureError(error)
        }
    }

    func start(
        target: CloudCaptureTarget,
        displayID: CGDirectDisplayID?,
        windowID: CGWindowID?,
        microphoneDeviceID: String?,
        includeSystemAudio: Bool,
        excludeWindowIDs: [CGWindowID]
    ) async throws -> URL {
        guard !isRecording else { throw ScreenCloudRecorderError.alreadyRecording }

        // Gate on relaunch-aware TCC state. Calling SCK while not ready yields -3801 / “declined TCCs”.
        let perm = ScreenRecordingPermission.shared
        perm.refresh()
        switch perm.status {
        case .granted:
            break
        case .grantedPendingRelaunch:
            needsScreenRecordingPermission = true
            lastFailureDiagnostic = "preflight=true pendingRelaunch=true (SCK needs new process)"
            throw ScreenCloudRecorderError.permissionDenied
        case .notGranted:
            _ = ensureScreenCaptureAccess()
            perm.requestPermission()
            perm.refresh()
            if perm.status != .granted {
                needsScreenRecordingPermission = true
                lastFailureDiagnostic =
                    "preflight=\(CGPreflightScreenCaptureAccess()) status=\(String(describing: perm.status)) (TCC ScreenCapture does not allow in-app prompting on this OS)"
                throw ScreenCloudRecorderError.permissionDenied
            }
        }

        self.excludeWindowIDs = excludeWindowIDs

        let content: SCShareableContent
        do {
            content = try await fetchShareableContent()
            needsScreenRecordingPermission = false
            signingIdentityChanged = false
            lastFailureDiagnostic = nil
        } catch {
            let mapped = ScreenCloudRecorderError.mapCaptureError(error)
            if ScreenCloudRecorderError.isScreenCaptureTCCError(mapped) {
                needsScreenRecordingPermission = true
                ScreenRecordingPermission.shared.requestPermission()
                throw ScreenCloudRecorderError.permissionDenied
            }
            throw mapped
        }

        let filter: SCContentFilter
        let width: Int
        let height: Int

        switch target {
        case .screen:
            guard
                let display = content.displays.first(where: { $0.displayID == displayID })
                    ?? content.displays.first
            else { throw ScreenCloudRecorderError.noDisplay }

            // Re-include floating PiP bubble: exclude our app, then except bubble windows
            // (recording HUD / setup windows stay out via excludeWindowIDs).
            let ourBundle = Bundle.main.bundleIdentifier
            let ourApps = content.applications.filter { $0.bundleIdentifier == ourBundle }
            let bubbleWindows = content.windows.filter { window in
                window.owningApplication?.bundleIdentifier == ourBundle
                    && !excludeWindowIDs.contains(window.windowID)
            }
            if !ourApps.isEmpty {
                filter = SCContentFilter(
                    display: display,
                    excludingApplications: ourApps,
                    exceptingWindows: bubbleWindows
                )
            } else {
                let excluded = content.windows.filter { excludeWindowIDs.contains($0.windowID) }
                filter = SCContentFilter(display: display, excludingWindows: excluded)
            }
            width = min(max(2, display.width * 2), 3840)
            height = min(max(2, display.height * 2), 2160)
        case .window:
            guard let windowID,
                  let window = content.windows.first(where: { $0.windowID == windowID })
            else { throw ScreenCloudRecorderError.noWindow }
            filter = SCContentFilter(desktopIndependentWindow: window)
            width = max(2, Int(window.frame.width) & ~1)
            height = max(2, Int(window.frame.height) & ~1)
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mypipcam-desktop-\(UUID().uuidString).mp4")
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: url)
        }
        outputURL = url

        do {
            try await startCaptureWithFallback(
                filter: filter,
                width: width,
                height: height,
                outputURL: url,
                microphoneDeviceID: microphoneDeviceID,
                includeSystemAudio: includeSystemAudio
            )
        } catch {
            rememberFailure(error)
            let mapped = ScreenCloudRecorderError.mapCaptureError(error)
            if ScreenCloudRecorderError.isScreenCaptureTCCError(mapped) {
                needsScreenRecordingPermission = true
                prepareForScreenCapturePrompt()
                _ = CGRequestScreenCaptureAccess()
                throw ScreenCloudRecorderError.permissionDenied
            }
            throw mapped
        }

        // Capture is running — return to menu-bar style so we don't leave a Dock icon up.
        restoreActivationPolicyIfNeeded()

        startedAt = Date()
        elapsedSeconds = 0
        isRecording = true
        errorMessage = nil
        lastFailureDiagnostic = nil
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let startedAt = self.startedAt else { return }
                self.elapsedSeconds = Date().timeIntervalSince(startedAt)
            }
        }
        if let timer {
            RunLoop.main.add(timer, forMode: .common)
        }
        return url
    }

    func stop() async throws -> (url: URL, durationMs: Double) {
        guard isRecording else { throw ScreenCloudRecorderError.notRecording }
        timer?.invalidate()
        timer = nil

        let durationMs = max(0, elapsedSeconds * 1000)
        let url = outputURL

        if #available(macOS 15.0, *), recordingOutput != nil {
            try await stream?.stopCapture()
            stream = nil
            recordingOutput = nil
        } else {
            try await stream?.stopCapture()
            stream = nil
            await finishAssetWriter()
            stopMicSession()
        }

        isRecording = false
        startedAt = nil

        guard let url, FileManager.default.fileExists(atPath: url.path) else {
            throw ScreenCloudRecorderError.writerFailed("Recording file was not written.")
        }
        return (url, durationMs)
    }

    func cancel() async {
        timer?.invalidate()
        timer = nil
        try? await stream?.stopCapture()
        stream = nil
        recordingOutput = nil
        await finishAssetWriter()
        stopMicSession()
        if let outputURL {
            try? FileManager.default.removeItem(at: outputURL)
        }
        outputURL = nil
        isRecording = false
        startedAt = nil
        elapsedSeconds = 0
    }

    /// Prefer SCRecordingOutput on macOS 15+, but fall back to AVAssetWriter (and strip audio) on failure
    /// so mic/system-audio errors are not misreported as Screen Recording TCC.
    private func startCaptureWithFallback(
        filter: SCContentFilter,
        width: Int,
        height: Int,
        outputURL: URL,
        microphoneDeviceID: String?,
        includeSystemAudio: Bool
    ) async throws {
        var lastError: Error?

        if #available(macOS 15.0, *) {
            do {
                try await startWithRecordingOutput(
                    filter: filter,
                    width: width,
                    height: height,
                    outputURL: outputURL,
                    microphoneDeviceID: microphoneDeviceID,
                    includeSystemAudio: includeSystemAudio
                )
                return
            } catch {
                lastError = error
                await cancelPartialStart()
                if ScreenCloudRecorderError.isScreenCaptureTCCError(error) { throw error }
                NSLog(
                    "[MyPipCam] SCRecordingOutput start failed (%@) — trying asset writer",
                    String(describing: error)
                )
            }
        }

        do {
            try await startWithAssetWriter(
                filter: filter,
                width: width,
                height: height,
                outputURL: outputURL,
                microphoneDeviceID: microphoneDeviceID,
                includeSystemAudio: includeSystemAudio
            )
            return
        } catch {
            lastError = error
            await cancelPartialStart()
            if ScreenCloudRecorderError.isScreenCaptureTCCError(error) { throw error }
        }

        // Last resort: video-only (no mic / system audio).
        if microphoneDeviceID != nil || includeSystemAudio {
            try await startWithAssetWriter(
                filter: filter,
                width: width,
                height: height,
                outputURL: outputURL,
                microphoneDeviceID: nil,
                includeSystemAudio: false
            )
            errorMessage = "Recording without microphone/system audio (capture audio failed)."
            return
        }

        throw lastError ?? ScreenCloudRecorderError.startFailed("Could not start capture.")
    }

    private func cancelPartialStart() async {
        try? await stream?.stopCapture()
        stream = nil
        recordingOutput = nil
        await finishAssetWriter()
        stopMicSession()
    }

    @available(macOS 15.0, *)
    private func startWithRecordingOutput(
        filter: SCContentFilter,
        width: Int,
        height: Int,
        outputURL: URL,
        microphoneDeviceID: String?,
        includeSystemAudio: Bool
    ) async throws {
        // Ensure parent directory exists and is writable (sandbox container temp).
        let dir = outputURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.capturesAudio = includeSystemAudio
        config.captureMicrophone = microphoneDeviceID != nil
        if let microphoneDeviceID, !microphoneDeviceID.isEmpty {
            config.microphoneCaptureDeviceID = microphoneDeviceID
        }
        config.showsCursor = true
        config.queueDepth = 8
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.pixelFormat = kCVPixelFormatType_32BGRA

        let recordingConfig = SCRecordingOutputConfiguration()
        recordingConfig.outputURL = outputURL
        recordingConfig.outputFileType = .mp4
        // Prefer H.264 for broader sandbox / player compatibility; HEVC can fail to finalize.
        if recordingConfig.availableVideoCodecTypes.contains(.h264) {
            recordingConfig.videoCodecType = .h264
        } else if recordingConfig.availableVideoCodecTypes.contains(.hevc) {
            recordingConfig.videoCodecType = .hevc
        } else if let first = recordingConfig.availableVideoCodecTypes.first {
            recordingConfig.videoCodecType = first
        }

        let output = SCRecordingOutput(configuration: recordingConfig, delegate: self)
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addRecordingOutput(output)
        try await stream.startCapture()
        self.stream = stream
        self.recordingOutput = output
    }

    private func startWithAssetWriter(
        filter: SCContentFilter,
        width: Int,
        height: Int,
        outputURL: URL,
        microphoneDeviceID: String?,
        includeSystemAudio: Bool
    ) async throws {
        let useMic = microphoneDeviceID != nil
        let useSystemAudio = includeSystemAudio && !useMic

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.capturesAudio = useSystemAudio
        config.showsCursor = true
        config.queueDepth = 8
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.pixelFormat = kCVPixelFormatType_32BGRA

        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 8_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
            ]
        ]
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        video.expectsMediaDataInRealTime = true
        guard writer.canAdd(video) else {
            throw ScreenCloudRecorderError.writerFailed("Cannot add video track.")
        }
        writer.add(video)

        var audio: AVAssetWriterInput?
        if useSystemAudio || useMic {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 2,
                AVSampleRateKey: 48_000,
                AVEncoderBitRateKey: 160_000
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            input.expectsMediaDataInRealTime = true
            if writer.canAdd(input) {
                writer.add(input)
                audio = input
            }
        }

        guard writer.startWriting() else {
            throw ScreenCloudRecorderError.writerFailed(
                writer.error?.localizedDescription ?? "Could not start writer."
            )
        }

        assetWriter = writer
        videoInput = video
        audioInput = audio
        writerStarted = false

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        if useSystemAudio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        }
        try await stream.startCapture()
        self.stream = stream

        if let microphoneDeviceID, useMic {
            try startMicSession(deviceID: microphoneDeviceID)
        }
    }

    private func startMicSession(deviceID: String) throws {
        let session = AVCaptureSession()
        session.beginConfiguration()
        guard
            let device = AVCaptureDevice(uniqueID: deviceID) ?? AVCaptureDevice.default(for: .audio),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            session.commitConfiguration()
            throw ScreenCloudRecorderError.startFailed("Could not open the selected microphone.")
        }
        session.addInput(input)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: sampleQueue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw ScreenCloudRecorderError.startFailed("Could not attach microphone output.")
        }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
        micSession = session
    }

    private func stopMicSession() {
        micSession?.stopRunning()
        micSession = nil
    }

    private func finishAssetWriter() async {
        let writer = assetWriter
        let video = videoInput
        let audio = audioInput
        assetWriter = nil
        videoInput = nil
        audioInput = nil
        writerStarted = false

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            sampleQueue.async {
                video?.markAsFinished()
                audio?.markAsFinished()
                guard let writer else {
                    continuation.resume()
                    return
                }
                writer.finishWriting { continuation.resume() }
            }
        }
    }

    private func appendSample(_ sampleBuffer: CMSampleBuffer, isVideo: Bool) {
        guard let writer = assetWriter else { return }
        if !writerStarted {
            guard isVideo else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: pts)
            writerStarted = true
        }
        if isVideo {
            guard let videoInput, videoInput.isReadyForMoreMediaData else { return }
            videoInput.append(sampleBuffer)
        } else {
            guard let audioInput, audioInput.isReadyForMoreMediaData else { return }
            audioInput.append(sampleBuffer)
        }
    }
}

extension ScreenCloudRecorder: SCStreamDelegate {
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            self.rememberFailure(error)
            let mapped = ScreenCloudRecorderError.mapCaptureError(error)
            if ScreenCloudRecorderError.isScreenCaptureTCCError(mapped) {
                self.needsScreenRecordingPermission = true
                self.errorMessage = ScreenCloudRecorderError.permissionHelpText
            } else {
                self.errorMessage = mapped.localizedDescription
            }
            self.isRecording = false
            self.stream = nil
            self.recordingOutput = nil
        }
    }
}

extension ScreenCloudRecorder: SCStreamOutput {
    nonisolated func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        switch type {
        case .screen:
            Task { @MainActor in self.appendSample(sampleBuffer, isVideo: true) }
        case .audio, .microphone:
            Task { @MainActor in self.appendSample(sampleBuffer, isVideo: false) }
        @unknown default:
            break
        }
    }
}

extension ScreenCloudRecorder: AVCaptureAudioDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        Task { @MainActor in self.appendSample(sampleBuffer, isVideo: false) }
    }
}

@available(macOS 15.0, *)
extension ScreenCloudRecorder: SCRecordingOutputDelegate {
    nonisolated func recordingOutput(
        _ recordingOutput: SCRecordingOutput,
        didFailWithError error: Error
    ) {
        Task { @MainActor in
            self.errorMessage = error.localizedDescription
        }
    }
}

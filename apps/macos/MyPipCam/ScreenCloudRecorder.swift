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

    /// Mic / system-audio SCStream failures — safe to retry video-only.
    static func isAudioCaptureError(_ error: Error) -> Bool {
        if let err = error as? ScreenCloudRecorderError {
            switch err {
            case .startFailed(let detail):
                let lower = detail.lowercased()
                return lower.contains("microphone") || lower.contains("system audio")
                    || lower.contains("audio capture")
            default:
                break
            }
        }
        let ns = error as NSError
        if ns.domain == SCStreamErrorDomain || ns.domain.contains("SCStream")
            || ns.domain.contains("ScreenCaptureKit")
        {
            if ns.code == SCStreamError.failedToStartAudioCapture.rawValue { return true }
            if ns.code == -3820 { return true } // FailedToStartMicrophoneCapture
        }
        let blob = "\(ns.localizedDescription) \(ns.localizedFailureReason ?? "")".lowercased()
        if blob.contains("microphone") && (blob.contains("fail") || blob.contains("tcc") || blob.contains("denied")) {
            return true
        }
        if blob.contains("audio")
            && (blob.contains("fail") || blob.contains("unable") || blob.contains("denied") || blob.contains("tcc"))
            && !blob.contains("screen recording")
        {
            return true
        }
        return false
    }

    /// Only true Screen Recording TCC / user-decline — not mic/system-audio/entitlement failures.
    /// Prefer exact SCStream codes; string matching is a last resort.
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

        // SCStreamErrorUserDeclined = -3801 — the only reliable TCC signal from SCK.
        if isStreamDomain, ns.code == SCStreamError.userDeclined.rawValue {
            return true
        }

        let blob = "\(ns.localizedDescription) \(ns.localizedFailureReason ?? "")".lowercased()
        // Exact Apple phrasing from SCK when Screen Recording TCC is denied.
        if blob.contains("declined tcc")
            && (blob.contains("display") || blob.contains("window") || blob.contains("application")) {
            return true
        }
        // Do NOT match broad "screen recording" / "permission" strings — that hid real errors.
        return false
    }

    static func mapCaptureError(_ error: Error) -> Error {
        let ns = error as NSError
        if ns.domain == SCStreamErrorDomain || ns.domain.contains("ScreenCaptureKit") || ns.domain.contains("SCStream") {
            // Map specific codes before the broad TCC check so mic/audio never become permissionDenied.
            switch ns.code {
            case SCStreamError.noDisplayList.rawValue, SCStreamError.noCaptureSource.rawValue:
                // Keep the real code visible. Only -3801 is treated as Screen Recording TCC help.
                return ScreenCloudRecorderError.startFailed(
                    "No capture display available. If Screen Recording is off for MyPipCam, enable it in System Settings, Quit & Relaunch, then try again. (\(diagnosticSummary(error)))"
                )
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

/// Arguments needed to rebuild an SCContentFilter after a mid-session stream failure.
private struct RestartableCapture {
    var target: CloudCaptureTarget
    var displayID: CGDirectDisplayID?
    var windowID: CGWindowID?
    var microphoneDeviceID: String?
    var includeSystemAudio: Bool
    var excludeWindowIDs: [CGWindowID]
}

/// AVAssetWriter owned on the capture sample queue — never hop samples to MainActor
/// (that raced `finishWriting` and deleted the MP4 before any frame was appended).
private final class CaptureWriterSession: @unchecked Sendable {
    let outputURL: URL
    private let queue: DispatchQueue
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    private var sessionStarted = false
    private(set) var videoFrameCount = 0

    init(
        outputURL: URL,
        width: Int,
        height: Int,
        includeAudio: Bool,
        queue: DispatchQueue
    ) throws {
        self.outputURL = outputURL
        self.queue = queue

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
        if includeAudio {
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

        self.writer = writer
        self.videoInput = video
        self.audioInput = audio
    }

    /// Must be called on `queue` (SCStream sample handler queue).
    func append(_ sampleBuffer: CMSampleBuffer, isVideo: Bool) {
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        if isVideo {
            // Skip idle/blank/suspended SCK frames — only `.complete` is writable.
            guard Self.isCompleteScreenFrame(sampleBuffer) else { return }
        }
        if !sessionStarted {
            guard isVideo else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: pts)
            sessionStarted = true
        }
        if isVideo {
            guard videoInput.isReadyForMoreMediaData else { return }
            if videoInput.append(sampleBuffer) {
                videoFrameCount += 1
            }
        } else {
            guard let audioInput, audioInput.isReadyForMoreMediaData else { return }
            _ = audioInput.append(sampleBuffer)
        }
    }

    private static func isCompleteScreenFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: raw)
        else {
            // No SCK attachments — treat as a normal buffer (mic / non-SCK).
            return true
        }
        return status == .complete
    }

    func finish() async -> Result<URL, Error> {
        await withCheckedContinuation { continuation in
            queue.async {
                self.videoInput.markAsFinished()
                self.audioInput?.markAsFinished()
                if !self.sessionStarted || self.videoFrameCount == 0 {
                    self.writer.cancelWriting()
                    continuation.resume(
                        returning: .failure(
                            ScreenCloudRecorderError.writerFailed(
                                "No video frames were captured. Check Screen Recording permission, then Quit & Relaunch and try again."
                            )
                        )
                    )
                    return
                }
                self.writer.finishWriting {
                    if self.writer.status == .completed,
                       FileManager.default.fileExists(atPath: self.outputURL.path)
                    {
                        continuation.resume(returning: .success(self.outputURL))
                    } else {
                        let detail = self.writer.error?.localizedDescription
                            ?? "Writer status \(self.writer.status.rawValue)"
                        continuation.resume(
                            returning: .failure(
                                ScreenCloudRecorderError.writerFailed(
                                    "Could not finalize recording: \(detail)"
                                )
                            )
                        )
                    }
                }
            }
        }
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
    /// Set when a running session dies and could not be recovered — coordinator must show an alert.
    @Published private(set) var fatalSessionError: String?

    @Published private(set) var displays: [CapturableDisplay] = []
    @Published private(set) var windows: [CapturableWindow] = []

    private var stream: SCStream?
    private var recordingOutput: AnyObject?
    /// Thread-safe writer; accessed from sample queue + MainActor stop path.
    nonisolated(unsafe) private var writerSession: CaptureWriterSession?
    private var micSession: AVCaptureSession?
    private var outputURL: URL?
    private var startedAt: Date?
    private var timer: Timer?
    private let sampleQueue = DispatchQueue(label: "com.mypipcam.desktop-recorder.samples")
    private var excludeWindowIDs: [CGWindowID] = []
    private var restoredActivationPolicy: NSApplication.ActivationPolicy?
    private var restartParams: RestartableCapture?
    private var didFallbackToVideoOnly = false
    private var isHandlingStreamStop = false
    private var recordingFinishContinuation: CheckedContinuation<Result<URL, Error>, Never>?
    private var usesRecordingOutput = false

    /// Clears a presented fatal-session alert after the UI has shown it.
    func clearFatalSessionError() {
        fatalSessionError = nil
    }

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
        NSLog("%@", "[MyPipCam capture] FAIL \(summary)")
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
                NSLog("%@", "[MyPipCam probe] wrote \(url.path)")
            }
            // Also dump to sandbox tmp for agents that cannot read the container AS folder.
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("mypipcam-screencapture-probe.txt")
            try? text.write(to: tmp, atomically: true, encoding: .utf8)
            NSLog("%@", "[MyPipCam probe] tmp=\(tmp.path)")
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
            "%@",
            "[MyPipCam probe] path=\(bundlePath) v=\(version)(\(build)) preflight before=\(pre1) afterRequest=\(pre2)"
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
                "%@",
                "[MyPipCam probe] SCShareableContent OK displays=\(content.displays.count) windows=\(content.windows.count)"
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
                "%@",
                "[MyPipCam probe] SCShareableContent FAILED domain=\(ns.domain) code=\(ns.code) desc=\(ns.localizedDescription)"
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

        // Never gate on CGPreflight / relaunch heuristics — those false-positive on Tahoe
        // (Settings ON + no Allow sheet) and block before ScreenCaptureKit runs.
        // Always attempt SCShareableContent; only treat real SCK TCC errors as permissionDenied.
        _ = ensureScreenCaptureAccess()
        ScreenRecordingPermission.shared.refresh()

        self.excludeWindowIDs = excludeWindowIDs
        fatalSessionError = nil
        didFallbackToVideoOnly = false
        restartParams = RestartableCapture(
            target: target,
            displayID: displayID,
            windowID: windowID,
            microphoneDeviceID: microphoneDeviceID,
            includeSystemAudio: includeSystemAudio,
            excludeWindowIDs: excludeWindowIDs
        )

        let content: SCShareableContent
        do {
            content = try await fetchShareableContent()
            needsScreenRecordingPermission = false
            signingIdentityChanged = false
            lastFailureDiagnostic = nil
            ScreenRecordingPermission.shared.refresh()
        } catch {
            let mapped = ScreenCloudRecorderError.mapCaptureError(error)
            rememberFailure(error)
            if ScreenCloudRecorderError.isScreenCaptureTCCError(mapped) {
                needsScreenRecordingPermission = true
                throw ScreenCloudRecorderError.permissionDenied
            }
            // Preserve the real SCK/NSError for the UI — never swallow into a silent path.
            throw mapped
        }

        let built = try makeFilter(
            target: target,
            displayID: displayID,
            windowID: windowID,
            content: content
        )

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mypipcam-desktop-\(UUID().uuidString).mp4")
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: url)
        }
        outputURL = url

        do {
            try await startCaptureWithFallback(
                filter: built.filter,
                width: built.width,
                height: built.height,
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
        // Preserve soft warning from startCaptureWithFallback (video-only audio fallback).
        lastFailureDiagnostic = nil
        beginElapsedTimer()
        return url
    }

    func stop() async throws -> (url: URL, durationMs: Double) {
        // Allow stop after a stream error left a partial file (isRecording may already be false).
        guard isRecording || outputURL != nil || writerSession != nil else {
            throw ScreenCloudRecorderError.notRecording
        }
        timer?.invalidate()
        timer = nil

        let durationMs = max(0, elapsedSeconds * 1000)
        isHandlingStreamStop = true
        defer { isHandlingStreamStop = false }

        let finalizedURL: URL
        if usesRecordingOutput, #available(macOS 15.0, *) {
            finalizedURL = try await stopRecordingOutputSession()
        } else {
            finalizedURL = try await stopAssetWriterSession()
        }

        isRecording = false
        startedAt = nil
        restartParams = nil
        usesRecordingOutput = false
        outputURL = finalizedURL

        let attrs = try? FileManager.default.attributesOfItem(atPath: finalizedURL.path)
        let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
        guard size > 0 else {
            throw ScreenCloudRecorderError.writerFailed(
                "Recording file was empty (capture never produced frames). Path: \(finalizedURL.path)"
            )
        }
        NSLog(
            "%@",
            "[MyPipCam] stop OK path=\(finalizedURL.path) bytes=\(size) durationMs=\(Int(durationMs.rounded()))"
        )
        return (finalizedURL, durationMs)
    }

    func cancel() async {
        isHandlingStreamStop = true
        defer { isHandlingStreamStop = false }
        timer?.invalidate()
        timer = nil
        if usesRecordingOutput, #available(macOS 15.0, *),
           let output = recordingOutput as? SCRecordingOutput,
           let stream
        {
            try? stream.removeRecordingOutput(output)
        }
        try? await stream?.stopCapture()
        stream = nil
        recordingOutput = nil
        if let session = writerSession {
            writerSession = nil
            _ = await session.finish()
        }
        stopMicSession()
        if let outputURL {
            try? FileManager.default.removeItem(at: outputURL)
        }
        outputURL = nil
        isRecording = false
        startedAt = nil
        elapsedSeconds = 0
        restartParams = nil
        didFallbackToVideoOnly = false
        usesRecordingOutput = false
        if let cont = recordingFinishContinuation {
            recordingFinishContinuation = nil
            cont.resume(returning: .failure(ScreenCloudRecorderError.notRecording))
        }
    }

    private func stopAssetWriterSession() async throws -> URL {
        try? await stream?.stopCapture()
        stream = nil
        recordingOutput = nil
        stopMicSession()
        guard let session = writerSession else {
            let path = outputURL?.path ?? "(nil)"
            throw ScreenCloudRecorderError.writerFailed(
                "Recording file was not written. No writer session (path \(path))."
            )
        }
        writerSession = nil
        switch await session.finish() {
        case .success(let url):
            return url
        case .failure(let error):
            throw error
        }
    }

    @available(macOS 15.0, *)
    private func stopRecordingOutputSession() async throws -> URL {
        let expected = outputURL
        guard let stream, let output = recordingOutput as? SCRecordingOutput else {
            // Stream may already be gone — check if a file was left behind.
            if let expected, FileManager.default.fileExists(atPath: expected.path) {
                return expected
            }
            throw ScreenCloudRecorderError.writerFailed(
                "Recording file was not written. Capture ended before the file was finalized."
            )
        }

        let result: Result<URL, Error> = await withCheckedContinuation { continuation in
            self.recordingFinishContinuation = continuation
            do {
                // Required to flush/finalize the MP4 — stopCapture alone often leaves no file.
                try stream.removeRecordingOutput(output)
            } catch {
                NSLog("%@", "[MyPipCam] removeRecordingOutput: \(error.localizedDescription)")
            }
            Task { @MainActor in
                try? await stream.stopCapture()
                // If delegate never fires, don't hang Stop forever.
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                if let cont = self.recordingFinishContinuation {
                    self.recordingFinishContinuation = nil
                    if let expected, FileManager.default.fileExists(atPath: expected.path) {
                        cont.resume(returning: .success(expected))
                    } else {
                        cont.resume(
                            returning: .failure(
                                ScreenCloudRecorderError.writerFailed(
                                    "Recording file was not written after stop. Path: \(expected?.path ?? "nil")"
                                )
                            )
                        )
                    }
                }
            }
        }

        self.stream = nil
        self.recordingOutput = nil
        switch result {
        case .success(let url):
            return url
        case .failure(let error):
            throw error
        }
    }

    private func beginElapsedTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let startedAt = self.startedAt else { return }
                self.elapsedSeconds = Date().timeIntervalSince(startedAt)
            }
        }
        if let timer {
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    private func makeFilter(
        target: CloudCaptureTarget,
        displayID: CGDirectDisplayID?,
        windowID: CGWindowID?,
        content: SCShareableContent
    ) throws -> (filter: SCContentFilter, width: Int, height: Int) {
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
            let filter: SCContentFilter
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
            let width = min(max(2, display.width * 2), 3840)
            let height = min(max(2, display.height * 2), 2160)
            return (filter, width, height)
        case .window:
            guard let windowID,
                  let window = content.windows.first(where: { $0.windowID == windowID })
            else { throw ScreenCloudRecorderError.noWindow }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let width = max(2, Int(window.frame.width) & ~1)
            let height = max(2, Int(window.frame.height) & ~1)
            return (filter, width, height)
        }
    }

    /// Prefer AVAssetWriter (reliable sandbox MP4). SCRecordingOutput is last resort — it often
    /// starts successfully then leaves no file on stop unless `removeRecordingOutput` runs.
    private func startCaptureWithFallback(
        filter: SCContentFilter,
        width: Int,
        height: Int,
        outputURL: URL,
        microphoneDeviceID: String?,
        includeSystemAudio: Bool
    ) async throws {
        var lastError: Error?
        let wantsAudio = microphoneDeviceID != nil || includeSystemAudio

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
            NSLog(
                "%@",
                "[MyPipCam] AVAssetWriter start failed (\(error)) — trying video-only / SCRecordingOutput"
            )
        }

        // Video-only asset writer if audio killed the session.
        if wantsAudio {
            do {
                try await startWithAssetWriter(
                    filter: filter,
                    width: width,
                    height: height,
                    outputURL: outputURL,
                    microphoneDeviceID: nil,
                    includeSystemAudio: false
                )
                didFallbackToVideoOnly = true
                errorMessage = "Recording without microphone/system audio (capture audio failed)."
                return
            } catch {
                lastError = error
                await cancelPartialStart()
                if ScreenCloudRecorderError.isScreenCaptureTCCError(error) { throw error }
            }
        }

        if #available(macOS 15.0, *) {
            // Fresh URL — SCRecordingOutput rejects reusing a path AVAssetWriter already opened.
            let sckURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("mypipcam-desktop-\(UUID().uuidString).mp4")
            self.outputURL = sckURL
            do {
                try await startWithRecordingOutput(
                    filter: filter,
                    width: width,
                    height: height,
                    outputURL: sckURL,
                    microphoneDeviceID: nil,
                    includeSystemAudio: false
                )
                if wantsAudio {
                    didFallbackToVideoOnly = true
                    errorMessage =
                        "Recording without microphone/system audio (capture audio failed)."
                }
                return
            } catch {
                lastError = error
                await cancelPartialStart()
                if ScreenCloudRecorderError.isScreenCaptureTCCError(error) { throw error }
            }
        }

        throw lastError ?? ScreenCloudRecorderError.startFailed("Could not start capture.")
    }

    private func cancelPartialStart() async {
        let previous = isHandlingStreamStop
        isHandlingStreamStop = true
        if usesRecordingOutput, #available(macOS 15.0, *),
           let output = recordingOutput as? SCRecordingOutput,
           let stream
        {
            try? stream.removeRecordingOutput(output)
        }
        try? await stream?.stopCapture()
        stream = nil
        recordingOutput = nil
        if let session = writerSession {
            writerSession = nil
            _ = await session.finish()
        }
        stopMicSession()
        usesRecordingOutput = false
        isHandlingStreamStop = previous
    }

    /// Mid-session SCStream death: recover video-only when audio killed the stream; otherwise alert.
    private func handleStreamFailure(_ error: Error) async {
        guard !isHandlingStreamStop else { return }
        isHandlingStreamStop = true
        defer { isHandlingStreamStop = false }

        rememberFailure(error)
        let mapped = ScreenCloudRecorderError.mapCaptureError(error)
        NSLog(
            "%@",
            "[MyPipCam] stream stopped while recording: \(ScreenCloudRecorderError.diagnosticSummary(error))"
        )

        let hadAudio = (restartParams?.microphoneDeviceID != nil)
            || (restartParams?.includeSystemAudio == true)
        let canRecoverAudio =
            isRecording
            && !didFallbackToVideoOnly
            && hadAudio
            && (
                ScreenCloudRecorderError.isAudioCaptureError(error)
                    || ScreenCloudRecorderError.isAudioCaptureError(mapped)
            )
            && !ScreenCloudRecorderError.isScreenCaptureTCCError(mapped)

        if canRecoverAudio {
            do {
                try await recoverVideoOnlyAfterAudioFailure()
                return
            } catch {
                rememberFailure(error)
                NSLog(
                    "%@",
                    "[MyPipCam] video-only recovery failed: \(ScreenCloudRecorderError.diagnosticSummary(error))"
                )
            }
        }

        timer?.invalidate()
        timer = nil
        if usesRecordingOutput, #available(macOS 15.0, *),
           let output = recordingOutput as? SCRecordingOutput,
           let stream
        {
            try? stream.removeRecordingOutput(output)
        }
        try? await stream?.stopCapture()
        stream = nil
        recordingOutput = nil
        // Do not finish/cancel the writer here — Stop may still salvage frames already buffered.
        stopMicSession()

        if ScreenCloudRecorderError.isScreenCaptureTCCError(mapped) {
            needsScreenRecordingPermission = true
            errorMessage = ScreenCloudRecorderError.permissionHelpText
            fatalSessionError = ScreenCloudRecorderError.permissionHelpText
        } else {
            let message = mapped.localizedDescription
            errorMessage = message
            fatalSessionError = message
        }
        isRecording = false
        startedAt = nil
        // Keep outputURL + writerSession so Stop can still try to finalize.
        restartParams = nil
    }

    private func recoverVideoOnlyAfterAudioFailure() async throws {
        guard let params = restartParams else {
            throw ScreenCloudRecorderError.startFailed("Missing capture session to recover.")
        }
        NSLog("[MyPipCam] Recovering: restarting capture video-only after audio failure")

        if let old = outputURL {
            try? FileManager.default.removeItem(at: old)
        }
        await cancelPartialStart()

        let content = try await fetchShareableContent()
        let built = try makeFilter(
            target: params.target,
            displayID: params.displayID,
            windowID: params.windowID,
            content: content
        )
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mypipcam-desktop-\(UUID().uuidString).mp4")
        outputURL = url
        didFallbackToVideoOnly = true
        restartParams = RestartableCapture(
            target: params.target,
            displayID: params.displayID,
            windowID: params.windowID,
            microphoneDeviceID: nil,
            includeSystemAudio: false,
            excludeWindowIDs: params.excludeWindowIDs
        )

        // Prefer asset-writer video-only for recovery — more predictable than SCRecordingOutput.
        try await startWithAssetWriter(
            filter: built.filter,
            width: built.width,
            height: built.height,
            outputURL: url,
            microphoneDeviceID: nil,
            includeSystemAudio: false
        )
        isRecording = true
        errorMessage = "Recording continued without microphone/system audio (audio capture failed)."
        if startedAt == nil {
            startedAt = Date()
            beginElapsedTimer()
        }
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
        self.usesRecordingOutput = true
        self.writerSession = nil
        NSLog("%@", "[MyPipCam] SCRecordingOutput started → \(outputURL.path)")
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

        // Remove stale file so AVAssetWriter can create a fresh one.
        if FileManager.default.fileExists(atPath: outputURL.path) {
            try? FileManager.default.removeItem(at: outputURL)
        }
        try FileManager.default.createDirectory(
            at: outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        let session = try CaptureWriterSession(
            outputURL: outputURL,
            width: width,
            height: height,
            includeAudio: useSystemAudio || useMic,
            queue: sampleQueue
        )
        writerSession = session
        usesRecordingOutput = false

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        if useSystemAudio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        }
        try await stream.startCapture()
        self.stream = stream
        self.recordingOutput = nil
        // Never pass Swift Int to NSLog %d — 64-bit Int misaligns following %@ and SIGSEGVs.
        let audioLabel = (useSystemAudio || useMic) ? "yes" : "no"
        NSLog(
            "%@",
            "[MyPipCam] AVAssetWriter capture started → \(outputURL.path) (\(width)x\(height) audio=\(audioLabel))"
        )

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
}

extension ScreenCloudRecorder: SCStreamDelegate {
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            await self.handleStreamFailure(error)
        }
    }
}

extension ScreenCloudRecorder: SCStreamOutput {
    nonisolated func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        // Append on the sample queue directly — never hop to MainActor (that raced finishWriting
        // and left "Recording file was not written" with zero frames).
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        guard let session = writerSession else { return }
        switch type {
        case .screen:
            session.append(sampleBuffer, isVideo: true)
        case .audio, .microphone:
            session.append(sampleBuffer, isVideo: false)
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
        writerSession?.append(sampleBuffer, isVideo: false)
    }
}

@available(macOS 15.0, *)
extension ScreenCloudRecorder: SCRecordingOutputDelegate {
    nonisolated func recordingOutput(
        _ recordingOutput: SCRecordingOutput,
        didFailWithError error: Error
    ) {
        Task { @MainActor in
            await self.handleStreamFailure(error)
        }
    }

    nonisolated func recordingOutput(
        _ recordingOutput: SCRecordingOutput,
        didFinishRecordingAt url: URL
    ) {
        Task { @MainActor in
            if let cont = self.recordingFinishContinuation {
                self.recordingFinishContinuation = nil
                cont.resume(returning: .success(url))
            }
        }
    }
}

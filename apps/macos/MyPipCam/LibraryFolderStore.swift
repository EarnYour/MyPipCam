import AppKit
import Combine
import Foundation

/// On-disk recording entry under `<LibraryRoot>/recordings/<uuid>/`.
struct FolderRecording: Identifiable, Hashable {
    let id: String
    var title: String
    let createdAt: TimeInterval
    let durationMs: Double
    let mimeType: String
    let sizeBytes: Int64
    let folderURL: URL
    let videoURL: URL
    let thumbURL: URL?
    let transcriptURL: URL?

    var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }

    var formattedDuration: String {
        let totalSec = max(0, Int((durationMs / 1000).rounded()))
        let m = totalSec / 60
        let s = totalSec % 60
        return String(format: "%d:%02d", m, s)
    }

    var formattedDate: String {
        createdDate.formatted(
            .dateTime.month(.abbreviated).day().year().hour().minute()
        )
    }
}

enum LibraryFolderError: LocalizedError {
    case noFolderSelected
    case bookmarkResolveFailed
    case accessDenied
    case invalidLibrary
    case recordingNotFound(String)
    case writeFailed(String)

    var errorDescription: String? {
        switch self {
        case .noFolderSelected:
            return "No recording library folder is set."
        case .bookmarkResolveFailed:
            return "Could not restore access to the library folder. Choose it again."
        case .accessDenied:
            return "macOS denied access to the library folder."
        case .invalidLibrary:
            return "That folder is not a valid MyPipCam library."
        case .recordingNotFound(let id):
            return "Recording “\(id)” was not found on disk."
        case .writeFailed(let detail):
            return detail
        }
    }
}

/// Persists a security-scoped bookmark to a shared library folder and scans
/// the on-disk layout shared with the Chrome extension:
/// ```
/// <LibraryRoot>/
///   .mypipcam-library
///   recordings/<uuid>/{meta.json, video.webm|mp4, …}
/// ```
@MainActor
final class LibraryFolderStore: ObservableObject {
    static let shared = LibraryFolderStore()

    static let markerFileName = ".mypipcam-library"
    static let recordingsDirName = "recordings"
    static let markerVersion = 1
    static let suggestedFolderName = "MyPipCam"

    @Published private(set) var displayPath: String = ""
    @Published private(set) var recordings: [FolderRecording] = []
    @Published private(set) var lastError: String?

    private let defaults = UserDefaults.standard
    private var activeScopedURL: URL?

    var hasLibrary: Bool {
        bookmarkData != nil && !displayPath.isEmpty
    }

    private var bookmarkData: Data? {
        get { defaults.data(forKey: BubbleSettings.libraryFolderBookmarkKey) }
        set {
            if let newValue {
                defaults.set(newValue, forKey: BubbleSettings.libraryFolderBookmarkKey)
            } else {
                defaults.removeObject(forKey: BubbleSettings.libraryFolderBookmarkKey)
            }
        }
    }

    private init() {
        displayPath = defaults.string(forKey: "libraryFolderDisplayPath") ?? ""
    }

    // MARK: - Choose / clear

    /// Presents `NSOpenPanel` (directories only). Suggests `~/Movies/MyPipCam`.
    @discardableResult
    func chooseFolder(settings: BubbleSettings? = nil) -> Bool {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        panel.message = "Choose the shared MyPipCam recording library folder (same path as in Chrome)."
        panel.directoryURL = suggestedLibraryURL()

        guard panel.runModal() == .OK, let url = panel.url else { return false }

        do {
            try adoptFolder(at: url, settings: settings)
            refresh()
            return true
        } catch {
            presentError(error)
            return false
        }
    }

    func clearFolder(settings: BubbleSettings? = nil) {
        stopScopedAccess()
        bookmarkData = nil
        displayPath = ""
        defaults.set("", forKey: "libraryFolderDisplayPath")
        settings?.libraryFolderBookmark = nil
        settings?.libraryFolderDisplayPath = ""
        recordings = []
        lastError = nil
    }

    // MARK: - Resolve / scoped access

    func resolveURL() throws -> URL {
        guard let data = bookmarkData else { throw LibraryFolderError.noFolderSelected }

        var isStale = false
        let url = try URL(
            resolvingBookmarkData: data,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )

        if isStale {
            let refreshed = try url.bookmarkData(
                options: [.withSecurityScope],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            bookmarkData = refreshed
            defaults.set(url.path, forKey: "libraryFolderDisplayPath")
            displayPath = url.path
        }

        return url
    }

    @discardableResult
    func withScopedAccess<T>(_ body: (URL) throws -> T) throws -> T {
        let url = try resolveURL()
        guard url.startAccessingSecurityScopedResource() else {
            throw LibraryFolderError.accessDenied
        }
        defer { url.stopAccessingSecurityScopedResource() }
        return try body(url)
    }

    // MARK: - Scan / mutate

    func refresh() {
        do {
            recordings = try withScopedAccess { root in
                try scanRecordings(in: root)
            }
            lastError = nil
        } catch LibraryFolderError.noFolderSelected {
            recordings = []
            lastError = nil
        } catch {
            recordings = []
            lastError = error.localizedDescription
        }
    }

    func renameRecording(id: String, title: String) throws {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard Self.isSafeRecordingID(id) else {
            throw LibraryFolderError.recordingNotFound(id)
        }

        try withScopedAccess { root in
            let folder = try Self.recordingFolder(root: root, id: id)
            let metaURL = folder.appendingPathComponent("meta.json")
            guard FileManager.default.fileExists(atPath: metaURL.path) else {
                throw LibraryFolderError.recordingNotFound(id)
            }

            var meta = try readMeta(at: metaURL)
            meta["title"] = trimmed
            try writeMeta(meta, to: metaURL)
        }
        refresh()
    }

    func deleteRecording(id: String) throws {
        guard Self.isSafeRecordingID(id) else {
            throw LibraryFolderError.recordingNotFound(id)
        }
        try withScopedAccess { root in
            let folder = try Self.recordingFolder(root: root, id: id)
            guard FileManager.default.fileExists(atPath: folder.path) else {
                throw LibraryFolderError.recordingNotFound(id)
            }
            try FileManager.default.removeItem(at: folder)
        }
        refresh()
    }

    func revealLibraryInFinder() {
        do {
            try withScopedAccess { root in
                NSWorkspace.shared.activateFileViewerSelecting([root])
            }
        } catch {
            presentError(error)
        }
    }

    func revealRecordingInFinder(id: String) {
        guard Self.isSafeRecordingID(id) else {
            presentError(LibraryFolderError.recordingNotFound(id))
            return
        }
        do {
            try withScopedAccess { root in
                let folder = try Self.recordingFolder(root: root, id: id)
                guard FileManager.default.fileExists(atPath: folder.path) else {
                    throw LibraryFolderError.recordingNotFound(id)
                }
                if let video = findVideo(in: folder) {
                    NSWorkspace.shared.activateFileViewerSelecting([video])
                } else {
                    NSWorkspace.shared.activateFileViewerSelecting([folder])
                }
            }
        } catch {
            presentError(error)
        }
    }

    /// Returns a file URL suitable for AVPlayer while holding scoped access
    /// for the duration of playback setup. Caller should keep the store alive.
    func scopedVideoURL(for id: String) throws -> URL {
        guard Self.isSafeRecordingID(id) else {
            throw LibraryFolderError.recordingNotFound(id)
        }
        return try withScopedAccess { root in
            let folder = try Self.recordingFolder(root: root, id: id)
            guard let video = findVideo(in: folder) else {
                throw LibraryFolderError.recordingNotFound(id)
            }
            // Copy into a temporary file so AVPlayer can read after scoped access ends.
            let ext = video.pathExtension.isEmpty ? "mp4" : video.pathExtension
            let temp = FileManager.default.temporaryDirectory
                .appendingPathComponent("mypipcam-\(id).\(ext)")
            if FileManager.default.fileExists(atPath: temp.path) {
                try? FileManager.default.removeItem(at: temp)
            }
            try FileManager.default.copyItem(at: video, to: temp)
            return temp
        }
    }

    // MARK: - Internals

    private func suggestedLibraryURL() -> URL {
        let movies = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies")
        let suggested = movies.appendingPathComponent(Self.suggestedFolderName, isDirectory: true)
        try? FileManager.default.createDirectory(at: suggested, withIntermediateDirectories: true)
        return suggested
    }

    private func adoptFolder(at url: URL, settings: BubbleSettings?) throws {
        try ensureLibraryStructure(at: url)

        let data = try url.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        bookmarkData = data
        displayPath = url.path
        defaults.set(url.path, forKey: "libraryFolderDisplayPath")

        settings?.libraryFolderBookmark = data
        settings?.libraryFolderDisplayPath = url.path
    }

    private func ensureLibraryStructure(at root: URL) throws {
        let fm = FileManager.default
        let recordings = root.appendingPathComponent(Self.recordingsDirName, isDirectory: true)
        try fm.createDirectory(at: recordings, withIntermediateDirectories: true)

        let marker = root.appendingPathComponent(Self.markerFileName)
        if !fm.fileExists(atPath: marker.path) {
            let payload: [String: Any] = ["version": Self.markerVersion]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
            try data.write(to: marker, options: .atomic)
        } else {
            // Accept existing marker; reject clearly wrong content if parseable and version mismatch.
            if let data = try? Data(contentsOf: marker),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let version = json["version"] as? Int,
               version != Self.markerVersion {
                throw LibraryFolderError.invalidLibrary
            }
        }
    }

    private func scanRecordings(in root: URL) throws -> [FolderRecording] {
        let fm = FileManager.default
        let recordingsDir = root.appendingPathComponent(Self.recordingsDirName, isDirectory: true)
        guard fm.fileExists(atPath: recordingsDir.path) else { return [] }

        let dirs = try fm.contentsOfDirectory(
            at: recordingsDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        var items: [FolderRecording] = []
        for dir in dirs {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { continue }
            guard Self.isSafeRecordingID(dir.lastPathComponent) else { continue }
            let metaURL = dir.appendingPathComponent("meta.json")
            guard fm.fileExists(atPath: metaURL.path),
                  let video = findVideo(in: dir),
                  let meta = try? readMeta(at: metaURL)
            else { continue }

            let id = (meta["id"] as? String).flatMap { Self.isSafeRecordingID($0) ? $0 : nil }
                ?? dir.lastPathComponent
            guard Self.isSafeRecordingID(id) else { continue }
            let title = ((meta["title"] as? String) ?? "Recording")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let createdAt = Self.number(meta["createdAt"]) ?? 0
            let durationMs = Self.number(meta["durationMs"]) ?? 0
            let mimeType = (meta["mimeType"] as? String) ?? "video/webm"
            let sizeBytes = Int64(Self.number(meta["sizeBytes"]) ?? 0)

            let thumb = dir.appendingPathComponent("thumb.jpg")
            let transcript = dir.appendingPathComponent("transcript.json")

            items.append(
                FolderRecording(
                    id: id,
                    title: title.isEmpty ? "Recording" : String(title.prefix(200)),
                    createdAt: createdAt,
                    durationMs: durationMs,
                    mimeType: mimeType,
                    sizeBytes: sizeBytes,
                    folderURL: dir,
                    videoURL: video,
                    thumbURL: fm.fileExists(atPath: thumb.path) ? thumb : nil,
                    transcriptURL: fm.fileExists(atPath: transcript.path) ? transcript : nil
                )
            )
        }

        return items.sorted { $0.createdAt > $1.createdAt }
    }

    private func findVideo(in folder: URL) -> URL? {
        let fm = FileManager.default
        let webm = folder.appendingPathComponent("video.webm")
        let mp4 = folder.appendingPathComponent("video.mp4")
        if fm.fileExists(atPath: webm.path) { return webm }
        if fm.fileExists(atPath: mp4.path) { return mp4 }
        return nil
    }

    private func readMeta(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LibraryFolderError.writeFailed("Invalid meta.json")
        }
        return json
    }

    private func writeMeta(_ meta: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    private static func number(_ value: Any?) -> Double? {
        switch value {
        case let n as Double: return n
        case let n as Int: return Double(n)
        case let n as Int64: return Double(n)
        case let n as NSNumber: return n.doubleValue
        default: return nil
        }
    }

    private func stopScopedAccess() {
        activeScopedURL?.stopAccessingSecurityScopedResource()
        activeScopedURL = nil
    }

    private func presentError(_ error: Error) {
        lastError = error.localizedDescription
        let alert = NSAlert()
        alert.messageText = "Library Folder"
        alert.informativeText = error.localizedDescription
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    /// UUID-shaped recording folder names only — blocks path traversal segments.
    static func isSafeRecordingID(_ id: String) -> Bool {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 36 else { return false }
        if trimmed.contains("/") || trimmed.contains("\\") || trimmed.contains("..") {
            return false
        }
        let pattern = #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#
        return trimmed.range(of: pattern, options: .regularExpression) != nil
    }

    static func recordingFolder(root: URL, id: String) throws -> URL {
        guard isSafeRecordingID(id) else {
            throw LibraryFolderError.recordingNotFound(id)
        }
        return root
            .appendingPathComponent(recordingsDirName, isDirectory: true)
            .appendingPathComponent(id, isDirectory: true)
    }
}

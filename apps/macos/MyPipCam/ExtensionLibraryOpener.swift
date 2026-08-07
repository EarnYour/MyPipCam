import AppKit
import Darwin

/// Opens the Chrome extension library/editor (secondary path for transcription & editing).
/// Prefer the native Recording Library window when a shared folder is configured.
enum ExtensionLibraryOpener {
    /// Stable ID from the public `key` in `apps/extension/manifest.config.ts` (Load unpacked).
    static let defaultExtensionID = "akpchobfndfddajiihkkdpnihihdicjc"
    /// Live Chrome Web Store item ID (published zip without manifest `key`).
    static let chromeWebStoreExtensionID = "meiehjfjcaahfjcdneoegjkmajbfghmm"
    /// Known installs: store (published) first, then unpacked local.
    private static let knownExtensionIDs = [chromeWebStoreExtensionID, defaultExtensionID]
    /// Must match popup/`openLibraryTab` and `apps/extension/dist` (CRX keeps `src/…`).
    static let libraryPath = "src/library/index.html"
    /// HTTPS bridge asks the extension to open Library via chrome.tabs (avoids ad-block ERR_BLOCKED_BY_CLIENT).
    /// Pass `ext=` = store or unpacked ID (`chromeWebStoreExtensionID` / `defaultExtensionID`).
    static let bridgeOpenPath = "https://mypipcam.earnyour.com/open-library"
    static let extensionDisplayName = "MyPipCam"
    static let releasesURL = URL(string: "https://github.com/EarnYour/MyPipCam/releases")!
    static let extensionReleaseTag = "v1.1.10"

    private static let firstOpenTipKey = "hasShownLibraryExtensionTip"
    private static let extensionIdDefaultsKey = "chromeExtensionId"

    private static let uuidPattern =
        #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#

    static func libraryURL(extensionID: String, recordingID: String? = nil) -> URL? {
        let id = sanitizedExtensionID(extensionID)
        guard isValidExtensionID(id) else { return nil }
        var urlString = "chrome-extension://\(id)/\(libraryPath)"
        if let recordingID, isSafeRecordingID(recordingID) {
            urlString += "?id=\(recordingID)"
        }
        return URL(string: urlString)
    }

    /// Primary open target: product-site bridge → extension `OPEN_LIBRARY` message.
    static func bridgeLibraryURL(extensionID: String, recordingID: String? = nil) -> URL? {
        let id = sanitizedExtensionID(extensionID)
        guard isValidExtensionID(id) else { return nil }
        var components = URLComponents(string: bridgeOpenPath)
        var items: [URLQueryItem] = [URLQueryItem(name: "ext", value: id)]
        if let recordingID, isSafeRecordingID(recordingID) {
            items.append(URLQueryItem(name: "id", value: recordingID))
        }
        components?.queryItems = items
        return components?.url
    }

    /// Resolves which extension ID to use, in order:
    /// 1. UserDefaults override (`chromeExtensionId`)
    /// 2. Auto-detected install under Chromium profiles (unpacked key ID, then store ID, then name match)
    /// 3. Stable unpacked ID from the packed manifest `key`
    static func resolveExtensionID(preferred: String? = nil) -> String {
        if let preferred {
            let trimmed = preferred.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return sanitizedExtensionID(trimmed)
            }
        }

        if let stored = UserDefaults.standard.string(forKey: extensionIdDefaultsKey) {
            let trimmed = stored.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return sanitizedExtensionID(trimmed)
            }
        }

        if let detected = detectInstalledExtensionID() {
            return detected
        }

        return defaultExtensionID
    }

    /// Opens the library in Chrome/Chromium. Pass `recordingID` to highlight a clip (`?id=`).
    @MainActor
    static func openRecordingLibrary(extensionID: String? = nil, recordingID: String? = nil) {
        guard chromiumBrowserURL() != nil else {
            showNoBrowserAlert()
            return
        }

        let id = resolveExtensionID(preferred: extensionID)
        guard let bridgeURL = bridgeLibraryURL(extensionID: id, recordingID: recordingID) else {
            promptForExtensionID(reason: .invalidOrMissing, thenOpen: true, recordingID: recordingID)
            return
        }
        let directURL = libraryURL(extensionID: id, recordingID: recordingID)

        // Sandboxed apps often cannot *read* Chrome Preferences (macOS EPERM), even with
        // home-relative temporary exceptions. Prefer metadata probes; when profiles are
        // unreadable, open the HTTPS bridge without a false “Not Detected” scare.
        let profileAccess = chromiumProfileAccess()
        let extensionPresent = extensionLikelyPresent(id: id)

        if !extensionPresent, profileAccess == .readable {
            let alert = NSAlert()
            alert.messageText = "MyPipCam Extension Not Detected"
            alert.informativeText = """
            Chrome doesn’t appear to have the MyPipCam extension loaded (checked your Chromium profiles).

            You can still try opening the library bridge — it works when the extension is installed under ID:
            \(id)

            Or install/reload it first (Load unpacked → apps/extension/dist, or GitHub Releases \(extensionReleaseTag)).
            """
            alert.alertStyle = .informational
            alert.addButton(withTitle: "Open Anyway")
            alert.addButton(withTitle: "Install Help…")
            alert.addButton(withTitle: "Cancel")
            let response = alert.runModal()
            if response == .alertSecondButtonReturn {
                showMissingExtensionHelp(openedURL: bridgeURL, directURL: directURL, openFailed: false)
                return
            }
            if response != .alertFirstButtonReturn {
                return
            }
        }

        openInChromiumBrowser(bridgeURL) { success, detail in
            Task { @MainActor in
                if success {
                    if !UserDefaults.standard.bool(forKey: firstOpenTipKey) {
                        UserDefaults.standard.set(true, forKey: firstOpenTipKey)
                        showFirstOpenTip(openedURL: bridgeURL, directURL: directURL)
                    }
                } else if extensionPresent {
                    showOpenFailedAlert(openedURL: bridgeURL, directURL: directURL, detail: detail)
                } else {
                    // Missing on a readable scan, or inconclusive under sandbox — guide install.
                    showMissingExtensionHelp(
                        openedURL: bridgeURL,
                        directURL: directURL,
                        openFailed: true,
                        detail: detail
                    )
                }
            }
        }
    }

    /// Menu action: paste ID from chrome://extensions, save, optionally open library.
    @MainActor
    static func promptForExtensionID(
        reason: ExtensionIDPromptReason = .manual,
        thenOpen: Bool = true,
        recordingID: String? = nil
    ) {
        let alert = NSAlert()
        switch reason {
        case .manual:
            alert.messageText = "Set Chrome Extension ID"
            alert.informativeText = """
            If Open in Chrome… shows a blank/error page, your unpacked extension ID may differ from the default.

            1. Open chrome://extensions
            2. Enable Developer mode
            3. Under MyPipCam, copy the ID (32 letters)
            4. Paste it below
            """
        case .invalidOrMissing:
            alert.messageText = "Extension ID Needed"
            alert.informativeText = """
            Paste your MyPipCam extension ID from chrome://extensions (Developer mode → copy ID under the extension).
            """
        case .pageDidNotLoad:
            alert.messageText = "Library Didn’t Load?"
            alert.informativeText = """
            Your Chrome extension may be installed under a different ID (common if it was loaded unpacked before the stable key was added).

            Paste the ID from chrome://extensions (32 letters under MyPipCam), then Open Library.
            """
        }
        alert.alertStyle = .informational

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "e.g. \(defaultExtensionID)"
        field.stringValue = UserDefaults.standard.string(forKey: extensionIdDefaultsKey) ?? ""
        if field.stringValue.isEmpty {
            field.stringValue = detectInstalledExtensionID() ?? defaultExtensionID
        }
        alert.accessoryView = field

        alert.addButton(withTitle: thenOpen ? "Save & Open Library" : "Save")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Use Default ID")
        alert.window.initialFirstResponder = field

        let response = alert.runModal()
        switch response {
        case .alertFirstButtonReturn:
            let raw = field.stringValue
            let id = sanitizedExtensionID(raw)
            guard isValidExtensionID(id) else {
                showInvalidIDAlert(raw)
                return
            }
            UserDefaults.standard.set(id, forKey: extensionIdDefaultsKey)
            if thenOpen {
                openRecordingLibrary(extensionID: id, recordingID: recordingID)
            }
        case .alertThirdButtonReturn:
            UserDefaults.standard.set("", forKey: extensionIdDefaultsKey)
            if thenOpen {
                openRecordingLibrary(extensionID: defaultExtensionID, recordingID: recordingID)
            }
        default:
            break
        }
    }

    /// Guides the user through loading the unpacked extension.
    @MainActor
    static func showInstallChromeExtensionHelp() {
        openChromeExtensionsPage()
        revealExtensionDistInFinder()

        let detected = detectInstalledExtensionID()
        let idLine = detected.map { "Detected installed ID: \($0)" }
            ?? "Default (manifest key) ID: \(defaultExtensionID)"

        let alert = NSAlert()
        alert.messageText = "Install MyPipCam Chrome Extension"
        alert.informativeText = """
        The Chrome extension records clips and can share them via a local library folder with this Mac app.

        1. Build once: cd apps/extension && npm run build
           (or download the extension from GitHub Releases \(extensionReleaseTag))
        2. Chrome opens chrome://extensions — enable Developer mode
        3. Click “Load unpacked” and select the revealed dist folder
           (…/MyPipCam/apps/extension/dist)
        4. In both apps, choose the same folder (suggested: ~/Movies/MyPipCam)

        \(idLine)
        Bridge: \(bridgeOpenPath)?ext=\(detected ?? defaultExtensionID)
        Extension page: chrome-extension://\(detected ?? defaultExtensionID)/\(libraryPath)

        Use Open in Chrome… for the editor/transcription UI. If Chrome shows ERR_BLOCKED_BY_CLIENT, disable the ad blocker for the tab or open Library from the extension popup. Wrong ID → Set Extension ID….
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Set Extension ID…")
        alert.addButton(withTitle: "Open Releases…")
        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            promptForExtensionID(reason: .manual, thenOpen: true)
        } else if response == .alertThirdButtonReturn {
            NSWorkspace.shared.open(releasesURL)
        }
    }

    // MARK: - Detection

    private enum ChromiumProfileAccess {
        /// Listed/read Chrome (or other) profile data successfully.
        case readable
        /// Roots exist but sandbox/TCC blocks directory listing or Preferences reads.
        case unreadable
        /// No Chromium user-data roots found on disk.
        case missing
    }

    /// Scans Chromium-family profiles for a MyPipCam install (packed Extensions dirs + unpacked Preferences).
    static func detectInstalledExtensionID() -> String? {
        let found = allDetectedExtensionIDs()
        if found.contains(chromeWebStoreExtensionID) {
            return chromeWebStoreExtensionID
        }
        if found.contains(defaultExtensionID) {
            return defaultExtensionID
        }
        return found.first
    }

    /// True when Secure Preferences / Preferences / Extensions dirs / metadata paths mention this ID.
    static func extensionLikelyPresent(id: String) -> Bool {
        let cleaned = sanitizedExtensionID(id)
        guard isValidExtensionID(cleaned) else { return false }
        return allDetectedExtensionIDs().contains(cleaned)
            || chromeProfileMentions(extensionID: cleaned)
            || extensionPresentViaPathProbe(id: cleaned)
    }

    /// Whether we can list/read Chromium profile files (vs. metadata-only `fileExists`).
    private static func chromiumProfileAccess() -> ChromiumProfileAccess {
        let fm = FileManager.default
        var sawRoot = false
        for root in chromiumSupportRoots() where fm.fileExists(atPath: root.path) {
            sawRoot = true
            if (try? fm.contentsOfDirectory(atPath: root.path)) != nil {
                return .readable
            }
            // Listing blocked — confirm content read is also blocked (common on modern macOS sandbox).
            for profile in commonProfileDirectoryNames() {
                let prefs = root.appendingPathComponent(profile).appendingPathComponent("Secure Preferences")
                if fm.fileExists(atPath: prefs.path) {
                    if fm.isReadableFile(atPath: prefs.path),
                       (try? Data(contentsOf: prefs, options: [.mappedIfSafe])) != nil {
                        return .readable
                    }
                    return .unreadable
                }
            }
            let localState = root.appendingPathComponent("Local State")
            if fm.fileExists(atPath: localState.path) {
                if fm.isReadableFile(atPath: localState.path),
                   (try? Data(contentsOf: localState, options: [.mappedIfSafe])) != nil {
                    return .readable
                }
                return .unreadable
            }
        }
        return sawRoot ? .unreadable : .missing
    }

    private static func allDetectedExtensionIDs() -> [String] {
        var found: [String] = []
        found.append(contentsOf: detectPackedExtensionIDs())
        found.append(contentsOf: detectUnpackedExtensionIDsFromPreferences())
        found.append(contentsOf: detectExtensionIDsViaPathProbe())
        // Unpacked key ID first (dev), then store ID, then any other MyPipCam match.
        var ordered: [String] = []
        for known in knownExtensionIDs where found.contains(known) {
            ordered.append(known)
        }
        for id in found where !ordered.contains(id) {
            ordered.append(id)
        }
        return ordered
    }

    private static func detectPackedExtensionIDs() -> [String] {
        let fm = FileManager.default
        var found: [String] = []

        for profile in chromiumProfileDirectories() {
            let extensionsDir = profile.appendingPathComponent("Extensions")
            guard let ids = try? fm.contentsOfDirectory(
                at: extensionsDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            for idDir in ids {
                let candidateID = idDir.lastPathComponent.lowercased()
                guard isValidExtensionID(candidateID) else { continue }
                if extensionDirectoryMatches(idDir) {
                    found.append(candidateID)
                }
            }
        }
        return found
    }

    /// Unpacked installs live under Preferences / Secure Preferences `extensions.settings`, not Extensions/.
    private static func detectUnpackedExtensionIDsFromPreferences() -> [String] {
        let fm = FileManager.default
        var found: [String] = []

        for profile in chromiumProfileDirectories() {
            for name in ["Secure Preferences", "Preferences"] {
                let prefsURL = profile.appendingPathComponent(name)
                guard fm.isReadableFile(atPath: prefsURL.path),
                      let data = try? Data(contentsOf: prefsURL),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let extensions = json["extensions"] as? [String: Any],
                      let settings = extensions["settings"] as? [String: Any]
                else { continue }

                for (eid, raw) in settings {
                    let candidateID = eid.lowercased()
                    guard isValidExtensionID(candidateID) else { continue }
                    guard let info = raw as? [String: Any] else { continue }
                    if preferencesEntryMatchesMyPipCam(info, extensionID: candidateID) {
                        found.append(candidateID)
                    }
                }
            }
        }
        return found
    }

    private static func preferencesEntryMatchesMyPipCam(_ info: [String: Any], extensionID: String) -> Bool {
        // Chrome often omits embedded `manifest` for unpacked (location 4) installs.
        // Treat known IDs (unpacked key + Chrome Web Store) as MyPipCam when present.
        if knownExtensionIDs.contains(extensionID) {
            let disabled = !((info["disable_reasons"] as? [Any]) ?? []).isEmpty
                || ((info["disable_reasons"] as? [String: Any])?.isEmpty == false)
            if !disabled {
                // Known-ID entry present and not disabled counts even without a name field.
                if info["path"] != nil || info["location"] != nil || info["manifest"] != nil {
                    return true
                }
            }
        }
        if let manifest = info["manifest"] as? [String: Any],
           let name = manifest["name"] as? String,
           name.caseInsensitiveCompare(extensionDisplayName) == .orderedSame {
            return true
        }
        if let path = info["path"] as? String {
            let lowered = path.lowercased()
            if lowered.contains("mypipcam") && (lowered.contains("extension") || lowered.hasSuffix("/dist") || lowered.contains("/dist/")) {
                return true
            }
            // Path points at a dist folder that still has our manifest.
            let manifestURL = URL(fileURLWithPath: path).appendingPathComponent("manifest.json")
            if let data = try? Data(contentsOf: manifestURL),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let name = json["name"] as? String,
               name.caseInsensitiveCompare(extensionDisplayName) == .orderedSame {
                return true
            }
        }
        return false
    }

    private static func chromeProfileMentions(extensionID: String) -> Bool {
        let fm = FileManager.default
        for profile in chromiumProfileDirectories() {
            let localSettings = profile
                .appendingPathComponent("Local Extension Settings")
                .appendingPathComponent(extensionID)
            if fm.fileExists(atPath: localSettings.path) { return true }

            for name in ["Secure Preferences", "Preferences"] {
                let prefsURL = profile.appendingPathComponent(name)
                guard fm.isReadableFile(atPath: prefsURL.path),
                      let data = try? Data(contentsOf: prefsURL),
                      let text = String(data: data, encoding: .utf8)
                else { continue }
                if text.contains(extensionID) { return true }
            }
        }
        return false
    }

    /// Sandbox often allows `fileExists` on known paths while blocking `contentsOfDirectory` /
    /// `Data(contentsOf:)` for Chrome Preferences. Probe common profile names for this ID.
    private static func extensionPresentViaPathProbe(id: String) -> Bool {
        let fm = FileManager.default
        for root in chromiumSupportRoots() where fm.fileExists(atPath: root.path) {
            for profileName in commonProfileDirectoryNames() {
                let profile = root.appendingPathComponent(profileName)
                if !fm.fileExists(atPath: profile.path) { continue }
                if extensionArtifactsExist(in: profile, extensionID: id) {
                    return true
                }
            }
        }
        return false
    }

    /// When prefs aren’t readable, still surface known IDs if metadata dirs exist.
    private static func detectExtensionIDsViaPathProbe() -> [String] {
        var found: [String] = []
        for known in knownExtensionIDs where extensionPresentViaPathProbe(id: known) {
            found.append(known)
        }
        if let stored = UserDefaults.standard.string(forKey: extensionIdDefaultsKey) {
            let cleaned = sanitizedExtensionID(stored)
            if isValidExtensionID(cleaned),
               !knownExtensionIDs.contains(cleaned),
               extensionPresentViaPathProbe(id: cleaned) {
                found.append(cleaned)
            }
        }
        return found
    }

    private static func extensionArtifactsExist(in profile: URL, extensionID: String) -> Bool {
        let fm = FileManager.default
        let candidates = [
            profile.appendingPathComponent("Local Extension Settings").appendingPathComponent(extensionID),
            profile.appendingPathComponent("Sync Extension Settings").appendingPathComponent(extensionID),
            profile.appendingPathComponent("Extensions").appendingPathComponent(extensionID),
            profile.appendingPathComponent("IndexedDB")
                .appendingPathComponent("chrome-extension_\(extensionID)_0.indexeddb.leveldb"),
            profile.appendingPathComponent("Storage")
                .appendingPathComponent("ext-\(extensionID)"),
        ]
        return candidates.contains { fm.fileExists(atPath: $0.path) }
    }

    /// Profile dirs from a successful listing, or common names when listing is denied.
    private static func chromiumProfileDirectories() -> [URL] {
        let fm = FileManager.default
        var dirs: [URL] = []
        for root in chromiumSupportRoots() {
            if let kids = try? fm.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) {
                for kid in kids {
                    var isDir: ObjCBool = false
                    guard fm.fileExists(atPath: kid.path, isDirectory: &isDir), isDir.boolValue else { continue }
                    let name = kid.lastPathComponent
                    // Skip cache/system folders at the Chrome root.
                    if name.hasSuffix("Cache") || name == "ShaderCache" || name == "GrShaderCache"
                        || name == "GraphiteDawnCache" || name == "Crashpad" { continue }
                    dirs.append(kid)
                }
                continue
            }
            // Listing denied: probe well-known profile folder names.
            for name in commonProfileDirectoryNames() {
                let profile = root.appendingPathComponent(name)
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: profile.path, isDirectory: &isDir), isDir.boolValue {
                    dirs.append(profile)
                }
            }
        }
        return dirs
    }

    private static func commonProfileDirectoryNames() -> [String] {
        var names = ["Default", "Guest Profile", "System Profile"]
        for i in 1...20 {
            names.append("Profile \(i)")
        }
        return names
    }

    /// Real user home (not the App Sandbox container). Required for Chrome prefs detection
    /// via `com.apple.security.temporary-exception.files.home-relative-path.read-only`.
    private static var realHomeDirectory: URL {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    private static func chromiumSupportRoots() -> [URL] {
        let support = realHomeDirectory.appendingPathComponent("Library/Application Support")
        return [
            support.appendingPathComponent("Google/Chrome"),
            support.appendingPathComponent("Google/Chrome Canary"),
            support.appendingPathComponent("Google/Chrome Beta"),
            support.appendingPathComponent("Google/Chrome for Testing"),
            support.appendingPathComponent("Google/ChromeForTesting"),
            support.appendingPathComponent("Chromium"),
            support.appendingPathComponent("BraveSoftware/Brave-Browser"),
            support.appendingPathComponent("Microsoft Edge"),
            support.appendingPathComponent("Arc/User Data"),
            support.appendingPathComponent("Vivaldi"),
        ]
    }

    private static func extensionDirectoryMatches(_ idDir: URL) -> Bool {
        let fm = FileManager.default
        guard let versions = try? fm.contentsOfDirectory(
            at: idDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            // Can’t list versions (sandbox) — treat directory presence as a weak match only for
            // known IDs; packed CRX trees are under Extensions/<id>/<version>/.
            return knownExtensionIDs.contains(idDir.lastPathComponent.lowercased())
        }

        for version in versions {
            let manifestURL = version.appendingPathComponent("manifest.json")
            guard let data = try? Data(contentsOf: manifestURL),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let name = json["name"] as? String
            else { continue }

            if name.caseInsensitiveCompare(extensionDisplayName) == .orderedSame {
                return true
            }
        }
        return false
    }

    // MARK: - Browser

    private struct BrowserTarget {
        let name: String
        let bundleID: String
        let appURL: URL
    }

    private static func chromiumBrowserURL() -> URL? {
        browserTargets().first?.appURL
    }

    private static func browserTargets() -> [BrowserTarget] {
        let candidates: [(String, String)] = [
            ("Google Chrome", "com.google.Chrome"),
            ("Google Chrome Canary", "com.google.Chrome.canary"),
            ("Arc", "company.thebrowser.Browser"),
            ("Chromium", "org.chromium.Chromium"),
            ("Brave Browser", "com.brave.Browser"),
            ("Microsoft Edge", "com.microsoft.edgemac"),
            ("Vivaldi", "com.vivaldi.Vivaldi"),
        ]

        var result: [BrowserTarget] = []
        for (name, bundleID) in candidates {
            if let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
                result.append(BrowserTarget(name: name, bundleID: bundleID, appURL: appURL))
                continue
            }
            let paths = [
                "/Applications/\(name).app",
                "\(NSHomeDirectory())/Applications/\(name).app",
            ]
            for path in paths where FileManager.default.fileExists(atPath: path) {
                result.append(
                    BrowserTarget(name: name, bundleID: bundleID, appURL: URL(fileURLWithPath: path))
                )
                break
            }
        }
        return result
    }

    /// Opens a chrome-extension:// URL. Never uses bare `NSWorkspace.open(url)` — macOS has no
    /// system handler for that scheme and shows “No application knows how to open URL…”.
    @MainActor
    private static func openInChromiumBrowser(_ url: URL, completion: @escaping (Bool, String?) -> Void) {
        let targets = browserTargets()
        guard !targets.isEmpty else {
            completion(false, "No Chromium browser found.")
            return
        }

        tryOpenWithWorkspace(url, targets: targets) { wsOK, wsDetail in
            if wsOK {
                completion(true, nil)
                return
            }
            if tryOpenWithOpenCLI(url, targets: targets) {
                completion(true, nil)
                return
            }
            if tryOpenWithAppleScript(url, targets: targets) {
                completion(true, nil)
                return
            }
            completion(false, wsDetail ?? "Could not hand the library URL to Chrome.")
        }
    }

    private static func tryOpenWithWorkspace(
        _ url: URL,
        targets: [BrowserTarget],
        completion: @escaping (Bool, String?) -> Void
    ) {
        func attempt(_ index: Int, lastError: String?) {
            guard index < targets.count else {
                completion(false, lastError)
                return
            }
            let target = targets[index]
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            NSWorkspace.shared.open([url], withApplicationAt: target.appURL, configuration: config) { _, error in
                if let error {
                    attempt(index + 1, lastError: error.localizedDescription)
                } else {
                    completion(true, nil)
                }
            }
        }
        attempt(0, lastError: nil)
    }

    @discardableResult
    private static func tryOpenWithOpenCLI(_ url: URL, targets: [BrowserTarget]) -> Bool {
        for target in targets {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", target.name, url.absoluteString]
            do {
                let err = Pipe()
                process.standardError = err
                try process.run()
                process.waitUntilExit()
                if process.terminationStatus == 0 {
                    return true
                }
            } catch {
                continue
            }
        }
        return false
    }

    @discardableResult
    private static func tryOpenWithAppleScript(_ url: URL, targets: [BrowserTarget]) -> Bool {
        for target in targets {
            let escaped = url.absoluteString
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            let source = """
            tell application "\(target.name)"
              activate
              open location "\(escaped)"
            end tell
            """
            var error: NSDictionary?
            if let script = NSAppleScript(source: source) {
                _ = script.executeAndReturnError(&error)
                if error == nil {
                    return true
                }
            }
        }
        return false
    }

    @MainActor
    private static func openChromeExtensionsPage() {
        let targets = browserTargets()
        guard let extensionsURL = URL(string: "chrome://extensions") else { return }
        if !targets.isEmpty {
            tryOpenWithWorkspace(extensionsURL, targets: targets) { ok, _ in
                if !ok {
                    _ = tryOpenWithOpenCLI(extensionsURL, targets: targets)
                }
            }
            return
        }
        // chrome:// also has no system handler — only open with a browser app.
    }

    // MARK: - Dist folder

    @MainActor
    private static func revealExtensionDistInFinder() {
        guard let dist = resolveExtensionDistDirectory() else { return }
        NSWorkspace.shared.activateFileViewerSelecting([dist])
    }

    /// Best-effort path to the unpacked extension build output in this monorepo.
    private static func resolveExtensionDistDirectory() -> URL? {
        let fm = FileManager.default
        var candidates: [URL] = []

        if let override = UserDefaults.standard.string(forKey: "chromeExtensionDistPath"),
           !override.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            candidates.append(URL(fileURLWithPath: (override as NSString).expandingTildeInPath))
        }

        let home = realHomeDirectory
        candidates.append(contentsOf: [
            home.appendingPathComponent("Projects/MyPipCam/apps/extension/dist"),
            home.appendingPathComponent("Developer/MyPipCam/apps/extension/dist"),
            home.appendingPathComponent("src/MyPipCam/apps/extension/dist"),
            home.appendingPathComponent("code/MyPipCam/apps/extension/dist"),
        ])

        // Walk up from the running app (useful when launched from an in-repo build).
        var dir = Bundle.main.bundleURL
        for _ in 0..<12 {
            dir = dir.deletingLastPathComponent()
            candidates.append(dir.appendingPathComponent("apps/extension/dist"))
            if dir.path == "/" { break }
        }

        for url in candidates {
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                return url
            }
        }
        return nil
    }

    // MARK: - Alerts

    enum ExtensionIDPromptReason {
        case manual
        case invalidOrMissing
        case pageDidNotLoad
    }

    @MainActor
    private static func showFirstOpenTip(openedURL: URL, directURL: URL?) {
        let alert = NSAlert()
        alert.messageText = "Opened Recording Library"
        var text = """
        MyPipCam opened the HTTPS bridge (so Chrome opens Library from inside the extension):

        \(openedURL.absoluteString)

        If the bridge says it couldn’t reach the extension, reload MyPipCam on chrome://extensions (store ID \(chromeWebStoreExtensionID) or unpacked \(defaultExtensionID)).
        If you ever open the raw chrome-extension:// URL and see ERR_BLOCKED_BY_CLIENT, an ad blocker is blocking it — use the bridge, disable the blocker for that tab, or click Library in the extension popup.
        """
        if let directURL {
            text += "\n\nDirect extension URL (fallback):\n\(directURL.absoluteString)"
        }
        alert.informativeText = text
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Set Extension ID…")
        if let directURL {
            alert.addButton(withTitle: "Open Direct URL…")
        }
        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            promptForExtensionID(reason: .pageDidNotLoad, thenOpen: true)
        } else if response == .alertThirdButtonReturn, let directURL {
            openInChromiumBrowser(directURL) { _, _ in }
        }
    }

    @MainActor
    private static func showMissingExtensionHelp(
        openedURL: URL,
        directURL: URL?,
        openFailed: Bool,
        detail: String? = nil
    ) {
        openChromeExtensionsPage()
        revealExtensionDistInFinder()

        let alert = NSAlert()
        alert.messageText = openFailed
            ? "Couldn’t Open Chrome Library"
            : "Install or Reload MyPipCam in Chrome"
        var text = """
        Open in Chrome… needs the MyPipCam Chrome extension loaded in Google Chrome.

        1. Go to chrome://extensions (opened for you)
        2. Enable Developer mode
        3. Load unpacked → select apps/extension/dist (revealed in Finder if found)
           Or install from GitHub Releases (\(extensionReleaseTag) extension build)
        4. Confirm the ID under MyPipCam is the store ID (\(chromeWebStoreExtensionID)) or unpacked (\(defaultExtensionID)) — or use Set Extension ID…
        5. Choose the same library folder as this Mac app (suggested: ~/Movies/MyPipCam)

        Bridge URL:
        \(openedURL.absoluteString)
        """
        if let directURL {
            text += "\n\nDirect extension URL:\n\(directURL.absoluteString)"
        }
        if let detail, !detail.isEmpty {
            text += "\n\nDetails: \(detail)"
        }
        alert.informativeText = text
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Set Extension ID…")
        alert.addButton(withTitle: "Open Releases…")
        alert.addButton(withTitle: "Copy Bridge URL")
        let response = alert.runModal()
        // Buttons: OK (1000), Set Extension ID… (1001), Open Releases… (1002), Copy (1003)
        switch response {
        case .alertSecondButtonReturn:
            promptForExtensionID(reason: .pageDidNotLoad, thenOpen: true)
        case .alertThirdButtonReturn:
            NSWorkspace.shared.open(releasesURL)
        case NSApplication.ModalResponse(rawValue: 1003):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(openedURL.absoluteString, forType: .string)
        default:
            break
        }
    }

    @MainActor
    private static func showOpenFailedAlert(openedURL: URL, directURL: URL?, detail: String?) {
        let alert = NSAlert()
        alert.messageText = "Couldn’t Open Chrome Library"
        var text = """
        macOS couldn’t hand this URL to Chrome:

        \(openedURL.absoluteString)

        \(detail ?? "Unknown error")

        Try: quit and reopen Google Chrome, then use Open in Chrome… again.
        If Chrome shows ERR_BLOCKED_BY_CLIENT on a chrome-extension:// page, disable the ad blocker or open Library from the extension popup.
        """
        if let directURL {
            text += "\n\nDirect fallback:\n\(directURL.absoluteString)"
        }
        alert.informativeText = text
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Set Extension ID…")
        alert.addButton(withTitle: "Copy Bridge URL")
        if directURL != nil {
            alert.addButton(withTitle: "Open Direct URL…")
        }
        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            promptForExtensionID(reason: .pageDidNotLoad, thenOpen: true)
        } else if response == .alertThirdButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(openedURL.absoluteString, forType: .string)
        } else if response == NSApplication.ModalResponse(rawValue: 1003), let directURL {
            openInChromiumBrowser(directURL) { _, _ in }
        }
    }

    @MainActor
    private static func showNoBrowserAlert() {
        let alert = NSAlert()
        alert.messageText = "Google Chrome Required"
        alert.informativeText = """
        Open in Chrome… needs Google Chrome (or another Chromium browser: Arc, Brave, Edge, Vivaldi).

        Install Chrome, then load the MyPipCam extension from:
        \(releasesURL.absoluteString)
        (extension build \(extensionReleaseTag), or build apps/extension locally).
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Open Releases…")
        if alert.runModal() == .alertSecondButtonReturn {
            NSWorkspace.shared.open(releasesURL)
        }
    }

    @MainActor
    private static func showInvalidIDAlert(_ raw: String) {
        let alert = NSAlert()
        alert.messageText = "Invalid Extension ID"
        alert.informativeText = """
        “\(raw.trimmingCharacters(in: .whitespacesAndNewlines))” doesn’t look like a Chrome extension ID.

        IDs are 32 lowercase letters (a–p), shown under the extension on chrome://extensions when Developer mode is on.
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Try Again")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn {
            promptForExtensionID(reason: .manual, thenOpen: true)
        }
    }

    // MARK: - ID helpers

    /// Chrome extension IDs are 32 chars of a–p (hex nibbles mapped to letters).
    static func isValidExtensionID(_ id: String) -> Bool {
        let cleaned = sanitizedExtensionID(id)
        guard cleaned.count == 32 else { return false }
        return cleaned.allSatisfy { ("a"..."p").contains($0) }
    }

    private static func sanitizedExtensionID(_ raw: String) -> String {
        raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .filter { $0.isLetter }
    }

    private static func isSafeRecordingID(_ id: String) -> Bool {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 36 else { return false }
        if trimmed.contains("/") || trimmed.contains("\\") || trimmed.contains("..") {
            return false
        }
        return trimmed.range(of: uuidPattern, options: .regularExpression) != nil
    }
}

import AppKit

/// Opens the Chrome extension library/editor (secondary path for transcription & editing).
/// Prefer the native Recording Library window when a shared folder is configured.
enum ExtensionLibraryOpener {
    /// Stable ID from the public `key` in `apps/extension/manifest.config.ts`.
    static let defaultExtensionID = "akpchobfndfddajiihkkdpnihihdicjc"
    static let libraryPath = "src/library/index.html"
    static let extensionDisplayName = "MyPipCam"

    private static let firstOpenTipKey = "hasShownLibraryExtensionTip"
    private static let extensionIdDefaultsKey = "chromeExtensionId"

    static func libraryURL(extensionID: String) -> URL? {
        let id = sanitizedExtensionID(extensionID)
        guard isValidExtensionID(id) else { return nil }
        return URL(string: "chrome-extension://\(id)/\(libraryPath)")
    }

    /// Resolves which extension ID to use, in order:
    /// 1. UserDefaults override (`chromeExtensionId`)
    /// 2. Auto-detected install under Chromium profiles (name match)
    /// 3. Stable ID from the packed manifest `key`
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

    /// Opens the library in Chrome/Chromium. On first use shows a soft tip with
    /// “Set Extension ID…” if the page doesn’t load (common when ID mismatch).
    @MainActor
    static func openRecordingLibrary(extensionID: String? = nil) {
        let id = resolveExtensionID(preferred: extensionID)
        guard let url = libraryURL(extensionID: id) else {
            promptForExtensionID(reason: .invalidOrMissing, thenOpen: true)
            return
        }

        openInChromiumBrowser(url)

        if !UserDefaults.standard.bool(forKey: firstOpenTipKey) {
            UserDefaults.standard.set(true, forKey: firstOpenTipKey)
            showFirstOpenTip(openedURL: url)
        }
    }

    /// Menu action: paste ID from chrome://extensions, save, optionally open library.
    @MainActor
    static func promptForExtensionID(
        reason: ExtensionIDPromptReason = .manual,
        thenOpen: Bool = true
    ) {
        let alert = NSAlert()
        switch reason {
        case .manual:
            alert.messageText = "Set Chrome Extension ID"
            alert.informativeText = """
            If Open Recording Library shows a blank/error page, your unpacked extension ID may differ from the default.

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
                openRecordingLibrary(extensionID: id)
            }
        case .alertThirdButtonReturn:
            UserDefaults.standard.set("", forKey: extensionIdDefaultsKey)
            if thenOpen {
                openRecordingLibrary(extensionID: defaultExtensionID)
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
        2. Chrome opens chrome://extensions — enable Developer mode
        3. Click “Load unpacked” and select the revealed dist folder
           (…/MyPipCam/apps/extension/dist)
        4. In both apps, choose the same folder (e.g. ~/Movies/MyPipCam)

        \(idLine)
        Library path: \(libraryPath)
        Example URL: chrome-extension://\(detected ?? defaultExtensionID)/\(libraryPath)

        Use Open in Chrome… for the editor/transcription UI. If that page fails, use Set Extension ID… and paste the ID from chrome://extensions.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Set Extension ID…")
        if alert.runModal() == .alertSecondButtonReturn {
            promptForExtensionID(reason: .manual, thenOpen: true)
        }
    }

    // MARK: - Detection

    /// Scans Chromium-family profile Extension folders for a manifest named MyPipCam.
    static func detectInstalledExtensionID() -> String? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let support = home.appendingPathComponent("Library/Application Support")

        let roots: [URL] = [
            support.appendingPathComponent("Google/Chrome"),
            support.appendingPathComponent("Google/Chrome Canary"),
            support.appendingPathComponent("Google/Chrome Beta"),
            support.appendingPathComponent("Chromium"),
            support.appendingPathComponent("BraveSoftware/Brave-Browser"),
            support.appendingPathComponent("Microsoft Edge"),
            support.appendingPathComponent("Arc/User Data"),
            support.appendingPathComponent("Vivaldi"),
        ]

        var found: [String] = []

        for root in roots {
            guard let profiles = try? fm.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            for profile in profiles {
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
        }

        // Prefer the stable key ID when both that and an older unpacked ID exist.
        if found.contains(defaultExtensionID) {
            return defaultExtensionID
        }
        return found.first
    }

    private static func extensionDirectoryMatches(_ idDir: URL) -> Bool {
        let fm = FileManager.default
        guard let versions = try? fm.contentsOfDirectory(
            at: idDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return false }

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

    @MainActor
    private static func openInChromiumBrowser(_ url: URL) {
        // chrome-extension:// URLs are most reliable via `/usr/bin/open -a <App> <url>`.
        let appNames = [
            "Google Chrome",
            "Google Chrome Canary",
            "Arc",
            "Chromium",
            "Brave Browser",
            "Microsoft Edge",
            "Vivaldi",
        ]

        for name in appNames {
            if applicationExists(named: name), openURL(url, withApplicationNamed: name) {
                return
            }
        }

        let bundleIDs = [
            "com.google.Chrome",
            "com.google.Chrome.canary",
            "company.thebrowser.Browser",
            "org.chromium.Chromium",
            "com.brave.Browser",
            "com.microsoft.edgemac",
            "com.vivaldi.Vivaldi",
        ]

        for bundleID in bundleIDs {
            if let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = true
                NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: config)
                return
            }
        }

        NSWorkspace.shared.open(url)
    }

    private static func applicationExists(named name: String) -> Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID(forAppName: name) ?? "") != nil
            || FileManager.default.fileExists(atPath: "/Applications/\(name).app")
            || FileManager.default.fileExists(atPath: "\(NSHomeDirectory())/Applications/\(name).app")
    }

    private static func bundleID(forAppName name: String) -> String? {
        switch name {
        case "Google Chrome": return "com.google.Chrome"
        case "Google Chrome Canary": return "com.google.Chrome.canary"
        case "Arc": return "company.thebrowser.Browser"
        case "Chromium": return "org.chromium.Chromium"
        case "Brave Browser": return "com.brave.Browser"
        case "Microsoft Edge": return "com.microsoft.edgemac"
        case "Vivaldi": return "com.vivaldi.Vivaldi"
        default: return nil
        }
    }

    @discardableResult
    private static func openURL(_ url: URL, withApplicationNamed name: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", name, url.absoluteString]
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    @MainActor
    private static func openChromeExtensionsPage() {
        // Prefer opening extensions management via open -a; chrome:// may fail otherwise.
        let appNames = ["Google Chrome", "Google Chrome Canary", "Arc", "Brave Browser", "Microsoft Edge"]
        for name in appNames {
            if applicationExists(named: name),
               openURL(URL(string: "chrome://extensions")!, withApplicationNamed: name) {
                return
            }
        }
        if let url = URL(string: "chrome://extensions") {
            openInChromiumBrowser(url)
        }
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

        let home = fm.homeDirectoryForCurrentUser
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
    private static func showFirstOpenTip(openedURL: URL) {
        let alert = NSAlert()
        alert.messageText = "Opened Recording Library"
        alert.informativeText = """
        MyPipCam opened:

        \(openedURL.absoluteString)

        If Chrome shows a blank page or “extension not found”, your install may use a different extension ID (common for older unpacked loads). Use Set Extension ID… and paste the ID from chrome://extensions.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Set Extension ID…")
        if alert.runModal() == .alertSecondButtonReturn {
            promptForExtensionID(reason: .pageDidNotLoad, thenOpen: true)
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
}

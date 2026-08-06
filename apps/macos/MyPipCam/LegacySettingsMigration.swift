import Foundation

/// One-shot copy of appearance / device prefs from the pre-rename LoomCam
/// sandbox container into the current MyPipCam UserDefaults suite.
///
/// After LoomCam → MyPipCam, Open at Login can still launch an old `.app` that
/// reads `com.stevenmartinez.LoomCam` while `/Applications/MyPipCam.app` starts
/// empty. Migrating closes that gap once the new binary is what actually runs.
enum LegacySettingsMigration {
    static let legacyBundleID = "com.stevenmartinez.LoomCam"
    private static let didMigrateKey = "didMigrateLoomCamUserDefaults"

    /// Appearance, devices, library path, cloud-capture, and extension overrides.
    static let migratableKeys: [String] = [
        "borderPreset",
        "customBorderHex",
        "borderWidth",
        "showShadow",
        "mirrorCamera",
        "bubbleSize",
        "useWidescreen",
        "widescreenSize",
        "bubbleShape",
        "bubbleOpacity",
        "bubbleOriginX",
        "bubbleOriginY",
        "hasSavedBubbleOrigin",
        "chromeExtensionId",
        "chromeExtensionDistPath",
        "libraryFolderDisplayPath",
        BubbleSettings.libraryFolderBookmarkKey,
        "selectedCameraDeviceID",
        "selectedMicrophoneID",
        "cloudCaptureTarget",
        "cloudCaptureDisplayID",
        "cloudCaptureWindowID",
        "cloudIncludeSystemAudio",
        "cloudIncludeMicrophone",
        // Pre-rename color key (ignored by BubbleSettings if unused).
        "borderColor",
    ]

    /// Call once at launch, before `BubbleSettings` / managers read defaults.
    @discardableResult
    static func migrateIfNeeded() -> Bool {
        let dest = UserDefaults.standard
        if dest.bool(forKey: didMigrateKey) {
            return false
        }

        let source = loadLegacyDictionary()
        if source.isEmpty {
            // Only finish when the legacy prefs file is gone — if it exists but
            // was unreadable this launch (sandbox/TCC race), retry next time.
            if !legacyPlistExists() {
                dest.set(true, forKey: didMigrateKey)
            }
            return false
        }

        var copied = 0
        for key in migratableKeys {
            guard let value = source[key] else { continue }
            // Never overwrite keys the user already set in MyPipCam.
            if dest.object(forKey: key) != nil { continue }
            dest.set(value, forKey: key)
            copied += 1
        }

        dest.set(true, forKey: didMigrateKey)
        dest.synchronize()
        return copied > 0
    }

    private static func legacyPlistURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Containers")
            .appendingPathComponent(legacyBundleID)
            .appendingPathComponent("Data/Library/Preferences")
            .appendingPathComponent("\(legacyBundleID).plist")
    }

    private static func legacyPlistExists() -> Bool {
        FileManager.default.fileExists(atPath: legacyPlistURL().path)
    }

    private static func loadLegacyDictionary() -> [String: Any] {
        // 1) App-group style suite (usually empty for a renamed sandboxed app).
        if let suite = UserDefaults(suiteName: legacyBundleID) {
            let keys = migratableKeys.filter { suite.object(forKey: $0) != nil }
            if !keys.isEmpty {
                var dict: [String: Any] = [:]
                for key in keys {
                    if let value = suite.object(forKey: key) {
                        dict[key] = value
                    }
                }
                if !dict.isEmpty { return dict }
            }
        }

        // 2) Direct read of the old sandbox preferences plist (needs temporary
        //    home-relative read entitlement for Containers/…/LoomCam/…).
        let plistURL = legacyPlistURL()
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(
                  from: data,
                  options: [],
                  format: nil
              ) as? [String: Any]
        else {
            return [:]
        }
        return plist
    }
}

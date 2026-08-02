import AppKit

@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var launchAtLoginItem: NSMenuItem?
    private var revealLibraryItem: NSMenuItem?
    private var recordItem: NSMenuItem?
    private let loginItem: LoginItemManager
    private let settings: BubbleSettings
    private let libraryStore: LibraryFolderStore
    private let onQuit: () -> Void
    private let onShowBubble: () -> Void

    init(
        loginItem: LoginItemManager,
        settings: BubbleSettings,
        libraryStore: LibraryFolderStore? = nil,
        onShowBubble: @escaping () -> Void,
        onQuit: @escaping () -> Void
    ) {
        self.loginItem = loginItem
        self.settings = settings
        self.libraryStore = libraryStore ?? .shared
        self.onShowBubble = onShowBubble
        self.onQuit = onQuit
        super.init()
    }

    func install() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(
                systemSymbolName: "circle.inset.filled",
                accessibilityDescription: "MyPipCam"
            )
            button.toolTip = "MyPipCam"
        }

        let menu = NSMenu()
        menu.delegate = self

        let showItem = NSMenuItem(title: "Show Bubble", action: #selector(showBubble), keyEquivalent: "s")
        showItem.target = self
        menu.addItem(showItem)

        menu.addItem(NSMenuItem.separator())

        let recordItem = NSMenuItem(
            title: "Record…",
            action: #selector(toggleRecord),
            keyEquivalent: "r"
        )
        recordItem.target = self
        menu.addItem(recordItem)
        self.recordItem = recordItem

        menu.addItem(NSMenuItem.separator())

        let libraryItem = NSMenuItem(
            title: "Open Recording Library",
            action: #selector(openRecordingLibrary),
            keyEquivalent: "l"
        )
        libraryItem.target = self
        menu.addItem(libraryItem)

        let chooseItem = NSMenuItem(
            title: "Choose Recording Library…",
            action: #selector(chooseRecordingLibrary),
            keyEquivalent: ""
        )
        chooseItem.target = self
        menu.addItem(chooseItem)

        let revealItem = NSMenuItem(
            title: "Reveal Library in Finder",
            action: #selector(revealLibraryInFinder),
            keyEquivalent: ""
        )
        revealItem.target = self
        menu.addItem(revealItem)
        revealLibraryItem = revealItem

        menu.addItem(NSMenuItem.separator())

        let chromeItem = NSMenuItem(
            title: "Open in Chrome…",
            action: #selector(openInChrome),
            keyEquivalent: ""
        )
        chromeItem.target = self
        menu.addItem(chromeItem)

        let setIdItem = NSMenuItem(
            title: "Set Extension ID…",
            action: #selector(setExtensionID),
            keyEquivalent: ""
        )
        setIdItem.target = self
        menu.addItem(setIdItem)

        let installItem = NSMenuItem(
            title: "Install Chrome Extension…",
            action: #selector(installChromeExtension),
            keyEquivalent: ""
        )
        installItem.target = self
        menu.addItem(installItem)

        menu.addItem(NSMenuItem.separator())

        let loginItem = NSMenuItem(
            title: "Open at Login",
            action: #selector(toggleLaunchAtLogin),
            keyEquivalent: ""
        )
        loginItem.target = self
        menu.addItem(loginItem)
        launchAtLoginItem = loginItem

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit MyPipCam", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
        statusItem = item
        refreshLoginItemState()
        refreshLibraryMenuState()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshLoginItemState()
        refreshLibraryMenuState()
        refreshRecordMenuState()
    }

    private func refreshRecordMenuState() {
        if RecordingController.shared.isRecording {
            let s = RecordingController.shared.elapsedSeconds
            let stamp = String(format: "%d:%02d", s / 60, s % 60)
            recordItem?.title = "Stop Recording (\(stamp))"
        } else {
            recordItem?.title = "Record…"
        }
    }

    private func refreshLoginItemState() {
        loginItem.refresh()
        launchAtLoginItem?.state = loginItem.isEnabled ? .on : .off
        if loginItem.needsApproval {
            launchAtLoginItem?.title = "Open at Login (Approval Needed…)"
        } else {
            launchAtLoginItem?.title = "Open at Login"
        }
    }

    private func refreshLibraryMenuState() {
        revealLibraryItem?.isEnabled = libraryStore.hasLibrary
    }

    @objc private func showBubble() {
        onShowBubble()
    }

    @objc private func toggleRecord() {
        RecordingController.shared.toggleFromMenu()
    }

    @objc private func openRecordingLibrary() {
        LibraryWindowPresenter.open(store: libraryStore, settings: settings, chooseIfNeeded: true)
    }

    @objc private func chooseRecordingLibrary() {
        LibraryWindowPresenter.chooseFolder(store: libraryStore, settings: settings, openAfter: true)
    }

    @objc private func revealLibraryInFinder() {
        LibraryWindowPresenter.revealLibrary(store: libraryStore)
    }

    @objc private func openInChrome() {
        let override = settings.chromeExtensionId.trimmingCharacters(in: .whitespacesAndNewlines)
        ExtensionLibraryOpener.openRecordingLibrary(
            extensionID: override.isEmpty ? nil : override
        )
    }

    @objc private func setExtensionID() {
        ExtensionLibraryOpener.promptForExtensionID(reason: .manual, thenOpen: true)
        // Refresh @AppStorage-backed override so future opens use the pasted ID.
        settings.chromeExtensionId =
            UserDefaults.standard.string(forKey: "chromeExtensionId") ?? ""
    }

    @objc private func installChromeExtension() {
        ExtensionLibraryOpener.showInstallChromeExtensionHelp()
        settings.chromeExtensionId =
            UserDefaults.standard.string(forKey: "chromeExtensionId") ?? ""
    }

    @objc private func toggleLaunchAtLogin() {
        if loginItem.needsApproval {
            loginItem.openLoginItemsSettings()
            return
        }
        loginItem.toggle()
        refreshLoginItemState()
    }

    @objc private func quit() {
        onQuit()
    }
}

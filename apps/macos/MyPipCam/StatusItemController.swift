import AppKit

@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var launchAtLoginItem: NSMenuItem?
    private let loginItem: LoginItemManager
    private let onQuit: () -> Void
    private let onShowBubble: () -> Void

    init(
        loginItem: LoginItemManager,
        onShowBubble: @escaping () -> Void,
        onQuit: @escaping () -> Void
    ) {
        self.loginItem = loginItem
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
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshLoginItemState()
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

    @objc private func showBubble() {
        onShowBubble()
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

import SwiftUI
import AppKit

@main
struct MyPipCamApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var bubbleController: CameraBubbleController?
    private var statusItemController: StatusItemController?
    private let loginItem = LoginItemManager()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let bubble = CameraBubbleController(loginItem: loginItem)
        bubbleController = bubble
        bubble.show()

        statusItemController = StatusItemController(
            loginItem: loginItem,
            onShowBubble: { bubble.showAgain() },
            onQuit: { bubble.quit() }
        )
        statusItemController?.install()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

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
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--probe-screencapture") {
            NSApp.setActivationPolicy(.accessory)
            Task { @MainActor in
                await ScreenCloudRecorder.runLaunchProbe()
                NSApp.terminate(nil)
            }
            return
        }

        NSApp.setActivationPolicy(.accessory)
        // Detect reinstall / new code signature so Record can guide Screen Recording re-grant.
        RecordToCloudCoordinator.shared.recorder.noteLaunchIdentity()

        let bubble = CameraBubbleController(loginItem: loginItem)
        bubbleController = bubble
        bubble.show()

        statusItemController = StatusItemController(
            loginItem: loginItem,
            settings: bubble.settings,
            libraryStore: .shared,
            isBubbleVisible: { bubble.isBubbleVisible },
            onShowBubble: { bubble.showAgain() },
            onHideBubble: { bubble.hideBubble() },
            onQuit: { bubble.quit() }
        )
        statusItemController?.install()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

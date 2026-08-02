import AppKit
import Combine
import SwiftUI

@MainActor
final class CameraBubbleController: NSObject {
    private var panel: NSPanel?
    private let camera = CameraManager()
    private let microphone = MicrophoneManager()
    let settings = BubbleSettings()
    private let loginItem: LoginItemManager
    private var scrollMonitor: Any?
    private var sizeCancellable: AnyCancellable?
    private let padding: CGFloat = CameraBubbleView.shadowPadding

    init(loginItem: LoginItemManager) {
        self.loginItem = loginItem
        super.init()
    }

    func show() {
        let panel = BubblePanel(
            contentRect: NSRect(x: 0, y: 0, width: 100, height: 100),
            styleMask: [.borderless, .nonactivatingPanel, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.acceptsMouseMovedEvents = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isReleasedWhenClosed = false

        let rootView = CameraBubbleView(
            camera: camera,
            microphone: microphone,
            settings: settings,
            loginItem: loginItem,
            onQuit: { [weak self] in
                self?.quit()
            }
        )

        let hosting = NSHostingView(rootView: rootView)
        panel.contentView = hosting
        self.panel = panel

        applySize(CGFloat(settings.bubbleSize), animate: false)
        positionDefault(panel)
        panel.orderFrontRegardless()

        sizeCancellable = settings.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                // Defer so @AppStorage values are updated before we read them.
                DispatchQueue.main.async {
                    self.applySize(CGFloat(self.settings.bubbleSize), animate: true)
                }
            }

        installScrollResizeMonitor()
    }

    private func applySize(_ contentSize: CGFloat, animate: Bool) {
        guard let panel else { return }
        let padded = contentSize + padding
        var frame = panel.frame
        let midX = frame.midX
        let midY = frame.midY
        frame.size = NSSize(width: padded, height: padded)
        frame.origin = NSPoint(x: midX - padded / 2, y: midY - padded / 2)
        panel.setFrame(frame, display: true, animate: animate)
        panel.contentView?.frame = NSRect(origin: .zero, size: frame.size)
    }

    private func positionDefault(_ panel: NSPanel) {
        guard let screen = NSScreen.main else {
            panel.center()
            return
        }
        let visible = screen.visibleFrame
        let windowSize = panel.frame.size
        panel.setFrameOrigin(
            NSPoint(
                x: visible.maxX - windowSize.width - 36,
                y: visible.minY + 36
            )
        )
    }

    private func installScrollResizeMonitor() {
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self, let panel = self.panel, event.window == panel else {
                return event
            }

            let delta = event.scrollingDeltaY
            guard abs(delta) > 0.2 else { return event }

            let next = min(420, max(140, self.settings.bubbleSize + Double(delta) * 0.6))
            if abs(next - self.settings.bubbleSize) >= 1 {
                self.settings.bubbleSize = next
            }
            return nil
        }
    }

    func showAgain() {
        panel?.orderFrontRegardless()
    }

    func quit() {
        camera.stopSession()
        if let monitor = scrollMonitor {
            NSEvent.removeMonitor(monitor)
            scrollMonitor = nil
        }
        sizeCancellable?.cancel()
        panel?.close()
        NSApp.terminate(nil)
    }
}

final class BubblePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

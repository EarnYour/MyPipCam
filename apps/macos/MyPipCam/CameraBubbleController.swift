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
    private var moveObserver: NSObjectProtocol?
    private var lastContentSize: CGSize = .zero
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
            onHide: { [weak self] in
                self?.hideBubble()
            },
            onQuit: { [weak self] in
                self?.quit()
            }
        )

        let hosting = NSHostingView(rootView: rootView)
        panel.contentView = hosting
        self.panel = panel

        applySize(animate: false)
        restoreOrDefaultPosition(panel)
        panel.orderFrontRegardless()
        installMoveObserver(for: panel)

        RecordToCloudCoordinator.shared.bind(
            camera: camera,
            microphone: microphone,
            settings: settings
        )

        sizeCancellable = settings.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                // Defer so @AppStorage values are updated before we read them.
                DispatchQueue.main.async {
                    self.applySize(animate: true)
                }
            }

        installScrollResizeMonitor()
    }

    private func restoreOrDefaultPosition(_ panel: NSPanel) {
        if let origin = settings.savedBubbleOrigin {
            panel.setFrameOrigin(origin)
            ensureOnScreen(panel)
            return
        }
        positionDefault(panel)
    }

    private func installMoveObserver(for panel: NSPanel) {
        if let moveObserver {
            NotificationCenter.default.removeObserver(moveObserver)
        }
        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            guard let self, let panel = self.panel else { return }
            // Persist after drag / programmatic moves that leave the bubble visible.
            self.settings.savedBubbleOrigin = panel.frame.origin
        }
    }

    private func applySize(animate: Bool) {
        guard let panel else { return }
        let screen = panel.screen ?? NSScreen.main
        let content = settings.contentSize(on: screen)
        let paddedWidth = content.width + padding
        let paddedHeight = content.height + padding
        let sizeChanged =
            abs(lastContentSize.width - content.width) > 0.5
            || abs(lastContentSize.height - content.height) > 0.5
        guard sizeChanged || lastContentSize == .zero else {
            // Appearance-only settings changes — keep the current panel frame.
            return
        }

        var frame = panel.frame
        let midX = frame.midX
        let midY = frame.midY
        frame.size = NSSize(width: paddedWidth, height: paddedHeight)
        if settings.useWidescreen, let visible = screen?.visibleFrame {
            // Center when entering / resizing widescreen; clamp to the visible frame.
            frame.origin = NSPoint(
                x: visible.midX - paddedWidth / 2,
                y: visible.midY - paddedHeight / 2
            )
            frame.origin.x = min(max(frame.origin.x, visible.minX), visible.maxX - paddedWidth)
            frame.origin.y = min(max(frame.origin.y, visible.minY), visible.maxY - paddedHeight)
        } else {
            frame.origin = NSPoint(x: midX - paddedWidth / 2, y: midY - paddedHeight / 2)
        }
        lastContentSize = content
        panel.setFrame(frame, display: true, animate: animate)
        panel.contentView?.frame = NSRect(origin: .zero, size: frame.size)
        settings.savedBubbleOrigin = panel.frame.origin
    }

    private func positionDefault(_ panel: NSPanel) {
        guard let screen = NSScreen.main else {
            panel.center()
            return
        }
        let visible = screen.visibleFrame
        let windowSize = panel.frame.size
        if settings.useWidescreen {
            // Center the large 16:9 panel on the screen.
            panel.setFrameOrigin(
                NSPoint(
                    x: visible.midX - windowSize.width / 2,
                    y: visible.midY - windowSize.height / 2
                )
            )
            return
        }
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
            // Widescreen uses fixed 16:9 presets — ignore scroll resize.
            guard !self.settings.useWidescreen else { return event }

            let delta = event.scrollingDeltaY
            guard abs(delta) > 0.2 else { return event }

            let next = min(420, max(140, self.settings.bubbleSize + Double(delta) * 0.6))
            if abs(next - self.settings.bubbleSize) >= 1 {
                self.settings.bubbleSize = next
            }
            return nil
        }
    }

    /// Whether the floating bubble window is currently on-screen.
    var isBubbleVisible: Bool {
        panel?.isVisible == true && !NSApp.isHidden
    }

    /// Hide the bubble without quitting (menu bar icon stays).
    func hideBubble() {
        if let panel {
            settings.savedBubbleOrigin = panel.frame.origin
        }
        panel?.orderOut(nil)
    }

    /// Bring the bubble back after Hide, Cmd+H, Cmd+W, or an off-screen drag.
    func showAgain() {
        if NSApp.isHidden {
            NSApp.unhide(nil)
        }

        guard let panel else {
            show()
            return
        }

        // Closed panels (e.g. Cmd+W) keep the NSPanel when isReleasedWhenClosed is false,
        // but SwiftUI hosting can end up blank — recreate if the content view is gone.
        if panel.contentView == nil {
            panel.close()
            self.panel = nil
            show()
            return
        }

        ensureOnScreen(panel)
        panel.alphaValue = 1
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.orderFrontRegardless()
        // Nonactivating panels sometimes need an explicit key pass to paint again.
        panel.makeKeyAndOrderFront(nil)

        if !camera.isRunning {
            Task { await camera.requestAccessAndStart() }
        }
    }

    /// Clamp the panel into a visible screen frame (active mouse screen preferred).
    private func ensureOnScreen(_ panel: NSPanel) {
        let mouse = NSEvent.mouseLocation
        let screen =
            NSScreen.screens.first(where: { $0.frame.contains(mouse) })
            ?? panel.screen
            ?? NSScreen.main
        guard let screen else {
            positionDefault(panel)
            return
        }

        let visible = screen.visibleFrame
        var frame = panel.frame

        // Completely outside the destination screen → snap to default corner.
        let intersects = frame.intersects(visible.insetBy(dx: -8, dy: -8))
        if !intersects || frame.width < 40 || frame.height < 40 {
            applySize(animate: false)
            positionDefault(panel)
            // Reposition onto the mouse's screen, not whichever screen show() used.
            if screen != NSScreen.main {
                var origin = panel.frame.origin
                if settings.useWidescreen {
                    origin = NSPoint(
                        x: visible.midX - panel.frame.width / 2,
                        y: visible.midY - panel.frame.height / 2
                    )
                } else {
                    origin = NSPoint(
                        x: visible.maxX - panel.frame.width - 36,
                        y: visible.minY + 36
                    )
                }
                panel.setFrameOrigin(origin)
            }
            return
        }

        // Partially off-screen → clamp.
        frame.origin.x = min(max(frame.origin.x, visible.minX), visible.maxX - frame.width)
        frame.origin.y = min(max(frame.origin.y, visible.minY), visible.maxY - frame.height)
        panel.setFrame(frame, display: true)
        settings.savedBubbleOrigin = panel.frame.origin
    }

    func quit() {
        if RecordingController.shared.isRecording {
            Task {
                await RecordingController.shared.stopRecording(reveal: false)
                self.finishQuit()
            }
            return
        }
        finishQuit()
    }

    private func finishQuit() {
        if let panel {
            settings.savedBubbleOrigin = panel.frame.origin
        }
        camera.stopSession()
        if let monitor = scrollMonitor {
            NSEvent.removeMonitor(monitor)
            scrollMonitor = nil
        }
        sizeCancellable?.cancel()
        if let moveObserver {
            NotificationCenter.default.removeObserver(moveObserver)
            self.moveObserver = nil
        }
        panel?.close()
        NSApp.terminate(nil)
    }
}

final class BubblePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func performClose(_ sender: Any?) {
        // Cmd+W / performClose should hide, not destroy — Show Bubble can restore.
        orderOut(nil)
    }
}

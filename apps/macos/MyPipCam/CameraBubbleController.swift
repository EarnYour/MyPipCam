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
            onQuit: { [weak self] in
                self?.quit()
            }
        )

        let hosting = NSHostingView(rootView: rootView)
        panel.contentView = hosting
        self.panel = panel

        applySize(animate: false)
        positionDefault(panel)
        panel.orderFrontRegardless()

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
            // Widescreen is a fixed ~80% / 16:9 layout — ignore scroll resize.
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

    func showAgain() {
        panel?.orderFrontRegardless()
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

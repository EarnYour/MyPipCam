import AppKit
import SwiftUI

struct CameraBubbleView: View {
    @ObservedObject var camera: CameraManager
    @ObservedObject var settings: BubbleSettings
    @ObservedObject var loginItem: LoginItemManager
    @State private var showControls = false
    @State private var showBorderPopover = false
    @State private var dismissMonitors: [Any] = []
    var onQuit: () -> Void

    /// Extra space around the bubble so the soft circular shadow isn't clipped.
    static let shadowPadding: CGFloat = 48

    private var bubbleSize: CGFloat {
        CGFloat(settings.bubbleSize)
    }

    var body: some View {
        ZStack {
            bubble
                .frame(width: bubbleSize, height: bubbleSize)

            Group {
                if showControls {
                    controlsBar
                } else {
                    dotsButton
                }
            }
            .offset(y: bubbleSize * 0.28)
            .animation(.easeInOut(duration: 0.18), value: showControls)
        }
        .frame(
            width: bubbleSize + Self.shadowPadding,
            height: bubbleSize + Self.shadowPadding
        )
        .contentShape(Rectangle())
        .contextMenu { menuContent }
        .onAppear {
            Task { await camera.requestAccessAndStart() }
        }
        .onChange(of: showControls) { _, expanded in
            if expanded {
                installDismissMonitors()
            } else {
                removeDismissMonitors()
            }
        }
        .onChange(of: showBorderPopover) { _, open in
            // Keep controls open while the border popover is up.
            if open {
                showControls = true
            }
        }
        .onDisappear {
            removeDismissMonitors()
        }
    }

    private var bubble: some View {
        ZStack {
            // Soft circular shadow drawn as blurred circles — avoids
            // the square shadow cast by AVCaptureVideoPreviewLayer.
            if settings.showShadow {
                // Wide ambient falloff
                Circle()
                    .fill(Color.black.opacity(0.42))
                    .frame(width: bubbleSize * 0.98, height: bubbleSize * 0.98)
                    .blur(radius: 14)
                    .offset(y: 8)

                // Tighter contact shadow for Loom-like presence
                Circle()
                    .fill(Color.black.opacity(0.55))
                    .frame(width: bubbleSize * 0.94, height: bubbleSize * 0.94)
                    .blur(radius: 7)
                    .offset(y: 5)
            }

            ZStack {
                Circle()
                    .fill(Color.black.opacity(0.35))

                if camera.authorizationStatus == .authorized && camera.errorMessage == nil {
                    CameraPreviewView(session: camera.session, mirrored: settings.mirrorCamera)
                } else {
                    placeholder
                }
            }
            .frame(width: bubbleSize, height: bubbleSize)
            .clipShape(Circle())

            if settings.effectiveBorderWidth > 0 {
                Circle()
                    .strokeBorder(settings.resolvedBorderColor, lineWidth: settings.effectiveBorderWidth)
            }
        }
    }

    private var placeholder: some View {
        VStack(spacing: 8) {
            Image(systemName: "video.slash.fill")
                .font(.system(size: 28, weight: .semibold))
            Text(camera.errorMessage ?? "Waiting for camera…")
                .font(.system(size: 11, weight: .medium))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 18)
        }
        .foregroundStyle(.white.opacity(0.9))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.12, green: 0.13, blue: 0.16))
    }

    /// Faint always-visible affordance — click to reveal the full toolbar.
    private var dotsButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) {
                showControls = true
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.white.opacity(0.7))
                .frame(width: 28, height: 18)
                .background(
                    Capsule()
                        .fill(Color.black.opacity(0.38))
                )
                .overlay(
                    Capsule()
                        .strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5)
                )
        }
        .buttonStyle(.plain)
        .help("Show controls")
        .accessibilityLabel("Show controls")
    }

    private var controlsBar: some View {
        HStack(spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    showControls = false
                    showBorderPopover = false
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 12, weight: .bold))
            }
            .help("Hide controls")

            Menu {
                ForEach(camera.devices, id: \.uniqueID) { device in
                    Button {
                        camera.selectedDeviceID = device.uniqueID
                    } label: {
                        if device.uniqueID == camera.selectedDeviceID {
                            Label(device.localizedName, systemImage: "checkmark")
                        } else {
                            Text(device.localizedName)
                        }
                    }
                }
            } label: {
                Image(systemName: "video.fill")
                    .font(.system(size: 12, weight: .semibold))
            }

            Button {
                showBorderPopover.toggle()
            } label: {
                Image(systemName: "paintpalette.fill")
                    .font(.system(size: 12, weight: .semibold))
            }
            .popover(isPresented: $showBorderPopover, arrowEdge: .top) {
                BorderColorPopover(settings: settings)
            }
            .help("Border color")

            Button {
                settings.mirrorCamera.toggle()
            } label: {
                Image(systemName: "arrow.left.and.right.righttriangle.left.righttriangle.right.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .opacity(settings.mirrorCamera ? 1 : 0.55)
            }
            .help("Mirror camera")

            Button {
                settings.showShadow.toggle()
            } label: {
                Image(systemName: settings.showShadow ? "circle.bottomhalf.filled" : "circle")
                    .font(.system(size: 12, weight: .semibold))
                    .opacity(settings.showShadow ? 1 : 0.55)
            }
            .help(settings.showShadow ? "Hide shadow" : "Show shadow")

            Button(role: .destructive, action: onQuit) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
            }
            .help("Quit MyPipCam")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .transition(.opacity)
    }

    @ViewBuilder
    private var menuContent: some View {
        Menu("Camera") {
            ForEach(camera.devices, id: \.uniqueID) { device in
                Button(device.localizedName) {
                    camera.selectedDeviceID = device.uniqueID
                }
            }
            Divider()
            Button("Refresh Cameras") {
                camera.refreshDevices()
            }
        }

        Menu("Border") {
            ForEach(BorderPreset.allCases.filter { $0 != .custom }) { preset in
                Button(preset.label) {
                    settings.applyPreset(preset)
                }
            }
            Divider()
            Button("Custom Hex…") {
                showControls = true
                showBorderPopover = true
            }
        }

        Toggle("Soft Drop Shadow", isOn: $settings.showShadow)
        Toggle("Mirror Camera", isOn: $settings.mirrorCamera)
        Toggle("Open at Login", isOn: loginAtStartupBinding)

        Menu("Size") {
            Button("Small") { settings.bubbleSize = 160 }
            Button("Medium") { settings.bubbleSize = 220 }
            Button("Large") { settings.bubbleSize = 300 }
            Button("XL") { settings.bubbleSize = 380 }
        }

        Divider()
        Button("Quit MyPipCam", role: .destructive, action: onQuit)
    }

    private var loginAtStartupBinding: Binding<Bool> {
        Binding(
            get: { loginItem.isEnabled },
            set: { loginItem.setEnabled($0) }
        )
    }

    // MARK: - Dismiss monitors (Escape / click outside)

    private func installDismissMonitors() {
        removeDismissMonitors()

        let keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { // Escape
                self.dismissControls()
                return nil
            }
            return event
        }

        // Clicks in other apps dismiss the toolbar.
        let globalMouse = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { _ in
            guard !self.showBorderPopover else { return }
            self.dismissControls()
        }

        // Clicks in this app that aren't on the bubble panel (e.g. menu bar).
        let localMouse = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
            guard !self.showBorderPopover else { return event }
            if let window = event.window, window is BubblePanel {
                return event
            }
            // Allow popover / menu windows attached to the bubble.
            if let window = event.window, window.level != .normal, !(window is BubblePanel) {
                // Still dismiss for unrelated app windows; keep transient UI.
                if window.className.contains("Popover") || window.className.contains("Menu") {
                    return event
                }
            }
            if !(event.window is BubblePanel) {
                self.dismissControls()
            }
            return event
        }

        dismissMonitors = [keyMonitor, globalMouse, localMouse].compactMap { $0 }
    }

    private func removeDismissMonitors() {
        for monitor in dismissMonitors {
            NSEvent.removeMonitor(monitor)
        }
        dismissMonitors = []
    }

    private func dismissControls() {
        DispatchQueue.main.async {
            withAnimation(.easeInOut(duration: 0.18)) {
                self.showControls = false
                self.showBorderPopover = false
            }
        }
    }
}

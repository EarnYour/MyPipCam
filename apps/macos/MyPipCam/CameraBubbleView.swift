import AppKit
import SwiftUI

struct CameraBubbleView: View {
    @ObservedObject var camera: CameraManager
    @ObservedObject var microphone: MicrophoneManager
    @ObservedObject var settings: BubbleSettings
    @ObservedObject var loginItem: LoginItemManager
    @State private var showControls = false
    @State private var showBorderPopover = false
    @State private var isHovered = false
    @StateObject private var dismissHelper = ControlsDismissHelper()
    var onQuit: () -> Void

    /// Extra space around the bubble so the soft circular shadow isn't clipped.
    static let shadowPadding: CGFloat = 48

    private var contentSize: CGSize {
        settings.contentSize()
    }

    private var bubbleWidth: CGFloat { contentSize.width }
    private var bubbleHeight: CGFloat { contentSize.height }

    private var squareCornerRadius: CGFloat {
        settings.cornerRadius(for: contentSize)
    }

    var body: some View {
        ZStack {
            bubble
                .frame(width: bubbleWidth, height: bubbleHeight)

            if showControls {
                controlsBar
                    .offset(y: bubbleHeight * 0.34)
                    .transition(.opacity)
            } else if isHovered {
                dotsButton
                    // Near the bottom edge of the circle — subtle, hover-only.
                    .offset(y: bubbleHeight * 0.42)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: showControls)
        .animation(.easeInOut(duration: 0.15), value: isHovered)
        .frame(
            width: bubbleWidth + Self.shadowPadding,
            height: bubbleHeight + Self.shadowPadding
        )
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
        .contextMenu { menuContent }
        .onAppear {
            Task { await camera.requestAccessAndStart() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // User may have just enabled Camera in System Settings.
            Task { await camera.requestAccessAndStart() }
        }
        .onChange(of: showControls) { _, expanded in
            if expanded {
                Task { await microphone.ensureAccess() }
                dismissHelper.install(
                    isPopoverOpen: { showBorderPopover },
                    onDismiss: {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            showControls = false
                            showBorderPopover = false
                        }
                    }
                )
            } else {
                dismissHelper.remove()
            }
        }
        .onChange(of: showBorderPopover) { _, open in
            // Keep controls open while the border popover is up.
            if open {
                showControls = true
            }
        }
        .onDisappear {
            dismissHelper.remove()
        }
    }

    private var bubble: some View {
        ZStack {
            // Soft shadow drawn as blurred shapes — avoids the square
            // shadow cast by AVCaptureVideoPreviewLayer.
            if settings.showShadow {
                shadowBlob(opacity: 0.42, scale: 0.98, blur: 14, y: 8)
                shadowBlob(opacity: 0.55, scale: 0.94, blur: 7, y: 5)
            }

            ZStack {
                Group {
                    switch settings.bubbleShape {
                    case .circle:
                        Circle().fill(Color.black.opacity(0.35))
                    case .square:
                        RoundedRectangle(cornerRadius: squareCornerRadius, style: .continuous)
                            .fill(Color.black.opacity(0.35))
                    }
                }

                if camera.authorizationStatus == .authorized && camera.errorMessage == nil {
                    CameraPreviewView(session: camera.session, mirrored: settings.mirrorCamera)
                } else {
                    placeholder
                }
            }
            .frame(width: bubbleWidth, height: bubbleHeight)
            .modifier(BubbleClipModifier(shape: settings.bubbleShape, cornerRadius: squareCornerRadius))

            if settings.effectiveBorderWidth > 0 {
                Group {
                    switch settings.bubbleShape {
                    case .circle:
                        Circle()
                            .strokeBorder(settings.resolvedBorderColor, lineWidth: settings.effectiveBorderWidth)
                    case .square:
                        RoundedRectangle(cornerRadius: squareCornerRadius, style: .continuous)
                            .strokeBorder(settings.resolvedBorderColor, lineWidth: settings.effectiveBorderWidth)
                    }
                }
            }
        }
        .opacity(settings.effectiveBubbleOpacity)
    }

    @ViewBuilder
    private func shadowBlob(opacity: Double, scale: CGFloat, blur: CGFloat, y: CGFloat) -> some View {
        Group {
            switch settings.bubbleShape {
            case .circle:
                Circle()
                    .fill(Color.black.opacity(opacity))
            case .square:
                RoundedRectangle(cornerRadius: squareCornerRadius * scale, style: .continuous)
                    .fill(Color.black.opacity(opacity))
            }
        }
        .frame(width: bubbleWidth * scale, height: bubbleHeight * scale)
        .blur(radius: blur)
        .offset(y: y)
    }

    private var placeholder: some View {
        VStack(spacing: 8) {
            Image(systemName: "video.slash.fill")
                .font(.system(size: 28, weight: .semibold))
            Text(camera.errorMessage ?? "Waiting for camera…")
                .font(.system(size: 11, weight: .medium))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 18)

            if camera.needsCameraPermissionInSettings {
                Button("Open System Settings") {
                    camera.openSystemCameraSettings()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .padding(.top, 2)
            }
        }
        .foregroundStyle(.white.opacity(0.9))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.12, green: 0.13, blue: 0.16))
    }

    /// Hover-only affordance near the bottom edge — click to reveal the full toolbar.
    private var dotsButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) {
                showControls = true
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white.opacity(0.55))
                .frame(width: 26, height: 16)
                .background(
                    Capsule()
                        .fill(Color.black.opacity(0.28))
                )
                .overlay(
                    Capsule()
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
                )
        }
        .buttonStyle(.plain)
        .help("Show controls")
        .accessibilityLabel("Show controls")
    }

    /// Tight toolbar: camera · mic · appearance · mirror · close.
    /// Dismiss via Escape / click outside (no redundant collapse dots).
    private var controlsBar: some View {
        HStack(spacing: 10) {
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
            .help("Camera")

            Menu {
                ForEach(microphone.devices, id: \.uniqueID) { device in
                    Button {
                        Task {
                            await microphone.ensureAccess()
                            microphone.selectedDeviceID = device.uniqueID
                        }
                    } label: {
                        if device.uniqueID == microphone.selectedDeviceID {
                            Label(device.localizedName, systemImage: "checkmark")
                        } else {
                            Text(device.localizedName)
                        }
                    }
                }
                if microphone.devices.isEmpty {
                    Text("No microphones found")
                }
                if microphone.needsMicrophonePermissionInSettings {
                    Divider()
                    Button("Open Microphone Settings…") {
                        microphone.openSystemMicrophoneSettings()
                    }
                }
            } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 12, weight: .semibold))
            }
            .help("Microphone")

            Button {
                showBorderPopover.toggle()
            } label: {
                Image(systemName: "paintpalette.fill")
                    .font(.system(size: 12, weight: .semibold))
            }
            .popover(isPresented: $showBorderPopover, arrowEdge: .top) {
                BorderColorPopover(settings: settings)
            }
            .help("Appearance")

            Button {
                settings.mirrorCamera.toggle()
            } label: {
                Image(systemName: "arrow.left.and.right.righttriangle.left.righttriangle.right.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .opacity(settings.mirrorCamera ? 1 : 0.55)
            }
            .help("Mirror camera")

            Button {
                showControls = false
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
            }
            .help("Close menu")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .transition(.opacity)
    }

    /// Power-user alternate; appearance lives in one place (popover), not split across menus.
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
            if camera.needsCameraPermissionInSettings {
                Button("Open Camera Settings…") {
                    camera.openSystemCameraSettings()
                }
            }
        }

        Menu("Microphone") {
            ForEach(microphone.devices, id: \.uniqueID) { device in
                Button {
                    Task {
                        await microphone.ensureAccess()
                        microphone.selectedDeviceID = device.uniqueID
                    }
                } label: {
                    if device.uniqueID == microphone.selectedDeviceID {
                        Label(device.localizedName, systemImage: "checkmark")
                    } else {
                        Text(device.localizedName)
                    }
                }
            }
            if microphone.devices.isEmpty {
                Text("No microphones found")
            }
            Divider()
            Button("Refresh Microphones") {
                Task {
                    await microphone.ensureAccess()
                    microphone.refreshDevices()
                }
            }
            if microphone.needsMicrophonePermissionInSettings {
                Button("Open Microphone Settings…") {
                    microphone.openSystemMicrophoneSettings()
                }
            }
        }
        .onAppear {
            Task { await microphone.ensureAccess() }
        }

        Button("Appearance…") {
            showControls = true
            showBorderPopover = true
        }

        Menu("Shape") {
            ForEach(BubbleShape.allCases) { shape in
                Button {
                    settings.bubbleShape = shape
                } label: {
                    if settings.bubbleShape == shape {
                        Label(shape.label, systemImage: "checkmark")
                    } else {
                        Text(shape.label)
                    }
                }
            }
        }

        Menu("Size") {
            sizeMenuButton("Small", squareSize: 160)
            sizeMenuButton("Medium", squareSize: 220)
            sizeMenuButton("Large", squareSize: 300)
            sizeMenuButton("XL", squareSize: 380)
            Divider()
            Button {
                settings.applyWidescreen()
            } label: {
                if settings.useWidescreen {
                    Label("Widescreen 16:9", systemImage: "checkmark")
                } else {
                    Text("Widescreen 16:9")
                }
            }
        }

        Toggle("Mirror Camera", isOn: $settings.mirrorCamera)

        Divider()
        Button("Open Recording Library") {
            LibraryWindowPresenter.open(settings: settings, chooseIfNeeded: true)
        }
        Button("Choose Recording Library…") {
            LibraryWindowPresenter.chooseFolder(settings: settings, openAfter: true)
        }
        Button("Reveal Library in Finder") {
            LibraryWindowPresenter.revealLibrary()
        }
        .disabled(!LibraryFolderStore.shared.hasLibrary)

        Divider()
        Button("Open in Chrome…") {
            let override = settings.chromeExtensionId.trimmingCharacters(in: .whitespacesAndNewlines)
            ExtensionLibraryOpener.openRecordingLibrary(
                extensionID: override.isEmpty ? nil : override
            )
        }
        Button("Set Extension ID…") {
            ExtensionLibraryOpener.promptForExtensionID(reason: .manual, thenOpen: true)
            settings.chromeExtensionId =
                UserDefaults.standard.string(forKey: "chromeExtensionId") ?? ""
        }
        Button("Install Chrome Extension…") {
            ExtensionLibraryOpener.showInstallChromeExtensionHelp()
            settings.chromeExtensionId =
                UserDefaults.standard.string(forKey: "chromeExtensionId") ?? ""
        }

        Divider()
        Toggle("Open at Login", isOn: loginAtStartupBinding)
        Button("Quit MyPipCam", role: .destructive, action: onQuit)
    }

    private var loginAtStartupBinding: Binding<Bool> {
        Binding(
            get: { loginItem.isEnabled },
            set: { loginItem.setEnabled($0) }
        )
    }

    @ViewBuilder
    private func sizeMenuButton(_ title: String, squareSize: Double) -> some View {
        let selected = !settings.useWidescreen && abs(settings.bubbleSize - squareSize) < 0.5
        Button {
            settings.applySquareSize(squareSize)
        } label: {
            if selected {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }
}

private struct BubbleClipModifier: ViewModifier {
    let shape: BubbleShape
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        switch shape {
        case .circle:
            content.clipShape(Circle())
        case .square:
            content.clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }
}

/// AppKit event monitors for dismissing the click-revealed controls toolbar.
@MainActor
private final class ControlsDismissHelper: ObservableObject {
    private var monitors: [Any] = []

    func install(isPopoverOpen: @escaping () -> Bool, onDismiss: @escaping () -> Void) {
        remove()

        let dismiss = {
            DispatchQueue.main.async {
                onDismiss()
            }
        }

        if let keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { event in
            if event.keyCode == 53 { // Escape
                dismiss()
                return nil
            }
            return event
        }) {
            monitors.append(keyMonitor)
        }

        if let globalMouse = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown],
            handler: { _ in
                guard !isPopoverOpen() else { return }
                dismiss()
            }
        ) {
            monitors.append(globalMouse)
        }

        if let localMouse = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown],
            handler: { event in
                guard !isPopoverOpen() else { return event }
                if event.window is BubblePanel { return event }

                let className = event.window?.className ?? ""
                if className.contains("Popover") || className.contains("Menu") {
                    return event
                }

                if !(event.window is BubblePanel) {
                    dismiss()
                }
                return event
            }
        ) {
            monitors.append(localMouse)
        }
    }

    func remove() {
        for monitor in monitors {
            NSEvent.removeMonitor(monitor)
        }
        monitors = []
    }

    deinit {
        for monitor in monitors {
            NSEvent.removeMonitor(monitor)
        }
    }
}

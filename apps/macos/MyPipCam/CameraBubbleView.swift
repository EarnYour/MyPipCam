import SwiftUI

struct CameraBubbleView: View {
    @ObservedObject var camera: CameraManager
    @ObservedObject var settings: BubbleSettings
    @ObservedObject var loginItem: LoginItemManager
    @State private var showControls = false
    @State private var showBorderPopover = false
    var onQuit: () -> Void

    private var bubbleSize: CGFloat {
        CGFloat(settings.bubbleSize)
    }

    var body: some View {
        ZStack {
            bubble
                .frame(width: bubbleSize, height: bubbleSize)

            if showControls {
                controlsBar
                    .offset(y: bubbleSize * 0.28)
                    .transition(.opacity)
            }
        }
        .frame(width: bubbleSize + 28, height: bubbleSize + 28)
        .contentShape(Rectangle())
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.18)) {
                showControls = hovering
            }
        }
        .contextMenu { menuContent }
        .onAppear {
            Task { await camera.requestAccessAndStart() }
        }
    }

    private var bubble: some View {
        ZStack {
            // Soft circular shadow drawn as a blurred circle — avoids
            // the square shadow cast by AVCaptureVideoPreviewLayer.
            if settings.showShadow {
                Circle()
                    .fill(Color.black.opacity(0.32))
                    .frame(width: bubbleSize * 0.96, height: bubbleSize * 0.96)
                    .blur(radius: 5)
                    .offset(y: 3)
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
}

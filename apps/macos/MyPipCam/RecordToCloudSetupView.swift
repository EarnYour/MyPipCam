import AppKit
import SwiftUI

struct RecordToCloudSetupView: View {
    @ObservedObject var camera: CameraManager
    @ObservedObject var microphone: MicrophoneManager
    @ObservedObject var settings: BubbleSettings
    @ObservedObject var recorder: ScreenCloudRecorder

    var onCancel: () -> Void
    var onStart: (RecordToCloudCoordinator.StartConfig) async -> Void

    @AppStorage("cloudCaptureTarget") private var captureTargetRaw: String = CloudCaptureTarget.screen.rawValue
    @AppStorage("cloudCaptureDisplayID") private var savedDisplayID: Int = 0
    @AppStorage("cloudCaptureWindowID") private var savedWindowID: Int = 0
    @AppStorage("cloudIncludeSystemAudio") private var includeSystemAudio = true
    @AppStorage("cloudIncludeMicrophone") private var includeMicrophone = true

    @State private var selectedDisplayID: CGDirectDisplayID = 0
    @State private var selectedWindowID: CGWindowID = 0
    @State private var isStarting = false
    @State private var localError: String?

    private let brand = Color(red: 1, green: 0.369, blue: 0.161)

    private var captureTarget: CloudCaptureTarget {
        CloudCaptureTarget(rawValue: captureTargetRaw) ?? .screen
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    captureSection
                    deviceSection
                    audioSection
                    destinationSection
                    if let localError {
                        Text(localError)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color(red: 0.75, green: 0.2, blue: 0.2))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let recorderError = recorder.errorMessage {
                        Text(recorderError)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color(red: 0.75, green: 0.2, blue: 0.2))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(20)
            }
            Divider()
            footer
        }
        .frame(minWidth: 420, minHeight: 520)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            Task {
                await camera.requestAccessAndStart()
                await microphone.ensureAccess()
                _ = recorder.ensureScreenCaptureAccess()
                await recorder.refreshShareableContent()
                restoreSelections()
            }
        }
        .onChange(of: recorder.displays) { _, _ in restoreSelections() }
        .onChange(of: recorder.windows) { _, _ in restoreSelections() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Record")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(brand)
            Text("Capture your screen or a window with the floating camera PiP, then save into the same library folder Chrome uses (Drive sync via the extension).")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
    }

    private var captureSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("What to record")
            HStack(spacing: 8) {
                ForEach(CloudCaptureTarget.allCases) { target in
                    captureChip(target)
                }
            }

            switch captureTarget {
            case .screen:
                Picker("Display", selection: $selectedDisplayID) {
                    ForEach(recorder.displays) { display in
                        Text("\(display.name) (\(display.width)×\(display.height))")
                            .tag(display.id)
                    }
                }
                .labelsHidden()
                Text("The floating camera bubble stays on top and is included in Screen capture.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            case .window:
                if recorder.windows.isEmpty {
                    Text("No capturable windows found. Open the app you want to record, then refresh.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    Button("Refresh Windows") {
                        Task { await recorder.refreshShareableContent() }
                    }
                } else {
                    Picker("Window", selection: $selectedWindowID) {
                        ForEach(recorder.windows) { window in
                            Text(window.label)
                                .tag(window.id)
                        }
                    }
                    .labelsHidden()
                }
                Text("Window mode records only that window. Prefer Screen for desktop + PiP. Pick a browser window for tab-like capture.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            case .tab:
                Text("True Chrome tab capture isn’t available in the desktop app. Use Window and pick your browser, or record in the Chrome extension.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open Chrome Extension Library…") {
                    let override = settings.chromeExtensionId.trimmingCharacters(in: .whitespacesAndNewlines)
                    ExtensionLibraryOpener.openRecordingLibrary(
                        extensionID: override.isEmpty ? nil : override
                    )
                }
            }
        }
    }

    private func captureChip(_ target: CloudCaptureTarget) -> some View {
        let selected = captureTarget == target
        return Button {
            captureTargetRaw = target.rawValue
            localError = nil
        } label: {
            Text(target.label)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(selected ? brand.opacity(0.18) : Color.primary.opacity(0.06))
                )
                .overlay(
                    Capsule().strokeBorder(
                        selected ? brand.opacity(0.7) : Color.primary.opacity(0.08),
                        lineWidth: 1
                    )
                )
                .opacity(target.isAvailable || target == .tab ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .help(target == .tab ? "Tab capture is available in the Chrome extension" : target.label)
    }

    private var deviceSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Camera")
            Picker("Camera", selection: $camera.selectedDeviceID) {
                ForEach(camera.devices, id: \.uniqueID) { device in
                    Text(device.localizedName).tag(device.uniqueID)
                }
            }
            .labelsHidden()
            if camera.needsCameraPermissionInSettings {
                Button("Open Camera Settings…") { camera.openSystemCameraSettings() }
            }

            sectionLabel("Microphone")
            Picker("Microphone", selection: $microphone.selectedDeviceID) {
                ForEach(microphone.devices, id: \.uniqueID) { device in
                    Text(device.localizedName).tag(device.uniqueID)
                }
            }
            .labelsHidden()
            .disabled(!includeMicrophone)
            if microphone.needsMicrophonePermissionInSettings {
                Button("Open Microphone Settings…") { microphone.openSystemMicrophoneSettings() }
            }
        }
    }

    private var audioSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Audio")
            Toggle("Include microphone", isOn: $includeMicrophone)
            Toggle("Include system audio", isOn: $includeSystemAudio)
            Text("On macOS 15+, mic and system audio can mix. On macOS 14, mic is preferred when both are on.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
    }

    private var destinationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Save to")
            if LibraryFolderStore.shared.hasLibrary {
                Text(LibraryFolderStore.shared.displayPath)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } else {
                Text("~/Movies/MyPipCam will be created on start (same folder Chrome can use).")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            Button("Choose Library Folder…") {
                _ = LibraryFolderStore.shared.chooseFolder(settings: settings)
            }
        }
    }

    private var footer: some View {
        HStack {
            Button("Cancel", action: onCancel)
                .keyboardShortcut(.cancelAction)
            Spacer()
            Button {
                Task { await start() }
            } label: {
                if isStarting {
                    ProgressView()
                        .controlSize(.small)
                        .padding(.horizontal, 8)
                } else {
                    Text("Start Recording")
                        .fontWeight(.semibold)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(brand)
            .disabled(isStarting || captureTarget == .tab)
            .keyboardShortcut(.defaultAction)
        }
        .padding(16)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .tracking(0.4)
    }

    private func restoreSelections() {
        if selectedDisplayID == 0 {
            if savedDisplayID != 0,
               recorder.displays.contains(where: { $0.id == CGDirectDisplayID(savedDisplayID) }) {
                selectedDisplayID = CGDirectDisplayID(savedDisplayID)
            } else if let first = recorder.displays.first {
                selectedDisplayID = first.id
            }
        } else if !recorder.displays.contains(where: { $0.id == selectedDisplayID }),
                  let first = recorder.displays.first {
            selectedDisplayID = first.id
        }

        if selectedWindowID == 0 {
            if savedWindowID != 0,
               recorder.windows.contains(where: { $0.id == CGWindowID(savedWindowID) }) {
                selectedWindowID = CGWindowID(savedWindowID)
            } else if let first = recorder.windows.first {
                selectedWindowID = first.id
            }
        } else if !recorder.windows.contains(where: { $0.id == selectedWindowID }),
                  let first = recorder.windows.first {
            selectedWindowID = first.id
        }
    }

    private func start() async {
        localError = nil
        guard captureTarget != .tab else {
            localError = "Tab capture is only available in the Chrome extension."
            return
        }
        if captureTarget == .window && selectedWindowID == 0 {
            localError = "Select a window to capture."
            return
        }
        if captureTarget == .screen && selectedDisplayID == 0 {
            localError = "Select a display to capture."
            return
        }

        savedDisplayID = Int(selectedDisplayID)
        savedWindowID = Int(selectedWindowID)
        isStarting = true
        defer { isStarting = false }

        await onStart(
            RecordToCloudCoordinator.StartConfig(
                target: captureTarget,
                displayID: selectedDisplayID,
                windowID: selectedWindowID,
                includeSystemAudio: includeSystemAudio,
                includeMicrophone: includeMicrophone
            )
        )
    }
}

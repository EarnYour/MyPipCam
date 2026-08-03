import SwiftUI

struct BorderColorPopover: View {
    @ObservedObject var settings: BubbleSettings
    @State private var hexDraft: String = ""
    @State private var hexError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Appearance")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("Shape")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Picker("Shape", selection: Binding(
                    get: { settings.bubbleShape },
                    set: { settings.bubbleShape = $0 }
                )) {
                    ForEach(BubbleShape.allCases) { shape in
                        Text(shape.label).tag(shape)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Opacity")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(Int((settings.effectiveBubbleOpacity * 100).rounded()))%")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Slider(value: $settings.bubbleOpacity, in: 0.3...1.0, step: 0.05)
            }

            Divider()

            Text("Border")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)

            LazyVGrid(columns: Array(repeating: GridItem(.fixed(28), spacing: 8), count: 5), spacing: 8) {
                ForEach(BorderPreset.allCases.filter { $0 != .custom }) { preset in
                    Button {
                        settings.applyPreset(preset)
                        if let hex = preset.hex {
                            hexDraft = hex
                        }
                        hexError = false
                    } label: {
                        ZStack {
                            if preset == .transparent {
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .strokeBorder(Color.primary.opacity(0.35), lineWidth: 1)
                                    .background(
                                        Image(systemName: "circle.slash")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(.secondary)
                                    )
                            } else {
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(HexColor.color(from: preset.hex ?? "#FFFFFF") ?? .white)
                            }

                            if settings.borderPreset == preset {
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .strokeBorder(Color.accentColor, lineWidth: 2)
                            }
                        }
                        .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .help(preset.label)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Custom hex")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)

                HStack(spacing: 8) {
                    TextField("#RRGGBBAA", text: $hexDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                        // Toolbar forces .white; reset so typed hex is visible on the field.
                        .foregroundStyle(Color(nsColor: .textColor))
                        .onSubmit(applyHex)

                    Button("Apply", action: applyHex)
                        .keyboardShortcut(.defaultAction)
                }

                if hexError {
                    Text("Use #RRGGBB or #RRGGBBAA")
                        .font(.system(size: 10))
                        .foregroundStyle(.red)
                }
            }

            if settings.borderPreset != .transparent {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Thickness")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(Int(settings.borderWidth.rounded())) pt")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: $settings.borderWidth, in: 1...12, step: 1)
                        .help("Border thickness")
                }
            }

            Toggle("Drop shadow", isOn: $settings.showShadow)
                .font(.system(size: 12, weight: .medium))
        }

        .padding(14)
        .frame(width: 220)
        // Popover is attached under the camera toolbar, which sets .foregroundStyle(.white).
        // Reset so labels/inputs use normal system (dark-on-light / light-on-dark) contrast.
        .foregroundStyle(.primary)
        .onAppear {
            hexDraft = settings.borderPreset == .transparent
                ? ""
                : (settings.borderPreset.hex ?? settings.customBorderHex)
        }
    }

    private func applyHex() {
        if settings.applyCustomHex(hexDraft) {
            hexError = false
            hexDraft = settings.customBorderHex
        } else {
            hexError = true
        }
    }
}

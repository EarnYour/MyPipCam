import AppKit
import Combine
import SwiftUI

enum BubbleShape: String, CaseIterable, Identifiable {
    case circle
    case square

    var id: String { rawValue }

    var label: String {
        switch self {
        case .circle: return "Circle"
        case .square: return "Square"
        }
    }

    /// Corner radius as a fraction of bubble diameter (square only).
    static let squareCornerFraction: CGFloat = 0.14
}

enum BorderPreset: String, CaseIterable, Identifiable {
    case transparent
    case white
    case softGray
    case black
    case loomCoral
    case sky
    case mint
    case gold
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .transparent: return "Transparent"
        case .white: return "White"
        case .softGray: return "Soft Gray"
        case .black: return "Black"
        case .loomCoral: return "Coral"
        case .sky: return "Sky"
        case .mint: return "Mint"
        case .gold: return "Gold"
        case .custom: return "Custom Hex"
        }
    }

    var hex: String? {
        switch self {
        case .transparent: return nil
        case .white: return "#FFFFFF"
        case .softGray: return "#D9DEE6"
        case .black: return "#14161C"
        case .loomCoral: return "#FA5959"
        case .sky: return "#59ADFA"
        case .mint: return "#59D1AD"
        case .gold: return "#F2C24D"
        case .custom: return nil
        }
    }
}

enum HexColor {
    static func color(from hex: String) -> Color? {
        guard let ns = nsColor(from: hex) else { return nil }
        return Color(nsColor: ns)
    }

    static func nsColor(from hex: String) -> NSColor? {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if cleaned.hasPrefix("#") { cleaned.removeFirst() }
        guard cleaned.count == 6 || cleaned.count == 8,
              let value = UInt64(cleaned, radix: 16) else { return nil }

        let r, g, b, a: CGFloat
        if cleaned.count == 8 {
            r = CGFloat((value & 0xFF00_0000) >> 24) / 255
            g = CGFloat((value & 0x00FF_0000) >> 16) / 255
            b = CGFloat((value & 0x0000_FF00) >> 8) / 255
            a = CGFloat(value & 0x0000_00FF) / 255
        } else {
            r = CGFloat((value & 0xFF0000) >> 16) / 255
            g = CGFloat((value & 0x00FF00) >> 8) / 255
            b = CGFloat(value & 0x0000FF) / 255
            a = 1
        }
        return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
    }

    static func normalize(_ hex: String) -> String? {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if cleaned.hasPrefix("#") { cleaned.removeFirst() }
        guard cleaned.count == 6 || cleaned.count == 8,
              UInt64(cleaned, radix: 16) != nil else { return nil }
        return "#\(cleaned)"
    }
}

@MainActor
final class BubbleSettings: ObservableObject {
    @AppStorage("borderPreset") var borderPresetRaw: String = BorderPreset.white.rawValue {
        didSet { objectWillChange.send() }
    }
    @AppStorage("customBorderHex") var customBorderHex: String = "#FFFFFF" {
        didSet { objectWillChange.send() }
    }
    /// Border stroke thickness in points (1…12). Ignored when preset is Transparent.
    @AppStorage("borderWidth") var borderWidth: Double = 4 {
        didSet { objectWillChange.send() }
    }
    @AppStorage("showShadow") var showShadow: Bool = true {
        didSet { objectWillChange.send() }
    }
    @AppStorage("mirrorCamera") var mirrorCamera: Bool = true {
        didSet { objectWillChange.send() }
    }
    @AppStorage("bubbleSize") var bubbleSize: Double = 220 {
        didSet { objectWillChange.send() }
    }
    @AppStorage("bubbleShape") var bubbleShapeRaw: String = BubbleShape.circle.rawValue {
        didSet { objectWillChange.send() }
    }
    /// Overall bubble opacity (camera + border + shadow). Clamped to 0.3…1.0.
    @AppStorage("bubbleOpacity") var bubbleOpacity: Double = 1.0 {
        didSet { objectWillChange.send() }
    }
    /// Optional override for the Chrome extension ID used by “Open in Chrome…”.
    /// Empty = use the stable ID from the extension manifest key
    /// (`ExtensionLibraryOpener.defaultExtensionID`).
    @AppStorage("chromeExtensionId") var chromeExtensionId: String = "" {
        didSet { objectWillChange.send() }
    }
    /// Optional absolute path to `apps/extension/dist` for “Install Chrome Extension…”.
    @AppStorage("chromeExtensionDistPath") var chromeExtensionDistPath: String = "" {
        didSet { objectWillChange.send() }
    }
    /// Display path for the shared on-disk recording library (empty = not set).
    @AppStorage("libraryFolderDisplayPath") var libraryFolderDisplayPath: String = "" {
        didSet { objectWillChange.send() }
    }

    /// Security-scoped bookmark for the shared library folder.
    var libraryFolderBookmark: Data? {
        get { UserDefaults.standard.data(forKey: Self.libraryFolderBookmarkKey) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: Self.libraryFolderBookmarkKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.libraryFolderBookmarkKey)
            }
            objectWillChange.send()
        }
    }

    var hasLibraryFolder: Bool {
        libraryFolderBookmark != nil && !libraryFolderDisplayPath.isEmpty
    }

    static let libraryFolderBookmarkKey = "libraryFolderBookmark"

    /// Extension ID for library URLs: override → auto-detect → packed-key default.
    var resolvedChromeExtensionId: String {
        ExtensionLibraryOpener.resolveExtensionID(preferred: chromeExtensionId)
    }

    var borderPreset: BorderPreset {
        get { BorderPreset(rawValue: borderPresetRaw) ?? .white }
        set { borderPresetRaw = newValue.rawValue }
    }

    var bubbleShape: BubbleShape {
        get { BubbleShape(rawValue: bubbleShapeRaw) ?? .circle }
        set { bubbleShapeRaw = newValue.rawValue }
    }

    /// Corner radius for the square bubble mask (points).
    func squareCornerRadius(for size: CGFloat) -> CGFloat {
        size * BubbleShape.squareCornerFraction
    }

    var resolvedBorderColor: Color {
        switch borderPreset {
        case .transparent:
            return .clear
        case .custom:
            return HexColor.color(from: customBorderHex) ?? .white
        default:
            if let hex = borderPreset.hex, let color = HexColor.color(from: hex) {
                return color
            }
            return .white
        }
    }

    var effectiveBorderWidth: CGFloat {
        guard borderPreset != .transparent else { return 0 }
        return CGFloat(min(12, max(1, borderWidth)))
    }

    /// Opacity applied to the visible bubble (30%–100%).
    var effectiveBubbleOpacity: Double {
        min(1, max(0.3, bubbleOpacity))
    }

    func applyPreset(_ preset: BorderPreset) {
        borderPreset = preset
        if let hex = preset.hex {
            customBorderHex = hex
        }
    }

    @discardableResult
    func applyCustomHex(_ hex: String) -> Bool {
        guard let normalized = HexColor.normalize(hex) else { return false }
        customBorderHex = normalized
        borderPreset = .custom
        return true
    }
}

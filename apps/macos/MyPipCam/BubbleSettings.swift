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

/// 16:9 widescreen presets as a fraction of the screen’s visible frame.
enum WidescreenSize: String, CaseIterable, Identifiable {
    case small
    case medium
    case large
    case xl

    var id: String { rawValue }

    var label: String {
        switch self {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        case .xl: return "XL"
        }
    }

    /// Short menu label with approximate screen coverage.
    var menuLabel: String {
        "\(label) (\(percentLabel))"
    }

    var percentLabel: String {
        "\(Int((screenFraction * 100).rounded()))%"
    }

    /// Fraction of the shorter screen axis budget used for the 16:9 fit.
    var screenFraction: CGFloat {
        switch self {
        case .small: return 0.28
        case .medium: return 0.50
        case .large: return 0.80
        case .xl: return 0.90
        }
    }
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
    /// When true, the floating bubble is 16:9 and sized by `widescreenSize`.
    @AppStorage("useWidescreen") var useWidescreen: Bool = false {
        didSet { objectWillChange.send() }
    }
    /// Widescreen 16:9 size preset (Small…XL). Ignored unless `useWidescreen` is true.
    @AppStorage("widescreenSize") var widescreenSizeRaw: String = WidescreenSize.large.rawValue {
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
    /// Empty = auto-detect store (`chromeWebStoreExtensionID`) or unpacked
    /// (`defaultExtensionID`) install.
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
    static let bubbleOriginXKey = "bubbleOriginX"
    static let bubbleOriginYKey = "bubbleOriginY"
    static let hasSavedBubbleOriginKey = "hasSavedBubbleOrigin"

    /// Last on-screen bubble origin (bottom-left, AppKit coords). Survives relaunch/reboot.
    var savedBubbleOrigin: NSPoint? {
        get {
            let defaults = UserDefaults.standard
            guard defaults.bool(forKey: Self.hasSavedBubbleOriginKey) else { return nil }
            return NSPoint(
                x: defaults.double(forKey: Self.bubbleOriginXKey),
                y: defaults.double(forKey: Self.bubbleOriginYKey)
            )
        }
        set {
            let defaults = UserDefaults.standard
            if let newValue {
                defaults.set(newValue.x, forKey: Self.bubbleOriginXKey)
                defaults.set(newValue.y, forKey: Self.bubbleOriginYKey)
                defaults.set(true, forKey: Self.hasSavedBubbleOriginKey)
            } else {
                defaults.removeObject(forKey: Self.bubbleOriginXKey)
                defaults.removeObject(forKey: Self.bubbleOriginYKey)
                defaults.set(false, forKey: Self.hasSavedBubbleOriginKey)
            }
        }
    }

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

    var widescreenSize: WidescreenSize {
        get { WidescreenSize(rawValue: widescreenSizeRaw) ?? .large }
        set { widescreenSizeRaw = newValue.rawValue }
    }

    /// Default / legacy Widescreen coverage (~80% of the visible frame).
    static let widescreenScreenFraction: CGFloat = WidescreenSize.large.screenFraction
    static let widescreenAspect: CGFloat = 16.0 / 9.0

    /// Corner radius for the square / rounded-rect bubble mask (points).
    func squareCornerRadius(for size: CGFloat) -> CGFloat {
        size * BubbleShape.squareCornerFraction
    }

    /// Corner radius based on the shorter edge (keeps proportions on 16:9).
    func cornerRadius(for contentSize: CGSize) -> CGFloat {
        min(contentSize.width, contentSize.height) * BubbleShape.squareCornerFraction
    }

    /// Content size for the camera bubble (excludes shadow padding).
    func contentSize(on screen: NSScreen? = NSScreen.main) -> CGSize {
        if useWidescreen {
            return Self.widescreenContentSize(fraction: widescreenSize.screenFraction, on: screen)
        }
        let side = CGFloat(bubbleSize)
        return CGSize(width: side, height: side)
    }

    /// Largest 16:9 rect that fits in `fraction` of the screen’s visible frame.
    static func widescreenContentSize(
        fraction: CGFloat = WidescreenSize.large.screenFraction,
        on screen: NSScreen? = NSScreen.main
    ) -> CGSize {
        let visible = screen?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let clamped = min(0.95, max(0.15, fraction))
        let maxWidth = visible.width * clamped
        let maxHeight = visible.height * clamped
        let aspect = widescreenAspect
        if maxWidth / maxHeight > aspect {
            let height = maxHeight
            return CGSize(width: height * aspect, height: height)
        }
        let width = maxWidth
        return CGSize(width: width, height: width / aspect)
    }

    /// Square / circle presets (Small…XL). Clears widescreen mode.
    func applySquareSize(_ size: Double) {
        useWidescreen = false
        bubbleSize = size
    }

    /// 16:9 at the given screen-fraction preset. Uses a rounded rectangle shape.
    func applyWidescreen(_ size: WidescreenSize = .large) {
        bubbleShape = .square
        widescreenSize = size
        useWidescreen = true
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

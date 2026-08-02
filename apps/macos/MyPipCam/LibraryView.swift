import AVKit
import AppKit
import SwiftUI

/// Presents the native recording library window (browse / play / rename / delete).
@MainActor
enum LibraryWindowPresenter {
    private static var window: NSWindow?
    private static var hosting: NSHostingController<LibraryRootView>?

    static func open(
        store: LibraryFolderStore? = nil,
        settings: BubbleSettings,
        chooseIfNeeded: Bool = true
    ) {
        let store = store ?? .shared
        if !store.hasLibrary {
            if chooseIfNeeded {
                guard store.chooseFolder(settings: settings) else { return }
            } else {
                promptChooseFolder(store: store, settings: settings)
                return
            }
        }

        store.refresh()
        showWindow(store: store, settings: settings)
    }

    static func chooseFolder(
        store: LibraryFolderStore? = nil,
        settings: BubbleSettings,
        openAfter: Bool = true
    ) {
        let store = store ?? .shared
        guard store.chooseFolder(settings: settings) else { return }
        if openAfter {
            showWindow(store: store, settings: settings)
        }
    }

    static func revealLibrary(store: LibraryFolderStore? = nil) {
        let store = store ?? .shared
        guard store.hasLibrary else {
            let alert = NSAlert()
            alert.messageText = "No Library Folder"
            alert.informativeText = "Choose a recording library folder first."
            alert.alertStyle = .informational
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }
        store.revealLibraryInFinder()
    }

    private static func promptChooseFolder(store: LibraryFolderStore, settings: BubbleSettings) {
        let alert = NSAlert()
        alert.messageText = "Choose Recording Library"
        alert.informativeText = """
        Pick the same folder you use in the Chrome extension (suggested: ~/Movies/MyPipCam) so both apps share recordings on disk.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Choose Folder…")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        chooseFolder(store: store, settings: settings, openAfter: true)
    }

    private static func showWindow(store: LibraryFolderStore, settings: BubbleSettings) {
        let root = LibraryRootView(store: store, settings: settings)
        if let window {
            hosting?.rootView = root
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let controller = NSHostingController(rootView: root)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 780, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Recording Library"
        window.contentViewController = controller
        window.center()
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("MyPipCamLibraryWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        Self.window = window
        Self.hosting = controller
    }
}

private struct LibraryRootView: View {
    @ObservedObject var store: LibraryFolderStore
    @ObservedObject var settings: BubbleSettings

    var body: some View {
        LibraryView(store: store, settings: settings)
    }
}

struct LibraryView: View {
    @ObservedObject var store: LibraryFolderStore
    @ObservedObject var settings: BubbleSettings

    @State private var selection: FolderRecording.ID?
    @State private var player: AVPlayer?
    @State private var renameDraft = ""
    @State private var isRenaming = false
    @State private var confirmDelete = false
    @State private var isPreparingPlayback = false

    private var selected: FolderRecording? {
        store.recordings.first { $0.id == selection }
    }

    var body: some View {
        NavigationSplitView {
            listPane
                .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 360)
        } detail: {
            detailPane
        }
        .frame(minWidth: 640, minHeight: 400)
        .onAppear {
            store.refresh()
            if selection == nil {
                selection = store.recordings.first?.id
            }
        }
        .onChange(of: store.recordings) { _, items in
            if let selection, items.contains(where: { $0.id == selection }) {
                return
            }
            // The selected clip is gone (deleted or library rescanned) — the
            // player would otherwise keep playing a temp copy of it.
            stopPlayback()
            self.selection = items.first?.id
        }
        .onChange(of: selection) { _, _ in
            // play() sets the selection itself; don't tear down the player it
            // is in the middle of preparing. A switch to another clip is
            // handled by the staleness check inside play().
            guard !isPreparingPlayback else { return }
            stopPlayback()
        }
        .onDisappear {
            // Closing the Library window must not leave audio playing.
            stopPlayback()
        }
        .alert("Rename Recording", isPresented: $isRenaming) {
            TextField("Title", text: $renameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                guard let id = selection else { return }
                do {
                    try store.renameRecording(id: id, title: renameDraft)
                } catch {
                    presentAlert(title: "Rename Failed", message: error.localizedDescription)
                }
            }
        } message: {
            Text("Enter a new title for this recording.")
        }
        .confirmationDialog(
            "Delete this recording from disk?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                guard let id = selection else { return }
                stopPlayback()
                do {
                    try store.deleteRecording(id: id)
                } catch {
                    presentAlert(title: "Delete Failed", message: error.localizedDescription)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the folder under recordings/ and cannot be undone.")
        }
    }

    private var listPane: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Library")
                    .font(.headline)
                Spacer()
                Button {
                    store.refresh()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            if !store.displayPath.isEmpty {
                Text(store.displayPath)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }

            Divider()

            if store.recordings.isEmpty {
                VStack(spacing: 10) {
                    Spacer()
                    Image(systemName: "film.stack")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("No recordings yet")
                        .font(.callout.weight(.medium))
                    Text("Record in Chrome with this folder selected, then refresh.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(store.recordings, selection: $selection) { item in
                    RecordingRow(item: item)
                        .tag(item.id)
                        .contextMenu {
                            Button("Play") { play(item) }
                                .disabled(isPreparingPlayback)
                            Button("Rename…") { beginRename(item) }
                            Button("Reveal in Finder") {
                                store.revealRecordingInFinder(id: item.id)
                            }
                            Divider()
                            Button("Delete…", role: .destructive) {
                                selection = item.id
                                confirmDelete = true
                            }
                        }
                }
                .listStyle(.sidebar)
            }

            Divider()
            HStack(spacing: 8) {
                Button("Choose…") {
                    LibraryWindowPresenter.chooseFolder(store: store, settings: settings, openAfter: false)
                    store.refresh()
                }
                Button("Reveal") {
                    store.revealLibraryInFinder()
                }
                .disabled(!store.hasLibrary)
                Spacer()
                Button("Open in Chrome…") {
                    openInChrome()
                }
            }
            .controlSize(.small)
            .padding(10)
        }
    }

    @ViewBuilder
    private var detailPane: some View {
        if let item = selected {
            VStack(spacing: 0) {
                if let player {
                    VideoPlayer(player: player)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ZStack {
                        Color(nsColor: .windowBackgroundColor)
                        VStack(spacing: 12) {
                            if let thumbURL = item.thumbURL,
                               let nsImage = loadThumb(thumbURL, recordingId: item.id) {
                                Image(nsImage: nsImage)
                                    .resizable()
                                    .aspectRatio(contentMode: .fit)
                                    .frame(maxHeight: 220)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            } else {
                                Image(systemName: "play.rectangle.fill")
                                    .font(.system(size: 40))
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.title)
                                .font(.title3.weight(.semibold))
                            Text("\(item.formattedDate) · \(item.formattedDuration)")
                                .foregroundStyle(.secondary)
                            Button(isPreparingPlayback ? "Preparing…" : "Play") { play(item) }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.large)
                                .disabled(isPreparingPlayback)
                        }
                        .padding()
                    }
                }

                HStack(spacing: 12) {
                    Button("Play") { play(item) }
                        .disabled(isPreparingPlayback)
                    Button("Rename…") { beginRename(item) }
                    Button("Reveal in Finder") {
                        store.revealRecordingInFinder(id: item.id)
                    }
                    Spacer()
                    Button("Delete…", role: .destructive) {
                        confirmDelete = true
                    }
                    Button("Open in Chrome…") { openInChrome() }
                }
                .padding(12)
                .background(.bar)
            }
        } else {
            ContentUnavailableView(
                "Select a recording",
                systemImage: "film",
                description: Text("Pick a clip from the list, or record one in Chrome.")
            )
        }
    }

    private func play(_ item: FolderRecording) {
        // The context menu can fire on a row that isn't selected, and the
        // staleness check below compares against the selection.
        selection = item.id
        stopPlayback()
        isPreparingPlayback = true
        Task {
            defer { isPreparingPlayback = false }
            do {
                let url = try await store.scopedVideoURL(for: item.id)
                // The user may have switched clips while the copy was running.
                guard selected?.id == item.id else { return }
                let avPlayer = AVPlayer(url: url)
                player = avPlayer
                avPlayer.play()
            } catch {
                presentAlert(title: "Playback Failed", message: error.localizedDescription)
            }
        }
    }

    private func stopPlayback() {
        player?.pause()
        player = nil
    }

    private func beginRename(_ item: FolderRecording) {
        renameDraft = item.title
        isRenaming = true
    }

    private func openInChrome() {
        let override = settings.chromeExtensionId.trimmingCharacters(in: .whitespacesAndNewlines)
        ExtensionLibraryOpener.openRecordingLibrary(
            extensionID: override.isEmpty ? nil : override
        )
    }

    private func loadThumb(_ preferredURL: URL, recordingId: String) -> NSImage? {
        // Prefer a scoped copy so sandbox access is reliable.
        if let image = NSImage(contentsOf: preferredURL) { return image }
        guard LibraryFolderStore.isSafeRecordingID(recordingId) else { return nil }
        do {
            return try store.withScopedAccess { root in
                let thumb = try LibraryFolderStore.recordingFolder(root: root, id: recordingId)
                    .appendingPathComponent("thumb.jpg")
                return NSImage(contentsOf: thumb)
            }
        } catch {
            return nil
        }
    }

    private func presentAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

private struct RecordingRow: View {
    let item: FolderRecording

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.title)
                .font(.body.weight(.medium))
                .lineLimit(1)
            Text("\(item.formattedDate) · \(item.formattedDuration)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}

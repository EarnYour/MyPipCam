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

private enum LibraryBrowseFilter: Hashable {
    case all
    case unfiled
    case folder(String)
}

struct LibraryView: View {
    @ObservedObject var store: LibraryFolderStore
    @ObservedObject var settings: BubbleSettings

    @State private var selection: FolderRecording.ID?
    @State private var player: AVPlayer?
    @State private var renameDraft = ""
    @State private var isRenaming = false
    @State private var confirmDelete = false
    @State private var browseFilter: LibraryBrowseFilter = .all

    private var filteredRecordings: [FolderRecording] {
        switch browseFilter {
        case .all:
            return store.recordings
        case .unfiled:
            return store.recordings.filter { $0.orgFolderId == nil }
        case .folder(let id):
            return store.recordings.filter { $0.orgFolderId == id }
        }
    }

    private var selected: FolderRecording? {
        filteredRecordings.first { $0.id == selection }
            ?? store.recordings.first { $0.id == selection }
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
                selection = filteredRecordings.first?.id
            }
        }
        .onChange(of: store.recordings) { _, _ in
            reconcileSelection()
        }
        .onChange(of: browseFilter) { _, _ in
            reconcileSelection()
        }
        .onChange(of: store.orgFolders) { _, folders in
            if case .folder(let id) = browseFilter, !folders.contains(where: { $0.id == id }) {
                browseFilter = .all
            }
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
                VStack(alignment: .leading, spacing: 4) {
                    Text(store.displayPath)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if isMoviesRootLibrary {
                        Text("Suggested: ~/Movies/MyPipCam (yours matches Chrome if you picked Movies there).")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }

            Picker("Folder", selection: $browseFilter) {
                Text("All (\(store.recordings.count))").tag(LibraryBrowseFilter.all)
                Text("Unfiled (\(store.recordings.filter { $0.orgFolderId == nil }.count))")
                    .tag(LibraryBrowseFilter.unfiled)
                ForEach(store.orgFolders) { folder in
                    let count = store.recordings.filter { $0.orgFolderId == folder.id }.count
                    Text("\(folder.name) (\(count))").tag(LibraryBrowseFilter.folder(folder.id))
                }
            }
            .pickerStyle(.menu)
            .padding(.horizontal, 12)
            .padding(.bottom, 8)

            Divider()

            if filteredRecordings.isEmpty {
                VStack(spacing: 10) {
                    Spacer()
                    Image(systemName: "film.stack")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text(store.recordings.isEmpty ? "No recordings yet" : "Nothing in this folder")
                        .font(.callout.weight(.medium))
                    Text(
                        store.recordings.isEmpty
                            ? "Record from the bubble menu or in Chrome, then refresh."
                            : "Organize folders in the Chrome Library; macOS reads the same folders.json."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(filteredRecordings, selection: $selection) { item in
                    RecordingRow(item: item, folderName: orgFolderName(for: item))
                        .tag(item.id)
                        .contextMenu {
                            Button("Play") { play(item) }
                            Button("Rename…") { beginRename(item) }
                            Menu("Move to Folder") {
                                Button("Unfiled") {
                                    move(item, to: nil)
                                }
                                .disabled(item.orgFolderId == nil)
                                ForEach(store.orgFolders) { folder in
                                    Button(folder.name) {
                                        move(item, to: folder.id)
                                    }
                                    .disabled(item.orgFolderId == folder.id)
                                }
                            }
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
                            Button("Play") { play(item) }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.large)
                        }
                        .padding()
                    }
                }

                HStack(spacing: 12) {
                    Button("Play") { play(item) }
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
        stopPlayback()
        do {
            let url = try store.scopedVideoURL(for: item.id)
            let avPlayer = AVPlayer(url: url)
            player = avPlayer
            avPlayer.play()
        } catch {
            presentAlert(title: "Playback Failed", message: error.localizedDescription)
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

    private func reconcileSelection() {
        if let selection, filteredRecordings.contains(where: { $0.id == selection }) {
            return
        }
        self.selection = filteredRecordings.first?.id
    }

    private func orgFolderName(for item: FolderRecording) -> String? {
        guard let id = item.orgFolderId else { return nil }
        return store.orgFolders.first(where: { $0.id == id })?.name
    }

    private func move(_ item: FolderRecording, to orgFolderId: String?) {
        do {
            try store.moveRecording(id: item.id, toOrgFolderId: orgFolderId)
        } catch {
            presentAlert(title: "Move Failed", message: error.localizedDescription)
        }
    }

    private var isMoviesRootLibrary: Bool {
        let path = (store.displayPath as NSString).standardizingPath
        let movies = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies")
        return path == (movies.path as NSString).standardizingPath
    }

    private func openInChrome() {
        let override = settings.chromeExtensionId.trimmingCharacters(in: .whitespacesAndNewlines)
        ExtensionLibraryOpener.openRecordingLibrary(
            extensionID: override.isEmpty ? nil : override,
            recordingID: selection
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
    var folderName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.title)
                .font(.body.weight(.medium))
                .lineLimit(1)
            Text(
                folderName.map { "\($0) · \(item.formattedDate) · \(item.formattedDuration)" }
                    ?? "\(item.formattedDate) · \(item.formattedDuration)"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}

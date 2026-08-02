import Combine
import Foundation

/// UI-facing facade for desktop recording (setup → capture → library save).
/// Delegates to `RecordToCloudCoordinator` / ScreenCaptureKit.
@MainActor
final class RecordingController: ObservableObject {
    static let shared = RecordingController()

    private let backend = RecordToCloudCoordinator.shared
    private var cancellables = Set<AnyCancellable>()

    @Published private(set) var isRecording = false
    @Published private(set) var elapsedSeconds = 0

    private init() {
        backend.$isRecording
            .receive(on: RunLoop.main)
            .sink { [weak self] value in
                self?.isRecording = value
            }
            .store(in: &cancellables)

        backend.recorder.$elapsedSeconds
            .receive(on: RunLoop.main)
            .sink { [weak self] value in
                self?.elapsedSeconds = Int(value.rounded())
            }
            .store(in: &cancellables)
    }

    func openSetup() {
        backend.presentSetup()
    }

    func toggleFromMenu() {
        if backend.isRecording {
            Task { await backend.stopRecording() }
        } else {
            backend.presentSetup()
        }
    }

    func stopRecording(reveal: Bool = true) async {
        // Backend always offers library open / reveal after stop.
        _ = reveal
        await backend.stopRecording()
    }
}

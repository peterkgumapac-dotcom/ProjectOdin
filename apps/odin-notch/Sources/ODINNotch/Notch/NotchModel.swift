import AppKit
import EventKit
import SwiftUI
import UniformTypeIdentifiers

final class NotchModel: ObservableObject {
    @Published var presentation: NotchPresentationState = .compact
    @Published var liveActivity: NotchLiveActivity = .resting {
        didSet {
            if oldValue != liveActivity {
                onSurfaceStateChange?()
            }
        }
    }
    @Published var geometry: NotchGeometry = NotchGeometryService.current()
    @Published var showDebugOverlay = NotchPreferences.showDebugOverlay {
        didSet { NotchPreferences.showDebugOverlay = showDebugOverlay }
    }
    @Published var collapseDelay: TimeInterval = NotchPreferences.collapseDelay {
        didSet { NotchPreferences.collapseDelay = collapseDelay }
    }
    @Published var hoverToExpand = NotchPreferences.hoverToExpand {
        didSet { NotchPreferences.hoverToExpand = hoverToExpand }
    }
    @Published var calendarPeekEnabled = NotchPreferences.calendarPeekEnabled {
        didSet {
            NotchPreferences.calendarPeekEnabled = calendarPeekEnabled
            scheduleCalendarPeek()
        }
    }
    @Published var calendarPeekLeadTime = NotchPreferences.calendarPeekLeadTime {
        didSet {
            NotchPreferences.calendarPeekLeadTime = calendarPeekLeadTime
            scheduleCalendarPeek()
        }
    }
    @Published var calendarPeekDisplayDuration = NotchPreferences.calendarPeekDisplayDuration {
        didSet { NotchPreferences.calendarPeekDisplayDuration = calendarPeekDisplayDuration }
    }

    @Published var music = MusicState.empty
    @Published var meetings: [MeetingItem] = []
    @Published var calendarPeekMeeting: MeetingItem?
    @Published var songPeekTrack: MusicState?
    @Published var taskSummary = TaskSummary.empty
    @Published var priorityItems: [PriorityItem] = []
    @Published var quickApps: [QuickApp] = []
    @Published var health = HealthSnapshot.empty
    @Published var audioReactiveState = AudioReactiveState.idle
    @Published var clippedFiles: [ClippedFile] = []
    @Published var corkNotes: [CorkNote] = []
    @Published var odinDropStatus: OdinDropStatus = .idle
    var onSurfaceStateChange: (() -> Void)?
    var installedApps: [InstalledApp] = []

    private var musicSyncTimer: Timer?
    private var calendarPeekTimer: Timer?
    private var calendarPeekDismissTimer: Timer?
    private var songPeekDismissTimer: Timer?
    private var fileDropDismissTimer: Timer?
    private var odinDropStatusTimer: Timer?
    private var musicCommandRefreshWorkItem: DispatchWorkItem?
    private var calendarChangeObserver: NSObjectProtocol?
    private var calendarChangeRefreshWorkItem: DispatchWorkItem?
    private var lastCalendarPeekKey: String?
    private var lastMusicPeekKey: String?
    private var hasSeenMusicTrack = false
    private var isRefreshingMusic = false

    init() {
        startCalendarChangeObserver()

        let apps = QuickAppService.installedApps()
        installedApps = apps
        let savedIdentifiers = NotchPreferences.quickAppBundleIdentifiers
        quickApps = savedIdentifiers.compactMap { bundleIdentifier in
            guard let app = apps.first(where: { $0.bundleIdentifier == bundleIdentifier }) else { return nil }
            return QuickApp(name: app.name, bundleIdentifier: app.bundleIdentifier)
        }

    }

    func resetForNewUser() {
        NotchPreferences.resetAll()
        showDebugOverlay = NotchPreferences.showDebugOverlay
        collapseDelay = NotchPreferences.collapseDelay
        hoverToExpand = NotchPreferences.hoverToExpand
        calendarPeekEnabled = NotchPreferences.calendarPeekEnabled
        calendarPeekLeadTime = NotchPreferences.calendarPeekLeadTime
        calendarPeekDisplayDuration = NotchPreferences.calendarPeekDisplayDuration
        quickApps = []
        clippedFiles = []
        corkNotes = []
        calendarPeekMeeting = nil
        songPeekTrack = nil
        odinDropStatus = .idle
        lastCalendarPeekKey = nil
        lastMusicPeekKey = nil
        liveActivity = .resting
        presentation = .settings
    }

    deinit {
        if let calendarChangeObserver {
            NotificationCenter.default.removeObserver(calendarChangeObserver)
        }
        calendarChangeRefreshWorkItem?.cancel()
        musicSyncTimer?.invalidate()
        calendarPeekTimer?.invalidate()
        calendarPeekDismissTimer?.invalidate()
        songPeekDismissTimer?.invalidate()
        fileDropDismissTimer?.invalidate()
        odinDropStatusTimer?.invalidate()
    }

    func startNativeMusicSync() {
        guard musicSyncTimer == nil else { return }
        refreshMusicFromSpotify()
        musicSyncTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
            self?.refreshMusicFromSpotify()
        }
        musicSyncTimer?.tolerance = 0.8
    }

    func refreshGeometry() {
        geometry = NotchGeometryService.current()
    }

    func expand() {
        presentation = .expanded(.odin)
    }

    func collapse() {
        liveActivity = .resting
        presentation = .compact
    }

    func enterFileDropMode() {
        fileDropDismissTimer?.invalidate()
        presentation = .compact
        liveActivity = .fileDrop
    }

    func returnFromFileDropToOverview() {
        fileDropDismissTimer?.invalidate()
        presentation = .expanded(.odin)
        liveActivity = .resting
    }

    func scheduleFileDropDismissIfEmpty() {
        fileDropDismissTimer?.invalidate()
        guard clippedFiles.isEmpty, liveActivity == .fileDrop, !odinDropStatus.isVisible else { return }
        fileDropDismissTimer = Timer.scheduledTimer(withTimeInterval: 1.1, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.clippedFiles.isEmpty, self.liveActivity == .fileDrop, !self.odinDropStatus.isVisible else { return }
                self.liveActivity = .resting
            }
        }
    }

    func holdDroppedFiles(_ providers: [NSItemProvider]) -> Bool {
        return PhoneDropService.loadFileURLs(from: providers) { [weak self] urls in
            self?.addClippedFiles(urls)
        }
    }

    func addClippedFiles(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        fileDropDismissTimer?.invalidate()
        let existing = Set(clippedFiles.map(\.url))
        let nextFiles = urls
            .filter { !existing.contains($0) }
            .map { ClippedFile(url: $0) }
        clippedFiles.append(contentsOf: nextFiles)
        liveActivity = .fileDrop
        presentation = .compact
        showOdinDropStatus(.pinned(nextFiles.count == 1 ? nextFiles[0].name : "\(nextFiles.count) files pinned"))
    }

    func removeClippedFile(_ file: ClippedFile) {
        clippedFiles.removeAll { $0.id == file.id }
        scheduleFileDropDismissIfEmpty()
    }

    func sendClippedFileToPhone(_ file: ClippedFile) {
        sendFilesToPhone([file.url], label: file.name)
    }

    func sendDroppedFilesToPhone(_ providers: [NSItemProvider]) -> Bool {
        return PhoneDropService.loadFileURLs(from: providers) { [weak self] urls in
            guard let self else { return }
            self.sendFilesToPhone(urls, label: urls.count == 1 ? urls[0].lastPathComponent : "\(urls.count) files")
        }
    }

    func chooseFileForOdinDrop() {
        let panel = NSOpenPanel()
        panel.title = "Send with ODIN Drop"
        panel.prompt = "Send"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false

        guard panel.runModal() == .OK, let url = panel.url else { return }
        sendFilesToPhone([url], label: url.lastPathComponent)
    }

    func sendFilesToPhone(_ urls: [URL], label: String) {
        guard !urls.isEmpty else {
            showOdinDropStatus(.failed("No file found"))
            return
        }

        showOdinDropStatus(.sending("Sending \(label)"))
        let startedAt = Date()
        DispatchQueue.global(qos: .userInitiated).async {
            let results = urls.map { PhoneDropService.share(url: $0) }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let minimumSendingDuration: TimeInterval = 1.6
                let remainingDelay = max(0, minimumSendingDuration - Date().timeIntervalSince(startedAt))
                DispatchQueue.main.asyncAfter(deadline: .now() + remainingDelay) { [weak self] in
                    guard let self else { return }
                    if let failure = results.first(where: { !$0.success }) {
                        self.showOdinDropStatus(.failed(failure.message))
                    } else {
                        self.showOdinDropStatus(.sent(urls.count == 1 ? "Sent to phone" : "Sent \(urls.count) files to phone"))
                    }
                }
            }
        }
    }

    private func showOdinDropStatus(_ status: OdinDropStatus) {
        odinDropStatusTimer?.invalidate()
        odinDropStatus = status

        guard status != .idle else { return }
        let displayDuration: TimeInterval
        switch status {
        case .sent, .failed:
            displayDuration = 14.0
        case .pinned:
            displayDuration = 7.0
        case .sending:
            displayDuration = 16.0
        case .idle:
            displayDuration = 0
        }
        odinDropStatusTimer = Timer.scheduledTimer(withTimeInterval: displayDuration, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.odinDropStatus = .idle
                self?.scheduleFileDropDismissIfEmpty()
            }
        }
    }

    func addCorkNote() {
        fileDropDismissTimer?.invalidate()
        corkNotes.insert(CorkNote(text: "New note"), at: 0)
        liveActivity = .fileDrop
        presentation = .compact
    }

    func removeCorkNote(_ note: CorkNote) {
        corkNotes.removeAll { $0.id == note.id }
    }

    func chooseFilesForCorkBoard() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Pin"
        if panel.runModal() == .OK {
            addClippedFiles(panel.urls)
        }
    }

    func openSettings() {
        presentation = .settings
    }

    func addQuickApp(_ app: InstalledApp) {
        guard !quickApps.contains(where: { $0.bundleIdentifier == app.bundleIdentifier }) else { return }
        quickApps.append(QuickApp(name: app.name, bundleIdentifier: app.bundleIdentifier))
        saveQuickApps()
    }

    func chooseQuickAppFromPicker() {
        let panel = NSOpenPanel()
        panel.title = "Add Quick App"
        panel.prompt = "Add"
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.applicationBundle]

        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let bundle = Bundle(url: url) else { return }

        let bundleIdentifier = bundle.bundleIdentifier ?? url.path
        let displayName = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
        let bundleName = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
        let name = displayName ?? bundleName ?? url.deletingPathExtension().lastPathComponent
        let app = InstalledApp(id: bundleIdentifier, name: name, bundleIdentifier: bundleIdentifier, url: url)

        if !installedApps.contains(where: { $0.bundleIdentifier == bundleIdentifier }) {
            installedApps.append(app)
            installedApps.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }

        addQuickApp(app)
    }

    func removeQuickApp(_ app: QuickApp) {
        quickApps.removeAll { $0.bundleIdentifier == app.bundleIdentifier }
        saveQuickApps()
    }

    func replaceQuickApp(_ app: QuickApp, with replacement: InstalledApp) {
        let newApp = QuickApp(name: replacement.name, bundleIdentifier: replacement.bundleIdentifier)
        guard !quickApps.contains(where: { $0.bundleIdentifier == newApp.bundleIdentifier && $0.bundleIdentifier != app.bundleIdentifier }) else { return }
        if let index = quickApps.firstIndex(where: { $0.bundleIdentifier == app.bundleIdentifier }) {
            quickApps[index] = newApp
        } else {
            quickApps.append(newApp)
        }
        saveQuickApps()
    }

    func swapQuickApps(draggedBundleIdentifier: String, with target: QuickApp) {
        guard
            let sourceIndex = quickApps.firstIndex(where: { $0.bundleIdentifier == draggedBundleIdentifier }),
            let targetIndex = quickApps.firstIndex(where: { $0.bundleIdentifier == target.bundleIdentifier }),
            sourceIndex != targetIndex
        else {
            return
        }

        quickApps.swapAt(sourceIndex, targetIndex)
        saveQuickApps()
    }

    func refreshLocalData() {
        Task { @MainActor [weak self] in
            async let localMeetings = LocalCalendarService.meetingsToday()
            async let reminderSnapshot = LocalReminderService.prioritySnapshot()
            async let spotifyTrack = MediaProviderService.currentTrack()
            async let healthSnapshot = HealthSnapshotService.currentSnapshot()

            let (meetings, snapshot, track, health) = await (localMeetings, reminderSnapshot, spotifyTrack, healthSnapshot)

            guard let self else { return }
            self.meetings = meetings
            self.taskSummary = snapshot.summary
            self.priorityItems = snapshot.items
            self.health = health
            self.applyMusicUpdate(track ?? .empty, allowSongPeek: true)
            self.scheduleCalendarPeek()
        }
    }

    private func saveQuickApps() {
        NotchPreferences.quickAppBundleIdentifiers = quickApps.map(\.bundleIdentifier)
    }

    private func startCalendarChangeObserver() {
        guard calendarChangeObserver == nil else { return }

        calendarChangeObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name.EKEventStoreChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.scheduleCalendarChangeRefresh()
        }
    }

    private func scheduleCalendarChangeRefresh() {
        calendarChangeRefreshWorkItem?.cancel()

        let workItem = DispatchWorkItem { [weak self] in
            self?.refreshLocalData()
        }
        calendarChangeRefreshWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: workItem)
    }

    func toggleMusicPlayback() {
        Task { [weak self] in
            guard let self else { return }
            let (sourceName, isAvailable) = await MainActor.run { (self.music.sourceName, self.music.isAvailable) }
            guard isAvailable else {
                await MainActor.run { self.openPreferredMusicPlayer() }
                try? await Task.sleep(nanoseconds: 900_000_000)
                await self.syncMusicFromSpotify(markLiveActivity: true)
                return
            }
            await MainActor.run { self.optimisticallyToggleMusicPlayback() }
            await MediaProviderService.playPause(sourceName: sourceName)
            await MainActor.run { self.schedulePostCommandMusicSync(markLiveActivity: true) }
        }
    }

    func refreshMusicFromSpotify() {
        Task { [weak self] in
            await self?.syncMusicFromSpotify(markLiveActivity: false)
        }
    }

    func skipToPreviousTrack() {
        Task { [weak self] in
            guard let self else { return }
            let (sourceName, isAvailable) = await MainActor.run { (self.music.sourceName, self.music.isAvailable) }
            guard isAvailable else {
                await MainActor.run { self.openPreferredMusicPlayer() }
                return
            }
            await MediaProviderService.previousTrack(sourceName: sourceName)
            await MainActor.run { self.schedulePostCommandMusicSync(markLiveActivity: true) }
        }
    }

    func skipToNextTrack() {
        Task { [weak self] in
            guard let self else { return }
            let (sourceName, isAvailable) = await MainActor.run { (self.music.sourceName, self.music.isAvailable) }
            guard isAvailable else {
                await MainActor.run { self.openPreferredMusicPlayer() }
                return
            }
            await MediaProviderService.nextTrack(sourceName: sourceName)
            await MainActor.run { self.schedulePostCommandMusicSync(markLiveActivity: true) }
        }
    }

    func seekMusic(to progress: Double) {
        Task { [weak self] in
            guard let self else { return }
            let (durationSeconds, sourceName, isAvailable) = await MainActor.run { (self.music.durationSeconds, self.music.sourceName, self.music.isAvailable) }
            guard isAvailable else { return }
            await MainActor.run { self.optimisticallySeekMusic(to: progress) }
            await MediaProviderService.seek(to: progress, durationSeconds: durationSeconds, sourceName: sourceName)
            await MainActor.run { self.schedulePostCommandMusicSync(markLiveActivity: false, delay: 0.20) }
        }
    }

    @MainActor
    private func optimisticallyToggleMusicPlayback() {
        guard music.isAvailable else { return }
        music.isPlaying.toggle()
        updateAudioReactiveState()
    }

    @MainActor
    private func optimisticallySeekMusic(to progress: Double) {
        guard music.isAvailable else { return }
        let clampedProgress = min(max(progress, 0), 1)
        music.progress = clampedProgress
        if music.durationSeconds > 0 {
            music.positionSeconds = music.durationSeconds * clampedProgress
        }
        updateAudioReactiveState()
    }

    @MainActor
    private func schedulePostCommandMusicSync(markLiveActivity: Bool, delay: TimeInterval = 0.35) {
        musicCommandRefreshWorkItem?.cancel()

        let workItem = DispatchWorkItem { [weak self] in
            Task { [weak self] in
                await self?.syncMusicFromSpotify(markLiveActivity: markLiveActivity)
            }
        }
        musicCommandRefreshWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    @MainActor
    private func openPreferredMusicPlayer() {
        let workspace = NSWorkspace.shared
        if let spotifyURL = workspace.urlForApplication(withBundleIdentifier: "com.spotify.client") {
            workspace.open(spotifyURL)
            return
        }

        if let musicURL = workspace.urlForApplication(withBundleIdentifier: "com.apple.Music") {
            workspace.open(musicURL)
            return
        }

        if let youtubeMusicURL = URL(string: "https://music.youtube.com") {
            workspace.open(youtubeMusicURL)
        }
    }

    private func syncMusicFromSpotify(markLiveActivity: Bool) async {
        await MainActor.run {
            guard !isRefreshingMusic else { return }
            isRefreshingMusic = true
        }

        let track = await MediaProviderService.currentTrack()

        await MainActor.run {
            isRefreshingMusic = false
            applyMusicUpdate(track ?? .empty, allowSongPeek: true)
            if markLiveActivity && liveActivity != .songPeek {
                liveActivity = .resting
            }
        }
    }

    private func applyMusicUpdate(_ nextMusic: MusicState, allowSongPeek: Bool) {
        let previousMusic = music
        music = nextMusic
        updateAudioReactiveState()
        detectSongTransition(from: previousMusic, to: nextMusic, allowSongPeek: allowSongPeek)
    }

    private func detectSongTransition(from previousMusic: MusicState, to nextMusic: MusicState, allowSongPeek: Bool) {
        guard nextMusic.isAvailable else {
            hasSeenMusicTrack = false
            lastMusicPeekKey = nil
            dismissSongPeek()
            return
        }

        let nextKey = musicPeekKey(for: nextMusic)
        guard hasSeenMusicTrack else {
            hasSeenMusicTrack = true
            lastMusicPeekKey = nextKey
            return
        }

        guard nextKey != lastMusicPeekKey else { return }
        lastMusicPeekKey = nextKey

        guard allowSongPeek, !presentation.isExpanded else { return }
        presentSongPeek(nextMusic)
    }

    func updateAudioReactiveState(at date: Date = Date()) {
        audioReactiveState = AudioReactiveEngine.state(for: music, at: date)
    }

    func scheduleCalendarPeek(now: Date = Date()) {
        calendarPeekTimer?.invalidate()
        calendarPeekTimer = nil

        guard calendarPeekEnabled else {
            dismissCalendarPeek()
            return
        }

        guard let meeting = meetings
            .filter({ $0.startDate > now })
            .sorted(by: { $0.startDate < $1.startDate })
            .first
        else { return }

        let key = calendarPeekKey(for: meeting)
        let triggerDate = meeting.startDate.addingTimeInterval(-calendarPeekLeadTime)
        let delay = triggerDate.timeIntervalSince(now)

        if delay <= 0 {
            if lastCalendarPeekKey != key {
                presentCalendarPeek(meeting)
            }
            return
        }

        calendarPeekTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.presentCalendarPeek(meeting)
            }
        }
        calendarPeekTimer?.tolerance = min(max(delay * 0.08, 1), 30)
    }

    func presentCalendarPeek(_ meeting: MeetingItem) {
        guard calendarPeekEnabled else { return }
        guard !presentation.isExpanded else { return }

        lastCalendarPeekKey = calendarPeekKey(for: meeting)
        calendarPeekMeeting = meeting
        liveActivity = .calendarPeek

        calendarPeekDismissTimer?.invalidate()
        calendarPeekDismissTimer = Timer.scheduledTimer(withTimeInterval: calendarPeekDisplayDuration, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.dismissCalendarPeek()
            }
        }
    }

    func dismissCalendarPeek() {
        calendarPeekDismissTimer?.invalidate()
        calendarPeekDismissTimer = nil
        calendarPeekMeeting = nil
        if liveActivity == .calendarPeek {
            liveActivity = .resting
        }
    }

    func presentSongPeek(_ track: MusicState) {
        guard track.isAvailable else { return }
        guard !presentation.isExpanded else { return }

        calendarPeekDismissTimer?.invalidate()
        calendarPeekMeeting = nil
        songPeekTrack = track
        liveActivity = .songPeek

        songPeekDismissTimer?.invalidate()
        songPeekDismissTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.dismissSongPeek()
            }
        }
    }

    func dismissSongPeek() {
        songPeekDismissTimer?.invalidate()
        songPeekDismissTimer = nil
        songPeekTrack = nil
        if liveActivity == .songPeek {
            liveActivity = .resting
        }
    }

    private func calendarPeekKey(for meeting: MeetingItem) -> String {
        "\(meeting.title)|\(meeting.startDate.timeIntervalSince1970)"
    }

    private func musicPeekKey(for music: MusicState) -> String {
        "\(music.title)|\(music.artist)|\(music.artworkURL ?? "")"
    }

    func showMeetingActivity() {
        liveActivity = .meeting
        collapse()
    }

    func showCalendarBrowseActivity() {
        liveActivity = .calendarBrowse
        collapse()
    }
}

enum NotchLiveActivity: Equatable {
    case resting
    case music
    case meeting
    case calendarBrowse
    case calendarPeek
    case songPeek
    case fileDrop
}

enum NotchPresentationState: Equatable {
    case compact
    case expanded(NotchSection)
    case detail(NotchSection)
    case settings

    var isExpanded: Bool {
        switch self {
        case .compact:
            return false
        case .expanded, .detail, .settings:
            return true
        }
    }
}

enum NotchSection: String, CaseIterable, Identifiable {
    case odin = "ODIN"
    case priority = "PRIORITY"
    case calendar = "CALENDAR"
    case quickAccess = "QUICK ACCESS"

    var id: String { rawValue }
}

struct MusicState: Equatable {
    var title: String
    var artist: String
    var isPlaying: Bool
    var progress: Double
    var durationSeconds: Double = 0
    var positionSeconds: Double = 0
    var sourceName: String
    var artworkURL: String?
    var isAvailable: Bool = true

    static let empty = MusicState(
        title: "",
        artist: "",
        isPlaying: false,
        progress: 0,
        sourceName: "Spotify",
        artworkURL: nil,
        isAvailable: false
    )
}

struct MeetingItem: Identifiable, Equatable {
    let id = UUID()
    var time: String
    var timezone: String
    var title: String
    var startDate: Date = Date()
}

struct ClippedFile: Identifiable, Equatable {
    let id = UUID()
    var url: URL
    var name: String
    var addedAt: Date = Date()

    init(url: URL) {
        self.url = url
        self.name = url.lastPathComponent.isEmpty ? "File" : url.lastPathComponent
    }

    var systemImage: String {
        url.hasDirectoryPath ? "folder.fill" : "doc.fill"
    }

    var isImage: Bool {
        ["png", "jpg", "jpeg", "heic", "gif", "webp", "tiff"].contains(url.pathExtension.lowercased())
    }
}

enum OdinDropStatus: Equatable {
    case idle
    case pinned(String)
    case sending(String)
    case sent(String)
    case failed(String)

    var isVisible: Bool {
        self != .idle
    }

    var text: String {
        switch self {
        case .idle:
            return ""
        case .pinned(let message), .sending(let message), .sent(let message), .failed(let message):
            return message
        }
    }

    var title: String {
        switch self {
        case .idle:
            return "ODIN Drop"
        case .pinned:
            return "Pinned"
        case .sending:
            return "Sending"
        case .sent:
            return "Sent"
        case .failed:
            return "Needs attention"
        }
    }

    var icon: String {
        switch self {
        case .idle:
            return "circle"
        case .pinned:
            return "pin.fill"
        case .sending:
            return "paperplane.fill"
        case .sent:
            return "checkmark.circle.fill"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}

struct CorkNote: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var addedAt: Date = Date()
}

struct TaskSummary: Equatable {
    var urgent: Int
    var normal: Int
    var slack: Int
    var gmail: Int

    static let empty = TaskSummary(urgent: 0, normal: 0, slack: 0, gmail: 0)
}

struct PriorityItem: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var level: String
    var sourceSystemImage: String
}

struct QuickApp: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var bundleIdentifier: String
}

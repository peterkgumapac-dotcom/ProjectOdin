import Foundation

/// Local-first integration seams used by native services such as Spotify,
/// Calendar, Reminders, and Quick Access without adding a backend dependency.
protocol MusicProviding {
    func currentTrack() async -> MusicState?
    func playPause() async
    func next() async
    func previous() async
}

protocol CalendarProviding {
    func meetingsToday() async -> [MeetingItem]
}

protocol TaskProviding {
    func prioritySummary() async -> TaskSummary
}

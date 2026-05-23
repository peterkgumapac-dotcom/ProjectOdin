import EventKit
import Foundation

enum LocalCalendarService {
    static func meetingsToday(limit: Int = 4) async -> [MeetingItem] {
        await meetings(on: Date(), limit: limit)
    }

    static func meetings(on date: Date, limit: Int = 8) async -> [MeetingItem] {
        let store = EKEventStore()
        guard await requestAccess(store: store) else { return [] }

        let calendar = Calendar.current
        let start = calendar.startOfDay(for: date)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }

        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: predicate)
            .filter { !$0.isAllDay }
            .sorted { $0.startDate < $1.startDate }
            .prefix(limit)
            .map { event in
                MeetingItem(
                    time: Self.timeFormatter.string(from: event.startDate),
                    timezone: event.timeZone?.identifier ?? TimeZone.current.identifier,
                    title: event.title.isEmpty ? "Untitled meeting" : event.title,
                    startDate: event.startDate
                )
            }
    }

    private static func requestAccess(store: EKEventStore) async -> Bool {
        do {
            if #available(macOS 14.0, *) {
                return try await store.requestFullAccessToEvents()
            }

            return try await withCheckedThrowingContinuation { continuation in
                store.requestAccess(to: .event) { granted, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: granted)
                    }
                }
            }
        } catch {
            NSLog("ODINNotch calendar access failed: \(error.localizedDescription)")
            return false
        }
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()
}

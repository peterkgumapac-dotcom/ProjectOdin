import EventKit
import Foundation

struct LocalReminderSnapshot {
    var summary: TaskSummary
    var items: [PriorityItem]
}

enum LocalReminderService {
    static func prioritySnapshot(limit: Int = 3) async -> LocalReminderSnapshot {
        let store = EKEventStore()
        guard await requestAccess(store: store) else {
            return LocalReminderSnapshot(summary: TaskSummary(urgent: 0, normal: 0, slack: 0, gmail: 0), items: [])
        }

        let now = Date()
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: now)
        let predicate = store.predicateForIncompleteReminders(
            withDueDateStarting: nil,
            ending: tomorrow,
            calendars: nil
        )
        let reminders = await reminders(matching: predicate, store: store)
            .sorted { lhs, rhs in
                reminderDate(lhs) ?? .distantFuture < reminderDate(rhs) ?? .distantFuture
            }

        let urgentCount = reminders.filter { reminder in
            guard let dueDate = reminderDate(reminder) else { return false }
            return dueDate <= now
        }.count
        let normalCount = max(reminders.count - urgentCount, 0)
        let items = reminders.prefix(limit).map { reminder in
            PriorityItem(
                title: reminder.title.isEmpty ? "Untitled reminder" : reminder.title,
                level: reminderDate(reminder).map { $0 <= now ? "Overdue" : "Today" } ?? "Reminder",
                sourceSystemImage: "checklist"
            )
        }

        return LocalReminderSnapshot(
            summary: TaskSummary(urgent: urgentCount, normal: normalCount, slack: 0, gmail: 0),
            items: items
        )
    }

    private static func requestAccess(store: EKEventStore) async -> Bool {
        do {
            if #available(macOS 14.0, *) {
                return try await store.requestFullAccessToReminders()
            }

            return try await withCheckedThrowingContinuation { continuation in
                store.requestAccess(to: .reminder) { granted, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: granted)
                    }
                }
            }
        } catch {
            NSLog("ODINNotch reminders access failed: \(error.localizedDescription)")
            return false
        }
    }

    private static func reminders(matching predicate: NSPredicate, store: EKEventStore) async -> [EKReminder] {
        await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: reminders ?? [])
            }
        }
    }

    private static func reminderDate(_ reminder: EKReminder) -> Date? {
        guard let due = reminder.dueDateComponents else { return nil }
        return Calendar.current.date(from: due)
    }
}

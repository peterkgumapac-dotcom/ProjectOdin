import SwiftUI
import UniformTypeIdentifiers

struct PriorityPanelView: View {
    let summary: TaskSummary
    var items: [PriorityItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Priority snapshot")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(ODINDesign.primary)
            Text("\(summary.urgent) urgent · \(summary.normal) normal")
                .font(.system(size: 26, weight: .heavy))
                .foregroundStyle(ODINDesign.primary)
            ForEach(items.prefix(4)) { item in
                Label(item.title, systemImage: item.sourceSystemImage)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ODINDesign.secondary)
                    .lineLimit(1)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct CalendarPanelView: View {
    let meetings: [MeetingItem]
    @State private var selectedDate = Date()
    @State private var visibleMeetings: [MeetingItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Button(action: { moveDay(by: -1) }) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .heavy))
                        .frame(width: 30, height: 30)
                        .background(.white.opacity(0.08), in: Circle())
                }

                Spacer()

                Text(dayTitle)
                    .font(.system(size: 16, weight: .heavy))
                    .foregroundStyle(ODINDesign.primary)

                Spacer()

                Button(action: { moveDay(by: 1) }) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .heavy))
                        .frame(width: 30, height: 30)
                        .background(.white.opacity(0.08), in: Circle())
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(ODINDesign.primary)

            HStack(spacing: 8) {
                ForEach(dayOffsets, id: \.self) { offset in
                    let date = calendar.date(byAdding: .day, value: offset, to: Date()) ?? Date()
                    Button(action: { select(date) }) {
                        VStack(spacing: 3) {
                            Text(weekdayFormatter.string(from: date).uppercased())
                                .font(.system(size: 8, weight: .heavy))
                            Text(dayFormatter.string(from: date))
                                .font(.system(size: 13, weight: .heavy))
                        }
                        .foregroundStyle(calendar.isDate(date, inSameDayAs: selectedDate) ? .black : ODINDesign.primary)
                        .frame(width: 42, height: 42)
                        .background(calendar.isDate(date, inSameDayAs: selectedDate) ? ODINDesign.amber : .white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
            }

            if visibleMeetings.isEmpty {
                Text("No events")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(ODINDesign.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8)
            } else {
                ForEach(visibleMeetings) { meeting in
                    HStack(spacing: 12) {
                        Text(meeting.time)
                            .font(.system(size: 15, weight: .heavy))
                            .foregroundStyle(ODINDesign.amber)
                            .frame(width: 86, alignment: .leading)
                        Text(meeting.title)
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(ODINDesign.primary)
                            .lineLimit(1)
                        Text(meeting.timezone)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(ODINDesign.primary)
                            .lineLimit(1)
                    }
                }
            }

            Spacer()
        }
        .onAppear {
            visibleMeetings = meetings
            loadMeetings(for: selectedDate)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var calendar: Calendar { .current }
    private var dayOffsets: [Int] { [-3, -2, -1, 0, 1, 2, 3] }

    private var dayTitle: String {
        if calendar.isDateInToday(selectedDate) {
            return "Today"
        }
        return titleFormatter.string(from: selectedDate)
    }

    private func moveDay(by days: Int) {
        guard let date = calendar.date(byAdding: .day, value: days, to: selectedDate) else { return }
        select(date)
    }

    private func select(_ date: Date) {
        selectedDate = date
        loadMeetings(for: date)
    }

    private func loadMeetings(for date: Date) {
        Task { @MainActor in
            visibleMeetings = await LocalCalendarService.meetings(on: date)
        }
    }

    private var weekdayFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE"
        return formatter
    }

    private var dayFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.dateFormat = "d"
        return formatter
    }

    private var titleFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE, MMM d"
        return formatter
    }
}

struct QuickAccessPanelView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        HStack(spacing: 14) {
            PhoneDropButton()

            ForEach(FileShortcut.allCases) { shortcut in
                QuickFolderButton(shortcut: shortcut)
            }

            ForEach(model.quickApps.prefix(4)) { app in
                QuickAppButton(app: app)
                    .contextMenu {
                        Menu("Replace with") {
                            ForEach(model.installedApps) { replacement in
                                Button(replacement.name) {
                                    model.replaceQuickApp(app, with: replacement)
                                }
                            }
                        }
                        Button("Delete") { model.removeQuickApp(app) }
                    }
            }

            Menu {
                ForEach(model.installedApps) { app in
                    Button(action: { model.addQuickApp(app) }) {
                        Text(app.name)
                    }
                }
            } label: {
                VStack(spacing: 7) {
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .semibold))
                    Text("Add App")
                        .font(.system(size: 11, weight: .bold))
                }
                .foregroundStyle(ODINDesign.primary)
                .frame(width: 92, height: 92)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
            }
            .menuStyle(.borderlessButton)
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct PhoneDropButton: View {
    @State private var isTargeted = false

    var body: some View {
        Button(action: PhoneDropService.chooseAndSendFile) {
            VStack(spacing: 7) {
                Image(systemName: isTargeted ? "arrow.down.doc.fill" : "iphone")
                    .font(.system(size: 22, weight: .semibold))
                Text(isTargeted ? "Drop" : "Phone")
                    .font(.system(size: 11, weight: .bold))
                    .lineLimit(1)
                Text(isTargeted ? "send now" : "send file")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(ODINDesign.secondary)
                    .lineLimit(1)
            }
            .foregroundStyle(isTargeted ? ODINDesign.amber : ODINDesign.primary)
            .frame(width: 92, height: 92)
            .background(isTargeted ? ODINDesign.amber.opacity(0.14) : .white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(isTargeted ? ODINDesign.amber.opacity(0.85) : .white.opacity(0.08), lineWidth: isTargeted ? 1.5 : 1)
            }
            .scaleEffect(isTargeted ? 1.04 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.82), value: isTargeted)
        }
        .buttonStyle(.plain)
        .onDrop(of: [UTType.fileURL.identifier], isTargeted: $isTargeted) { providers in
            PhoneDropService.share(itemProviders: providers)
        }
        .help("Send a file to your paired phone with ODIN Drop")
    }
}

private struct QuickFolderButton: View {
    let shortcut: FileShortcut

    var body: some View {
        Button(action: { FileShortcutService.open(shortcut) }) {
            VStack(spacing: 7) {
                Image(systemName: shortcut.systemImage)
                    .font(.system(size: 22, weight: .semibold))
                Text(shortcut.rawValue)
                    .font(.system(size: 11, weight: .bold))
                    .lineLimit(1)
            }
            .foregroundStyle(ODINDesign.primary)
            .frame(width: 92, height: 92)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }
}

private struct QuickAppButton: View {
    let app: QuickApp

    var body: some View {
        Button(action: { QuickAppService.open(bundleIdentifier: app.bundleIdentifier) }) {
            VStack(spacing: 7) {
                AppIconImage(bundleIdentifier: app.bundleIdentifier)
                    .frame(width: 32, height: 32)
                Text(app.name)
                    .font(.system(size: 11, weight: .bold))
                    .lineLimit(1)
            }
            .foregroundStyle(ODINDesign.primary)
            .frame(width: 92, height: 92)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

}

struct AppIconImage: View {
    let bundleIdentifier: String

    var body: some View {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                .resizable()
                .aspectRatio(contentMode: .fit)
        } else {
            Image(systemName: "app")
                .font(.system(size: 28, weight: .semibold))
        }
    }
}

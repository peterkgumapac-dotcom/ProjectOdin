import SwiftUI

struct ExpandedNotchView: View {
    @ObservedObject var model: NotchModel
    let section: NotchSection
    var onSettings: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            content
                .padding(.top, 8)

            if section != .odin {
                Button(action: { model.presentation = .expanded(.odin) }) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 15, weight: .heavy))
                        .foregroundStyle(ODINDesign.primary)
                        .frame(width: 36, height: 36)
                        .background(.white.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }

            header
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 14)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Spacer()

            Button(action: {
                model.refreshGeometry()
                model.refreshLocalData()
            }) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(ODINDesign.primary)
                    .frame(width: 30, height: 30)
                    .background(.white.opacity(0.08), in: Circle())
            }
            .buttonStyle(.plain)

            Button(action: onSettings) {
                Image(systemName: "gearshape")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(ODINDesign.primary.opacity(0.75))
                    .frame(width: 30, height: 30)
                    .background(.white.opacity(0.08), in: Circle())
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch section {
        case .odin:
            OdinOverviewView(model: model)
        case .priority:
            PriorityPanelView(summary: model.taskSummary, items: model.priorityItems)
        case .calendar:
            CalendarPanelView(meetings: model.meetings)
        case .quickAccess:
            QuickAccessPanelView(model: model)
        }
    }
}

private struct HealthStripView: View {
    let snapshot: HealthSnapshot

    var body: some View {
        HStack(spacing: 10) {
            Label(heartText, systemImage: "heart")
            Text(sleepText)
            Text(stepsText)
        }
        .font(.system(size: 12, weight: .bold))
        .foregroundStyle(snapshot.connected ? ODINDesign.secondary : ODINDesign.tertiary)
        .labelStyle(.titleAndIcon)
        .padding(.horizontal, 12)
        .frame(height: 30)
        .background(.white.opacity(0.07), in: Capsule())
    }

    private var heartText: String {
        guard snapshot.connected else { return "--" }
        guard let heartBpm = snapshot.heartBpm else { return "HR --" }
        return "\(heartBpm)"
    }

    private var sleepText: String {
        guard snapshot.connected else { return "Sleep --" }
        guard let minutes = snapshot.sleepMinutes else { return "Sleep --" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return "\(hours)h \(remainder)m"
    }

    private var stepsText: String {
        guard snapshot.connected else { return "Steps --" }
        guard let steps = snapshot.steps else { return "Steps --" }
        if steps >= 1000 {
            let value = Double(steps) / 1000
            return value >= 10 ? "\(Int(value.rounded()))K" : String(format: "%.1fK", value)
        }
        return "\(steps)"
    }
}

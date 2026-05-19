import SwiftUI

enum NotchMode: String, Codable {
    case resting
    case music
    case musicPeek
    case meeting
    case calendarBrowse
    case fullAccess
}

struct CompactNotchDay: Codable, Hashable {
    let label: String
    let value: String
    let selected: Bool
}

struct CompactNotchView: View {
    let geometry: NotchGeometry
    let mode: NotchMode
    let title: String
    let subtitle: String
    let detail: String
    let artworkUrl: String
    let progress: Double
    let isPlaying: Bool
    let actionLabel: String
    let days: [CompactNotchDay]

    private static let amber = Color(red: 1.0, green: 0.58, blue: 0.05)
    private static let red = Color(red: 1.0, green: 0.28, blue: 0.28)
    private var notchDeadZoneWidth: CGFloat {
        max(geometry.notchWidth + 18, 176)
    }
    private var signalRowHeight: CGFloat {
        // AppKit reports the physical notch height through safeAreaInsets.top.
        // Ambient states should hug the real notch, with only a small halo below it.
        max(geometry.notchHeight + 6, 40)
    }

    init(
        geometry: NotchGeometry,
        mode: NotchMode = .resting,
        title: String = "",
        subtitle: String = "",
        detail: String = "",
        artworkUrl: String = "",
        progress: Double = 0,
        isPlaying: Bool = false,
        actionLabel: String = "",
        days: [CompactNotchDay] = []
    ) {
        self.geometry = geometry
        self.mode = mode
        self.title = title
        self.subtitle = subtitle
        self.detail = detail
        self.artworkUrl = artworkUrl
        self.progress = min(1, max(0, progress))
        self.isPlaying = isPlaying
        self.actionLabel = actionLabel
        self.days = days
    }

    static func windowSize(for geo: NotchGeometry, mode: NotchMode) -> CGSize {
        switch mode {
        case .resting:
            return CGSize(width: clamp(geo.notchWidth + 54, min: 218, max: 280), height: max(44, geo.notchHeight + 8))
        case .music:
            return CGSize(width: clamp(geo.notchWidth + 120, min: 270, max: 335), height: max(46, geo.notchHeight + 8))
        case .musicPeek:
            return CGSize(width: clamp(geo.notchWidth + 170, min: 300, max: 390), height: max(70, geo.notchHeight + 32))
        case .meeting, .calendarBrowse:
            return CGSize(width: clamp(geo.notchWidth + 250, min: 380, max: 500), height: max(78, geo.notchHeight + 40))
        case .fullAccess:
            return CGSize(width: clamp(geo.notchWidth + 86, min: 260, max: 330), height: max(54, geo.notchHeight + 20))
        }
    }

    static func windowOrigin(for geo: NotchGeometry, on screen: NSScreen, mode: NotchMode) -> CGPoint {
        let size = windowSize(for: geo, mode: mode)
        let notchCenterX = geo.notchX + (geo.notchWidth / 2)
        var x = notchCenterX - (size.width / 2)
        x = max(screen.frame.minX, min(x, screen.frame.maxX - size.width))
        return CGPoint(x: x, y: screen.frame.maxY - size.height)
    }

    var body: some View {
        surface {
            switch mode {
            case .resting:
                RestingNotchView(title: title, subtitle: subtitle, notchDeadZoneWidth: notchDeadZoneWidth)
            case .music:
                MusicAmbientNotchView(
                    isPlaying: isPlaying,
                    notchDeadZoneWidth: notchDeadZoneWidth,
                    signalRowHeight: signalRowHeight
                )
            case .musicPeek:
                MusicActivityNotchView(
                    title: title,
                    subtitle: subtitle,
                    artworkUrl: artworkUrl,
                    progress: progress,
                    isPlaying: isPlaying,
                    notchDeadZoneWidth: notchDeadZoneWidth,
                    signalRowHeight: signalRowHeight
                )
            case .meeting:
                MeetingActivityNotchView(
                    title: title,
                    subtitle: subtitle,
                    detail: detail,
                    actionLabel: actionLabel.isEmpty ? "Join" : actionLabel
                )
            case .calendarBrowse:
                CalendarBrowseNotchView(title: title, days: days)
            case .fullAccess:
                RestingNotchView(title: title, subtitle: subtitle, notchDeadZoneWidth: notchDeadZoneWidth)
            }
        }
        .frame(
            width: Self.windowSize(for: geometry, mode: mode).width,
            height: Self.windowSize(for: geometry, mode: mode).height,
            alignment: .top
        )
    }

    @ViewBuilder
    private func surface<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ZStack {
            NotchShape(bottomCornerRadius: (mode == .resting || mode == .music) ? 20 : 28)
                .fill(Color.black)
                .shadow(color: Color.black.opacity(mode == .resting ? 0.55 : 0.72), radius: mode == .resting ? 10 : 18, x: 0, y: mode == .resting ? 7 : 11)
                .clipShape(NotchShape(bottomCornerRadius: (mode == .resting || mode == .music) ? 20 : 28))

            content()
                .padding(.horizontal, (mode == .music || mode == .musicPeek) ? 0 : (mode == .resting ? 12 : 16))
                .padding(.top, (mode == .music || mode == .musicPeek) ? 0 : (mode == .resting ? 4 : 8))
                .padding(.bottom, (mode == .music || mode == .musicPeek) ? 0 : (mode == .resting ? 6 : 10))
        }
    }

    private static func clamp(_ value: CGFloat, min: CGFloat, max: CGFloat) -> CGFloat {
        Swift.min(Swift.max(value, min), max)
    }
}

private struct RestingNotchView: View {
    let title: String
    let subtitle: String
    let notchDeadZoneWidth: CGFloat

    private var hasContext: Bool {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSubtitle = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return (!trimmedTitle.isEmpty && trimmedTitle != "ODIN") || (!trimmedSubtitle.isEmpty && trimmedSubtitle != "Ready")
    }

    var body: some View {
        HStack(spacing: 0) {
            PulseRing()
                .frame(width: 44, alignment: .center)

            Color.clear
                .frame(width: notchDeadZoneWidth, height: 1)

            Group {
                if hasContext {
                    HStack(spacing: 6) {
                        Text(title.isEmpty ? "ODIN" : title)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.white.opacity(0.88))
                            .lineLimit(1)
                        if !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.system(size: 9, weight: .medium))
                                .foregroundColor(.white.opacity(0.52))
                                .lineLimit(1)
                        }
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .background(Color.white.opacity(0.045))
                    .clipShape(Capsule())
                } else {
                    Color.clear.frame(width: 44, height: 1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
}

private struct MusicAmbientNotchView: View {
    let isPlaying: Bool
    let notchDeadZoneWidth: CGFloat
    let signalRowHeight: CGFloat

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let protectedWidth = min(notchDeadZoneWidth, max(136, width - 84))
            let notchLeft = (width - protectedWidth) / 2
            let notchRight = notchLeft + protectedWidth
            let indicatorY = signalRowHeight / 2
            let pulseX = max(22, notchLeft - 16)
            let waveX = min(width - 22, notchRight + 16)

            ZStack(alignment: .topLeading) {
                Color.clear
                    .frame(width: protectedWidth, height: signalRowHeight)
                    .position(x: width / 2, y: signalRowHeight / 2)

                PulseRing()
                    .frame(width: 26, height: 26)
                    .position(x: pulseX, y: indicatorY)

                VisualizerHandle()
                    .opacity(isPlaying ? 1 : 0.34)
                    .frame(width: 28, height: 28)
                    .position(x: waveX, y: indicatorY)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

private struct MusicActivityNotchView: View {
    let title: String
    let subtitle: String
    let artworkUrl: String
    let progress: Double
    let isPlaying: Bool
    let notchDeadZoneWidth: CGFloat
    let signalRowHeight: CGFloat

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let height = proxy.size.height
            let protectedWidth = min(notchDeadZoneWidth, max(150, width - 138))
            let notchLeft = (width - protectedWidth) / 2
            let notchRight = notchLeft + protectedWidth
            let indicatorY = signalRowHeight / 2
            let contentY = signalRowHeight + max(12, (height - signalRowHeight) / 2) - 3
            let pulseX = max(28, notchLeft - 24)
            let waveX = min(width - 28, notchRight + 24)

            ZStack(alignment: .topLeading) {
                Color.clear
                    .frame(width: protectedWidth, height: signalRowHeight)
                    .position(x: width / 2, y: signalRowHeight / 2)

                PulseRing()
                    .frame(width: 36, height: 36)
                    .position(x: pulseX, y: indicatorY)

                VisualizerHandle()
                    .opacity(isPlaying ? 1 : 0.38)
                    .frame(width: 38, height: 38)
                    .position(x: waveX, y: indicatorY)

                HStack(spacing: 7) {
                    artwork
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title.isEmpty ? "No music playing" : title)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.white.opacity(0.96))
                            .lineLimit(1)
                        Text(subtitle.isEmpty ? "ODIN Music" : subtitle)
                            .font(.system(size: 8, weight: .medium))
                            .foregroundColor(.white.opacity(0.62))
                            .lineLimit(1)
                        ProgressBar(progress: progress)
                            .frame(width: 58)
                            .opacity(isPlaying ? 1 : 0.55)
                    }
                    .frame(maxWidth: 112, alignment: .leading)

                    Spacer(minLength: 6)

                    HStack(spacing: 5) {
                        TransportIcon(name: "backward.fill")
                        TransportIcon(name: isPlaying ? "pause.fill" : "play.fill")
                        TransportIcon(name: "forward.fill")
                    }
                }
                .frame(width: width - 24, height: 34, alignment: .center)
                .position(x: width / 2, y: min(height - 17, contentY))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder
    private var artwork: some View {
        if let url = URL(string: artworkUrl), !artworkUrl.isEmpty {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                MusicArtworkFallback()
            }
            .frame(width: 32, height: 32)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
            MusicArtworkFallback()
                .frame(width: 32, height: 32)
        }
    }
}

private struct MeetingActivityNotchView: View {
    let title: String
    let subtitle: String
    let detail: String
    let actionLabel: String

    var body: some View {
        HStack(spacing: 16) {
            PulseRing()
            HStack(spacing: 14) {
                HStack(spacing: 8) {
                    Image(systemName: "calendar")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white.opacity(0.8))
                    Text(detail.isEmpty ? "Now" : detail)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Color.orange)
                        .lineLimit(1)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.isEmpty ? "Meeting" : title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white.opacity(0.96))
                        .lineLimit(1)
                    Text(subtitle.isEmpty ? "ODIN Calendar" : subtitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.white.opacity(0.62))
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                HStack(spacing: 7) {
                    Image(systemName: "video.fill")
                        .font(.system(size: 10, weight: .semibold))
                    Text(actionLabel)
                        .font(.system(size: 11, weight: .semibold))
                }
                .foregroundColor(.white.opacity(0.92))
                .padding(.horizontal, 12)
                .frame(height: 30)
                .background(Color.white.opacity(0.085))
                .clipShape(Capsule())
            }
            .padding(.horizontal, 15)
            .frame(height: 52)
            .background(Color.white.opacity(0.035))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.white.opacity(0.075), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            PulseRing()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct CalendarBrowseNotchView: View {
    let title: String
    let days: [CompactNotchDay]

    private var visibleDays: [CompactNotchDay] {
        if days.isEmpty {
            return [
                CompactNotchDay(label: "M", value: "16", selected: false),
                CompactNotchDay(label: "T", value: "17", selected: false),
                CompactNotchDay(label: "W", value: "18", selected: true),
                CompactNotchDay(label: "T", value: "19", selected: false),
                CompactNotchDay(label: "F", value: "20", selected: false),
            ]
        }
        return Array(days.prefix(7))
    }

    var body: some View {
        HStack(spacing: 16) {
            PulseRing()
            HStack(spacing: 16) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(.white.opacity(0.58))
                Text(title.isEmpty ? "Today" : title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white.opacity(0.92))
                    .lineLimit(1)
                    .frame(minWidth: 74, alignment: .leading)
                HStack(spacing: 10) {
                    ForEach(visibleDays, id: \.self) { day in
                        VStack(spacing: 3) {
                            Text(day.label)
                                .font(.system(size: 9, weight: .medium))
                                .foregroundColor(.white.opacity(0.52))
                            Text(day.value)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(day.selected ? .black : .white.opacity(0.9))
                                .frame(width: 24, height: 24)
                                .background(day.selected ? Color.orange : Color.clear)
                                .clipShape(Circle())
                        }
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(.white.opacity(0.58))
            }
            .padding(.horizontal, 16)
            .frame(height: 58)
            .background(Color.white.opacity(0.035))
            .overlay(
                RoundedRectangle(cornerRadius: 19, style: .continuous)
                    .stroke(Color.white.opacity(0.075), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
            PulseRing()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct PulseRing: View {
    var body: some View {
        Circle()
            .fill(Color.black)
            .frame(width: 30, height: 30)
            .overlay(Circle().stroke(Color.white.opacity(0.06), lineWidth: 1))
            .overlay(
                Circle()
                    .stroke(Color.orange.opacity(0.55), lineWidth: 2)
                    .frame(width: 8, height: 8)
            )
            .shadow(color: Color.orange.opacity(0.34), radius: 8)
    }
}

private struct VisualizerHandle: View {
    private let bars: [CGFloat] = [9, 14, 19, 24, 17, 11]

    var body: some View {
        Circle()
            .fill(Color.black)
            .frame(width: 31, height: 31)
            .overlay(Circle().stroke(Color.white.opacity(0.07), lineWidth: 1))
            .overlay(
                HStack(spacing: 1.5) {
                    ForEach(Array(bars.enumerated()), id: \.offset) { _, height in
                        Capsule()
                            .fill(Color.orange)
                            .frame(width: 1.7, height: height * 0.48)
                            .shadow(color: Color.orange.opacity(0.5), radius: 4)
                    }
                }
            )
            .shadow(color: Color.orange.opacity(0.28), radius: 8)
    }
}

private struct TransportIcon: View {
    let name: String

    var body: some View {
        Circle()
            .fill(Color.white.opacity(0.1))
            .frame(width: 21, height: 21)
            .overlay(
                Image(systemName: name)
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(.white.opacity(0.92))
            )
    }
}

private struct ProgressBar: View {
    let progress: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.16))
                Capsule()
                    .fill(Color.orange)
                    .frame(width: max(12, proxy.size.width * progress))
            }
        }
        .frame(width: 58, height: 3)
    }
}

private struct MusicArtworkFallback: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        Color(red: 0.95, green: 0.42, blue: 0.12),
                        Color(red: 0.50, green: 0.02, blue: 0.16),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay(
                Image(systemName: "music.note")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(Color.black.opacity(0.58))
            )
    }
}

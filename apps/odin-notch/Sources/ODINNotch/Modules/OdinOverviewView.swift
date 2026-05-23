import SwiftUI
import UniformTypeIdentifiers

struct OdinOverviewView: View {
    @ObservedObject var model: NotchModel

    var body: some View {
        GeometryReader { proxy in
            let spacing: CGFloat = 12
            let dividerLaneWidth: CGFloat = 18
            let contentWidth = max(proxy.size.width - (spacing * 4) - (dividerLaneWidth * 2), 0)
            let musicWidth = min(max(contentWidth * 0.28, 340), 340)
            let calendarWidth = min(max(contentWidth * 0.16, 182), 205)
            let quickWidth = max(contentWidth - musicWidth - calendarWidth, 318)
            let ambientActive = model.music.isPlaying

            HStack(spacing: spacing) {
                MusicMiniView(model: model)
                    .frame(width: musicWidth, alignment: .leading)
                    .clipped()

                ModuleDivider(ambientActive: ambientActive)

                CalendarMiniListView(meetings: Array(model.meetings.prefix(4)), ambientActive: ambientActive) {
                    model.presentation = .expanded(.calendar)
                }
                .frame(width: calendarWidth, alignment: .leading)

                ModuleDivider(ambientActive: ambientActive)

                QuickAppsPreviewView(model: model, ambientActive: ambientActive)
                    .frame(width: quickWidth, alignment: .leading)
                    .padding(.top, 34)
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

private struct ModuleDivider: View {
    let ambientActive: Bool

    var body: some View {
        ZStack(alignment: .top) {
            Rectangle()
                .fill(
                    LinearGradient(
                        stops: [
                            .init(color: .white.opacity(0.0), location: 0.0),
                            .init(color: .white.opacity(0.035), location: 0.18),
                            .init(color: .white.opacity(0.10), location: 0.48),
                            .init(color: .white.opacity(0.035), location: 0.82),
                            .init(color: .white.opacity(0.0), location: 1.0)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .frame(width: 1)

            Capsule()
                .fill(ODINDesign.amber.opacity(ambientActive ? 0.16 : 0.0))
                .frame(width: 6, height: 166)
                .blur(radius: ambientActive ? 6 : 0)

            Rectangle()
                .fill(.white.opacity(ambientActive ? 0.13 : 0.08))
                .frame(width: 1.4, height: 152)
                .offset(y: 6)
        }
        .frame(width: 18)
        .frame(maxHeight: 172)
    }
}

struct MusicMiniView: View {
    @ObservedObject var model: NotchModel
    @State private var wakeLightsOn = false
    @State private var wakeStageOpen = false

    var body: some View {
        let wakeProgress: CGFloat = wakeStageOpen ? 1 : 0
        let lightProgress: CGFloat = wakeLightsOn ? 1 : 0

        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .center, spacing: 10) {
                MusicBounceLane(music: model.music, activationProgress: wakeProgress)
                    .frame(width: 58)

                HStack(spacing: 9) {
                    Text("MUSIC")
                        .font(.system(size: 9, weight: .heavy))
                        .tracking(1.5)
                        .foregroundStyle(ODINDesign.secondary)

                    MediaSourceBadge(music: model.music)
                }
                .padding(.horizontal, 10)
                .frame(height: 30, alignment: .center)
                .background(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(.white.opacity(0.030))
                        .overlay {
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .stroke(.white.opacity(0.055), lineWidth: 1)
                        }
                )
            }
            .frame(height: 48, alignment: .center)

            HStack(alignment: .top, spacing: 10) {
                ZStack(alignment: .bottomTrailing) {
                    AlbumArtworkView(music: model.music, cornerRadius: 14)
                        .frame(width: 132, height: 132)

                    if model.music.isAvailable {
                        Circle()
                            .fill(Color(red: 0.12, green: 0.78, blue: 0.34))
                            .frame(width: 17, height: 17)
                            .overlay(Image(systemName: "music.note").font(.system(size: 9, weight: .black)).foregroundStyle(.black))
                            .offset(x: 5, y: 5)
                    }
                }
                .frame(width: 140, height: 148, alignment: .topLeading)
                .background {
                    AlbumArtworkStage(music: model.music, activationProgress: lightProgress)
                        .frame(width: 140, height: 148)
                }

                VStack(alignment: .leading, spacing: 4) {
                    VStack(alignment: .leading, spacing: 2) {
                        MarqueeText(
                            text: model.music.isAvailable ? model.music.title : "Spotify idle",
                            font: .system(size: 17, weight: .bold),
                            color: ODINDesign.primary
                        )
                        .frame(width: 152, height: 24, alignment: .leading)
                        .clipShape(Rectangle())
                        .clipped()

                        HStack(spacing: 6) {
                            if model.music.isAvailable {
                                Circle()
                                    .fill(Color(red: 0.12, green: 0.78, blue: 0.34))
                                    .frame(width: 7, height: 7)
                            }

                            Text(model.music.isAvailable ? model.music.artist : "Open Spotify or press play")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(ODINDesign.secondary)
                                .lineLimit(1)
                        }
                    }
                    .frame(width: 152, height: 40, alignment: .bottomLeading)

                    HStack(spacing: 8) {
                        MusicRoundButton(systemName: "backward.end.fill", action: model.skipToPreviousTrack)
                        MusicRoundButton(systemName: model.music.isPlaying ? "pause.fill" : "play.fill", size: 36, isPrimary: true, action: model.toggleMusicPlayback)
                        MusicRoundButton(systemName: "forward.end.fill", action: model.skipToNextTrack)
                    }
                    .frame(height: 36)

                    if model.music.isAvailable {
                        MusicScrubberView(music: model.music, onSeek: model.seekMusic)
                            .frame(width: 126, height: 42)
                            .layoutPriority(1)
                    }
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .frame(width: 172, height: 148, alignment: .topLeading)
                .background(NowPlayingInfoPlate(music: model.music, activationProgress: lightProgress))
            }
            .padding(8)
            .background(
                RoundedRectangle(cornerRadius: 19, style: .continuous)
                    .fill(.white.opacity(0.018))
                    .overlay {
                        RoundedRectangle(cornerRadius: 19, style: .continuous)
                            .stroke(.white.opacity(0.035), lineWidth: 1)
                    }
            )
            .overlay {
                MusicWakeGlow(progress: lightProgress, isPlaying: model.music.isPlaying)
                    .allowsHitTesting(false)
            }
        }
        .overlay(alignment: .topLeading) {
            TimelineView(.animation) { timeline in
                let reactive = AudioReactiveEngine.state(for: model.music, at: timeline.date)
                let origin = MusicOrbKinematics.position(
                    for: model.music,
                    in: MusicOrbKinematics.laneSize,
                    at: timeline.date,
                    activationProgress: wakeProgress,
                    reactive: reactive
                )

                SphereOriginLightBeam(
                    origin: origin,
                    progress: lightProgress,
                    reactive: reactive,
                    isPlaying: model.music.isPlaying
                )
                .allowsHitTesting(false)
            }
        }
        .onAppear {
            wakeLightsOn = model.music.isPlaying
            wakeStageOpen = model.music.isPlaying
        }
        .onChange(of: model.music.isPlaying) { isPlaying in
            if isPlaying {
                wakeLightsOn = false
                wakeStageOpen = false
                withAnimation(.easeOut(duration: 0.16)) {
                    wakeLightsOn = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                    withAnimation(.spring(response: 0.54, dampingFraction: 0.72)) {
                        wakeStageOpen = true
                    }
                }
            } else {
                withAnimation(.easeOut(duration: 0.26)) {
                    wakeLightsOn = false
                    wakeStageOpen = false
                }
            }
        }
    }
}

private struct MediaSourceBadge: View {
    let music: MusicState

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: sourceIcon)
                .font(.system(size: 7.5, weight: .black))
            Text(sourceLabel)
                .font(.system(size: 7.5, weight: .black))
                .tracking(0.6)
                .lineLimit(1)
        }
        .foregroundStyle(music.isPlaying ? ODINDesign.primary : ODINDesign.secondary)
        .padding(.horizontal, 7)
        .frame(height: 18)
        .background(.white.opacity(music.isPlaying ? 0.10 : 0.055), in: Capsule())
        .overlay {
            Capsule()
                .stroke(.white.opacity(music.isPlaying ? 0.12 : 0.055), lineWidth: 1)
        }
        .opacity(music.isAvailable ? 1 : 0.55)
    }

    private var sourceLabel: String {
        if music.sourceName.localizedCaseInsensitiveContains("apple") {
            return "MUSIC"
        }
        if music.sourceName.localizedCaseInsensitiveContains("spotify") {
            return "SPOTIFY"
        }
        return music.sourceName.uppercased()
    }

    private var sourceIcon: String {
        if music.sourceName.localizedCaseInsensitiveContains("apple") {
            return "music.note"
        }
        if music.sourceName.localizedCaseInsensitiveContains("spotify") {
            return "dot.radiowaves.left.and.right"
        }
        return "play.circle.fill"
    }
}

private struct AlbumArtworkStage: View {
    let music: MusicState
    let activationProgress: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: 19, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        .white.opacity(music.isAvailable ? 0.12 : 0.055),
                        ODINDesign.amber.opacity(0.050 + (0.075 * activationProgress)),
                        .black.opacity(0.12)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay {
                RoundedRectangle(cornerRadius: 19, style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [.white.opacity(0.18), ODINDesign.amber.opacity(0.10 + (0.18 * activationProgress)), .white.opacity(0.04)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            }
            .shadow(color: ODINDesign.amber.opacity(0.08 + (0.20 * activationProgress)), radius: 8 + (12 * activationProgress), x: 0, y: 6)
    }
}

private struct NowPlayingInfoPlate: View {
    let music: MusicState
    let activationProgress: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        .white.opacity(0.050 + (0.040 * activationProgress)),
                        ODINDesign.amber.opacity(0.018 + (0.050 * activationProgress)),
                        .white.opacity(0.025)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [.white.opacity(0.14), ODINDesign.amber.opacity(0.08 + (0.18 * activationProgress)), .white.opacity(0.035)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            }
            .overlay(alignment: .topLeading) {
                Circle()
                    .fill((music.isPlaying ? ODINDesign.amber : .white).opacity(0.06 + (0.16 * activationProgress)))
                    .frame(width: 42, height: 42)
                    .blur(radius: 15)
                    .offset(x: -16, y: -18)
            }
            .shadow(color: ODINDesign.amber.opacity(0.04 + (0.12 * activationProgress)), radius: 7 + (8 * activationProgress), x: 0, y: 5)
    }
}

private struct MusicWakeGlow: View {
    let progress: CGFloat
    let isPlaying: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(
                    LinearGradient(
                        colors: [
                            ODINDesign.amber.opacity(0.26 * progress),
                            ODINDesign.amber.opacity(0.06 * progress),
                            .clear
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1.1
                )

            Circle()
                .fill(ODINDesign.amber.opacity(0.18 * progress))
                .frame(width: 122, height: 122)
                .blur(radius: 30)
                .offset(x: -32 + (12 * progress), y: -34 + (8 * progress))
                .opacity(isPlaying ? 1 : 0)
        }
        .opacity(progress)
    }
}

private struct SphereOriginLightBeam: View {
    let origin: CGPoint
    let progress: CGFloat
    let reactive: AudioReactiveState
    let isPlaying: Bool

    var body: some View {
        let beat = max(progress, reactive.beatPulse * 0.42)
        let softenedProgress = progress * 0.74

        ZStack(alignment: .topLeading) {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            ODINDesign.amber.opacity(0.22 * beat),
                            ODINDesign.amber.opacity(0.08 * softenedProgress),
                            .clear
                        ],
                        center: .center,
                        startRadius: 4,
                        endRadius: 88
                    )
                )
                .frame(width: 176, height: 176)
                .offset(x: origin.x - 88, y: origin.y - 88)
                .blur(radius: 7)

            Capsule()
                .fill(
                    LinearGradient(
                        colors: [
                            ODINDesign.amber.opacity(0.15 * beat),
                            ODINDesign.amber.opacity(0.07 * softenedProgress),
                            ODINDesign.amber.opacity(0.015 * softenedProgress),
                            .clear
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: 254, height: 64 + (8 * reactive.beatPulse))
                .blur(radius: 22)
                .rotationEffect(.degrees(6))
                .offset(x: origin.x + 18, y: origin.y + 12)
                .scaleEffect(x: 0.68 + (0.32 * progress), y: 0.84 + (0.16 * progress), anchor: .leading)

            Capsule()
                .fill(
                    LinearGradient(
                        colors: [
                            ODINDesign.amber.opacity(0.24 * beat),
                            ODINDesign.amber.opacity(0.09 * softenedProgress),
                            .clear
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: 216, height: 2.4)
                .blur(radius: 1.3)
                .offset(x: origin.x + 34, y: origin.y + 49)
        }
        .frame(width: 352, height: 190, alignment: .topLeading)
        .mask(alignment: .topLeading) {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            .black,
                            .black.opacity(0.82),
                            .black.opacity(0.22),
                            .clear
                        ],
                        center: .center,
                        startRadius: 4,
                        endRadius: 176
                    )
                )
                .frame(width: 352, height: 352)
                .scaleEffect(x: 1.18, y: 0.72, anchor: .center)
                .offset(x: origin.x - 112, y: origin.y - 126)
        }
        .opacity(isPlaying ? progress : 0)
        .blendMode(.screen)
        .drawingGroup()
    }
}

private enum MusicOrbMood {
    case fast
    case chill
    case steady
}

private struct MusicOrbKinematics {
    static let laneSize = CGSize(width: 58, height: 60)

    static func position(
        for music: MusicState,
        in bounds: CGSize,
        at date: Date,
        activationProgress: CGFloat,
        reactive: AudioReactiveState
    ) -> CGPoint {
        let margin: CGFloat = 18
        let left = margin
        let right = max(bounds.width - margin, left)
        let top = margin
        let bottom = max(bounds.height - margin, top)
        let idleX = min(max(bounds.width * 0.18, left + 22), right)
        let idleY = min(max(bounds.height * 0.48, top + 10), bottom)
        let idlePoint = CGPoint(x: idleX, y: idleY)

        guard music.isPlaying else {
            return idlePoint
        }

        let elapsed = date.timeIntervalSinceReferenceDate
        let seed = CGFloat(trackVariant(for: music)) * 0.19
        let xProgress = smoothPingPong(CGFloat(elapsed / horizontalDuration(for: music)) + seed)
        let gravityY = spaceBounceProgress(for: music, at: elapsed, reactive: reactive)
        let drift = CGFloat(sin((elapsed / 9.0) + Double(trackVariant(for: music)))) * 0.025

        let activePoint = CGPoint(
            x: interpolate(left, right, min(max(xProgress + drift, 0), 1)),
            y: interpolate(top, bottom, gravityY)
        )
        let easedProgress = 0.5 - (cos(min(max(activationProgress, 0), 1) * .pi) / 2)

        return CGPoint(
            x: interpolate(idlePoint.x, activePoint.x, easedProgress),
            y: interpolate(idlePoint.y, activePoint.y, easedProgress)
        )
    }

    private static func horizontalDuration(for music: MusicState) -> TimeInterval {
        switch mood(for: music) {
        case .fast:
            return 4.8
        case .chill:
            return 9.2
        case .steady:
            return 6.6
        }
    }

    private static func spaceBounceProgress(for music: MusicState, at elapsed: TimeInterval, reactive: AudioReactiveState) -> CGFloat {
        let travel = max((60 / max(reactive.tempo, 1)) * 5.2, 2.2)
        let phase = CGFloat((elapsed.truncatingRemainder(dividingBy: travel)) / travel)
        let base = 0.5 - (cos(phase * .pi * 2) / 2)
        let float = CGFloat(sin((elapsed / 3.2) + Double(trackVariant(for: music)))) * 0.08
        let beatLift = reactive.beatPulse * 0.10
        return min(max(base + float - beatLift, 0), 1)
    }

    private static func mood(for music: MusicState) -> MusicOrbMood {
        let text = "\(music.title) \(music.artist)".lowercased()
        let fastKeywords = ["rock", "metal", "punk", "edm", "dance", "remix", "bilmuri", "yeti", "head first"]
        let chillKeywords = ["acoustic", "lofi", "sleep", "ambient", "piano", "chill", "soft", "slow"]

        if fastKeywords.contains(where: { text.contains($0) }) {
            return .fast
        }
        if chillKeywords.contains(where: { text.contains($0) }) {
            return .chill
        }
        return .steady
    }

    private static func trackVariant(for music: MusicState) -> Int {
        let text = "\(music.title)|\(music.artist)"
        return abs(text.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }) % 4
    }

    private static func interpolate(_ start: CGFloat, _ end: CGFloat, _ progress: CGFloat) -> CGFloat {
        start + ((end - start) * progress)
    }

    private static func smoothPingPong(_ value: CGFloat) -> CGFloat {
        let wrapped = value.truncatingRemainder(dividingBy: 2)
        let positive = wrapped < 0 ? wrapped + 2 : wrapped
        let linear = positive <= 1 ? positive : 2 - positive
        return 0.5 - (cos(linear * .pi) / 2)
    }
}

private struct MusicScrubberView: View {
    let music: MusicState
    let onSeek: (Double) -> Void
    @State private var previewProgress: Double?
    @State private var isHovering = false

    var body: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width, 1)
            let progress = clamped(previewProgress ?? music.progress)

            VStack(spacing: 5) {
                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(.clear)
                        .frame(height: 24)

                    Capsule()
                        .fill(.white.opacity(isHovering ? 0.30 : 0.22))
                        .frame(height: 5)

                    Capsule()
                        .fill(ODINDesign.amber)
                        .frame(width: width * progress, height: 5)

                    Circle()
                        .fill(ODINDesign.amber)
                        .frame(width: isHovering ? 10 : 7, height: isHovering ? 10 : 7)
                        .shadow(color: ODINDesign.amber.opacity(0.55), radius: 5)
                        .offset(x: max((width * progress) - (isHovering ? 5 : 3.5), 0))
                }
                .frame(height: 24)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            previewProgress = clamped(value.location.x / width)
                        }
                        .onEnded { value in
                            let nextProgress = clamped(value.location.x / width)
                            previewProgress = nil
                            onSeek(nextProgress)
                        }
                )
                .onHover { hovering in
                    isHovering = hovering
                }

                HStack {
                    Text(formatTime(elapsedSeconds(progress: progress)))
                    Spacer()
                    Text("-\(formatTime(max(durationSeconds - elapsedSeconds(progress: progress), 0)))")
                }
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(ODINDesign.tertiary)
            }
        }
    }

    private var durationSeconds: Int {
        let duration = music.durationSeconds > 0 ? music.durationSeconds : 241
        return max(Int(duration.rounded()), 1)
    }

    private func elapsedSeconds(progress: Double) -> Int {
        min(max(Int(Double(durationSeconds) * progress), 0), durationSeconds)
    }

    private func formatTime(_ seconds: Int) -> String {
        "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }

    private func clamped(_ value: Double) -> Double {
        min(max(value, 0), 1)
    }

    private func clamped(_ value: CGFloat) -> Double {
        min(max(Double(value), 0), 1)
    }
}

private struct MarqueeText: View {
    let text: String
    let font: Font
    let color: Color
    @State private var isHovering = false
    @State private var startDate = Date()

    var body: some View {
        GeometryReader { proxy in
            let estimatedWidth = CGFloat(text.count) * 12.2
            let shouldScroll = estimatedWidth > proxy.size.width + 8
            let marqueeWidth = max(estimatedWidth, proxy.size.width + 40)
            let spacing: CGFloat = 42
            let travel = marqueeWidth + spacing
            let speed: CGFloat = 30

            Group {
                if shouldScroll {
                    TimelineView(.animation) { timeline in
                        let elapsed = max(timeline.date.timeIntervalSince(startDate), 0)
                        let offset = isHovering ? 0 : -CGFloat(elapsed * Double(speed)).truncatingRemainder(dividingBy: travel)

                        ZStack(alignment: .leading) {
                            HStack(spacing: spacing) {
                                titleText
                                    .frame(width: marqueeWidth, alignment: .leading)

                                titleText
                                    .frame(width: marqueeWidth, alignment: .leading)
                            }
                            .offset(x: offset)
                        }
                        .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
                        .clipped()
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
                    .clipped()
                    .mask(
                        LinearGradient(
                            stops: [
                                .init(color: .clear, location: 0),
                                .init(color: .black, location: 0.08),
                                .init(color: .black, location: 0.86),
                                .init(color: .clear, location: 1)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                } else {
                    Text(text)
                        .font(font)
                        .foregroundStyle(color)
                        .shadow(color: .black.opacity(0.95), radius: 2, x: 0, y: 1)
                        .shadow(color: .white.opacity(0.08), radius: 0, x: 0, y: 0)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .onAppear {
                startDate = Date()
            }
            .onChange(of: text) { _ in
                startDate = Date()
            }
            .onHover { hovering in
                isHovering = hovering
            }
        }
        .clipped()
    }

    private var titleText: some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .shadow(color: .black.opacity(0.95), radius: 2, x: 0, y: 1)
            .shadow(color: .white.opacity(0.08), radius: 0, x: 0, y: 0)
            .lineLimit(1)
    }
}

private struct MusicBounceLane: View {
    let music: MusicState
    let activationProgress: CGFloat

    var body: some View {
        GeometryReader { proxy in
            TimelineView(.animation) { timeline in
                orbView(in: proxy.size, at: timeline.date)
            }
        }
        .frame(height: 60)
        .accessibilityLabel(music.isPlaying ? "ODIN music pulse active" : "ODIN idle")
    }

    private func orbView(in size: CGSize, at date: Date) -> some View {
        let shellSize: CGFloat = 34
        let pulseSize: CGFloat = 13
        let reactive = AudioReactiveEngine.state(for: music, at: date)
        let position = MusicOrbKinematics.position(for: music, in: size, at: date, activationProgress: activationProgress, reactive: reactive)
        let glowProgress = music.isPlaying ? max(activationProgress, reactive.beatPulse * 0.40) : 0

        return ZStack {
            Circle()
                .fill(ODINDesign.amber.opacity(0.14 * glowProgress))
                .frame(width: 48 + (12 * activationProgress), height: 48 + (12 * activationProgress))
                .blur(radius: 14)
                .scaleEffect(0.78 + (0.24 * activationProgress))

            Circle()
                .fill(.black)
                .frame(width: shellSize, height: shellSize)
                .overlay(Circle().stroke(.white.opacity(reactive.isReactive ? 0.08 : 0.045), lineWidth: 1))
                .shadow(color: ODINDesign.amber.opacity(0.10 + (0.22 * glowProgress)), radius: 6 + (14 * glowProgress))

            PulseOrbView(size: pulseSize, music: music)
        }
        .scaleEffect(0.92 + (0.08 * activationProgress))
        .position(x: position.x, y: position.y)
    }

    private func position(in bounds: CGSize, at date: Date, reactive: AudioReactiveState) -> CGPoint {
        let margin: CGFloat = 18
        let left = margin
        let right = max(bounds.width - margin, left)
        let top = margin
        let bottom = max(bounds.height - margin, top)
        let idleX = min(max(bounds.width * 0.18, left + 22), right)
        let idleY = min(max(bounds.height * 0.48, top + 10), bottom)
        let idlePoint = CGPoint(x: idleX, y: idleY)

        guard music.isPlaying else {
            return idlePoint
        }

        let elapsed = date.timeIntervalSinceReferenceDate
        let seed = CGFloat(trackVariant) * 0.19
        let xProgress = smoothPingPong(CGFloat(elapsed / horizontalDuration) + seed)
        let gravityY = spaceBounceProgress(at: elapsed, reactive: reactive)
        let drift = CGFloat(sin((elapsed / 9.0) + Double(trackVariant))) * 0.025

        let activePoint = CGPoint(
            x: interpolate(left, right, min(max(xProgress + drift, 0), 1)),
            y: interpolate(top, bottom, gravityY)
        )
        let easedProgress = 0.5 - (cos(min(max(activationProgress, 0), 1) * .pi) / 2)

        return CGPoint(
            x: interpolate(idlePoint.x, activePoint.x, easedProgress),
            y: interpolate(idlePoint.y, activePoint.y, easedProgress)
        )
    }

    private var trailOffset: CGSize {
        let strength: CGFloat = music.isPlaying ? 5 : 0
        return CGSize(width: strength, height: strength * 0.45)
    }

    private var beatPeriod: TimeInterval {
        secondsPerBeat
    }

    private var estimatedBPM: Double {
        switch musicMood {
        case .fast:
            return 150
        case .chill:
            return 76
        case .steady:
            return 104
        }
    }

    private var secondsPerBeat: TimeInterval {
        60 / estimatedBPM
    }

    private var horizontalDuration: TimeInterval {
        switch musicMood {
        case .fast:
            return 4.8
        case .chill:
            return 9.2
        case .steady:
            return 6.6
        }
    }

    private var musicMood: MusicMood {
        let text = "\(music.title) \(music.artist)".lowercased()
        let fastKeywords = ["rock", "metal", "punk", "edm", "dance", "remix", "bilmuri", "yeti", "head first"]
        let chillKeywords = ["acoustic", "lofi", "sleep", "ambient", "piano", "chill", "soft", "slow"]

        if fastKeywords.contains(where: { text.contains($0) }) {
            return .fast
        }
        if chillKeywords.contains(where: { text.contains($0) }) {
            return .chill
        }
        return .steady
    }

    private func interpolate(_ start: CGFloat, _ end: CGFloat, _ progress: CGFloat) -> CGFloat {
        start + ((end - start) * progress)
    }

    private func smoothPingPong(_ value: CGFloat) -> CGFloat {
        let wrapped = value.truncatingRemainder(dividingBy: 2)
        let positive = wrapped < 0 ? wrapped + 2 : wrapped
        let linear = positive <= 1 ? positive : 2 - positive
        return 0.5 - (cos(linear * .pi) / 2)
    }

    private func spaceBounceProgress(at elapsed: TimeInterval, reactive: AudioReactiveState) -> CGFloat {
        let travel = max((60 / max(reactive.tempo, 1)) * 5.2, 2.2)
        let phase = CGFloat((elapsed.truncatingRemainder(dividingBy: travel)) / travel)
        let base = 0.5 - (cos(phase * .pi * 2) / 2)
        let float = CGFloat(sin((elapsed / 3.2) + Double(trackVariant))) * 0.08
        let beatLift = reactive.beatPulse * 0.10
        return min(max(base + float - beatLift, 0), 1)
    }

    private var reboundStrength: CGFloat {
        switch musicMood {
        case .fast:
            return 0.62
        case .chill:
            return 0.32
        case .steady:
            return 0.48
        }
    }

    private var trackVariant: Int {
        let text = "\(music.title)|\(music.artist)"
        return abs(text.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }) % 4
    }

    private enum MusicMood {
        case fast
        case chill
        case steady
    }
}

private struct MusicRoundButton: View {
    let systemName: String
    var size: CGFloat = 28
    var isPrimary: Bool = false
    let action: () -> Void
    @State private var lastFireDate = Date.distantPast

    var body: some View {
        ZStack {
            Circle()
                .fill(.white.opacity(isPrimary ? 0.14 : 0.10))
                .frame(width: size, height: size)
                .overlay(Circle().stroke(.white.opacity(isPrimary ? 0.10 : 0.0), lineWidth: 1))

            Image(systemName: systemName)
                .font(.system(size: isPrimary ? 14 : 12, weight: .bold))
                .foregroundStyle(ODINDesign.primary)
        }
        .frame(width: max(size, 42), height: max(size, 42))
        .contentShape(Circle())
        .onTapGesture(perform: fire)
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .zIndex(10)
    }

    private func fire() {
        let now = Date()
        guard now.timeIntervalSince(lastFireDate) > 0.18 else { return }
        lastFireDate = now
        action()
    }

    private var accessibilityLabel: String {
        if systemName.contains("pause") || systemName.contains("play") {
            return systemName.contains("pause") ? "Pause" : "Play"
        }
        return systemName.contains("backward") ? "Previous Track" : "Next Track"
    }
}

private struct AlbumArtworkView: View {
    let music: MusicState
    let cornerRadius: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius)
                .fill(
                    LinearGradient(
                        colors: music.isAvailable ? [ODINDesign.amber.opacity(0.92), .pink.opacity(0.58), .black] : [.white.opacity(0.12), .white.opacity(0.06), .black],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            if let artworkURL = music.artworkURL, let url = URL(string: artworkURL) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    default:
                        Image(systemName: "music.note")
                            .font(.system(size: 30, weight: .heavy))
                            .foregroundStyle(.black.opacity(0.68))
                    }
                }
            } else {
                Image(systemName: "music.note")
                    .font(.system(size: 30, weight: .heavy))
                    .foregroundStyle(.black.opacity(0.68))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }
}

struct CalendarMiniListView: View {
    let meetings: [MeetingItem]
    let ambientActive: Bool
    var onOpenCalendar: () -> Void

    var body: some View {
        Button(action: onOpenCalendar) {
            let now = Date()
            let selectedMeeting = primaryMeeting(at: now)

            VStack(alignment: .center, spacing: 5) {
                HStack(spacing: 7) {
                    CalendarGlyphPlate(ambientActive: ambientActive)

                    Text("CALENDAR")
                        .font(.system(size: 10.5, weight: .heavy))
                        .tracking(1.35)
                        .foregroundStyle(ODINDesign.primary)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9.5, weight: .heavy))
                        .foregroundStyle(ODINDesign.primary)
                }
                .frame(maxWidth: .infinity, alignment: .center)

                Text("TODAY")
                    .font(.system(size: 9.5, weight: .heavy))
                    .tracking(1.45)
                    .foregroundStyle(ODINDesign.primary)
                    .frame(maxWidth: .infinity, alignment: .center)

                if let selectedMeeting {
                    let status = calendarStatus(for: selectedMeeting, at: now)

                    Text(status.label)
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundStyle(ODINDesign.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .center)

                    CalendarEventRow(meeting: selectedMeeting, status: status, ambientActive: ambientActive)

                    ForEach(secondaryMeetings(excluding: selectedMeeting, at: now).prefix(1)) { meeting in
                        CalendarEventRow(meeting: meeting, status: calendarStatus(for: meeting, at: now), ambientActive: ambientActive, isSecondary: true)
                    }
                } else {
                    VStack(alignment: .center, spacing: 1) {
                        Text("Schedule clear")
                            .font(.system(size: 13.5, weight: .heavy))
                            .foregroundStyle(ODINDesign.primary)
                            .lineLimit(1)
                        Text("No remaining events today")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(ODINDesign.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func primaryMeeting(at now: Date) -> MeetingItem? {
        meetings
            .sorted { abs($0.startDate.timeIntervalSince(now)) < abs($1.startDate.timeIntervalSince(now)) }
            .first
    }

    private func secondaryMeetings(excluding primary: MeetingItem, at now: Date) -> [MeetingItem] {
        meetings
            .filter { $0.id != primary.id }
            .sorted { abs($0.startDate.timeIntervalSince(now)) < abs($1.startDate.timeIntervalSince(now)) }
    }

    private func calendarStatus(for meeting: MeetingItem, at now: Date) -> CalendarEventStatus {
        let delta = meeting.startDate.timeIntervalSince(now)
        if delta > 0 {
            let minutes = max(Int(delta / 60), 0)
            if minutes < 2 {
                return CalendarEventStatus(label: "Starting now", color: ODINDesign.amber, isPast: false)
            }
            if minutes < 60 {
                return CalendarEventStatus(label: "Starts in \(minutes)m", color: ODINDesign.amber, isPast: false)
            }

            let hours = minutes / 60
            let remainingMinutes = minutes % 60
            let label = remainingMinutes > 0 ? "Starts in \(hours)h \(remainingMinutes)m" : "Starts in \(hours)h"
            return CalendarEventStatus(label: label, color: ODINDesign.secondary, isPast: false)
        }

        let elapsedMinutes = Int(abs(delta) / 60)
        if elapsedMinutes < 60 {
            return CalendarEventStatus(label: "Started \(max(elapsedMinutes, 1))m ago", color: ODINDesign.secondary, isPast: false)
        }
        return CalendarEventStatus(label: "Earlier today", color: ODINDesign.tertiary, isPast: true)
    }
}

private struct CalendarEventStatus {
    let label: String
    let color: Color
    let isPast: Bool
}

private struct CalendarGlyphPlate: View {
    let ambientActive: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [ODINDesign.amber.opacity(ambientActive ? 0.32 : 0.10), .white.opacity(0.12), .black.opacity(0.20)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 24, height: 24)
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(.white.opacity(0.18), lineWidth: 1)
                }
                .shadow(color: ODINDesign.amber.opacity(ambientActive ? 0.28 : 0), radius: ambientActive ? 9 : 0)

            Image(systemName: "calendar")
                .font(.system(size: 12, weight: .black))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.white)
        }
    }
}

private struct CalendarEventRow: View {
    let meeting: MeetingItem
    let status: CalendarEventStatus
    let ambientActive: Bool
    var isSecondary = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(meeting.time)
                .font(.system(size: isSecondary ? 10.5 : 13, weight: .heavy))
                .foregroundStyle(ODINDesign.amber)
                .frame(width: 55, alignment: .trailing)

            VStack(alignment: .leading, spacing: 1) {
                Text(meeting.title)
                    .font(.system(size: isSecondary ? 10 : 11.5, weight: .bold))
                    .foregroundStyle(ODINDesign.primary)
                    .lineLimit(1)
                Text(meeting.timezone)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ODINDesign.primary)
                    .lineLimit(1)
            }
            .opacity(isSecondary ? 0.72 : 1)
        }
        .padding(.horizontal, isSecondary ? 7 : 8)
        .padding(.vertical, isSecondary ? 4 : 6)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            .white.opacity(isSecondary ? 0.045 : 0.070),
                            ODINDesign.amber.opacity(ambientActive ? (isSecondary ? 0.018 : 0.035) : 0.0),
                            .white.opacity(isSecondary ? 0.030 : 0.040)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(
                            LinearGradient(
                                colors: [.white.opacity(0.13), ODINDesign.amber.opacity(ambientActive ? 0.18 : 0.05), .white.opacity(0.03)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 1
                        )
                }
        )
        .overlay(alignment: .leading) {
            Capsule()
                .fill(status.isPast ? ODINDesign.tertiary.opacity(0.40) : ODINDesign.amber.opacity(ambientActive ? 0.88 : 0.58))
                .frame(width: 3, height: isSecondary ? 22 : 30)
                .shadow(color: ODINDesign.amber.opacity((ambientActive && !status.isPast) ? 0.45 : 0), radius: ambientActive ? 6 : 0)
                .offset(x: -1)
        }
        .shadow(color: ODINDesign.amber.opacity(ambientActive ? (isSecondary ? 0.03 : 0.09) : 0), radius: ambientActive ? (isSecondary ? 4 : 9) : 0, x: 0, y: 5)
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

struct PriorityMiniView: View {
    let summary: TaskSummary
    let items: [PriorityItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 8) {
                Circle().fill(ODINDesign.red).frame(width: 7, height: 7).shadow(color: ODINDesign.red, radius: 8)
                Text("PRIORITY OVERVIEW")
                    .font(.system(size: 10, weight: .heavy))
                    .tracking(1.4)
                    .foregroundStyle(ODINDesign.secondary)
            }

            Text("\(summary.urgent) urgent · \(summary.normal) normal")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(ODINDesign.primary)
                .lineLimit(1)

            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.prefix(2)) { item in
                    PriorityLine(color: item.level == "Overdue" ? ODINDesign.red : ODINDesign.amber, title: item.title, level: item.level)
                }
            }

            HStack(spacing: 8) {
                SourcePill(systemName: "checklist", count: summary.urgent + summary.normal, color: ODINDesign.amber)
                if summary.slack > 0 {
                    SourcePill(systemName: "bubble.left.and.bubble.right.fill", count: summary.slack, color: .purple)
                }
                if summary.gmail > 0 {
                    SourcePill(systemName: "envelope.fill", count: summary.gmail, color: .red)
                }
            }
        }
    }
}

private struct PriorityLine: View {
    let color: Color
    let title: String
    let level: String

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ODINDesign.secondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(level)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(ODINDesign.tertiary)
        }
    }
}

private struct SourcePill: View {
    let systemName: String
    let count: Int
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemName)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(color)
            Text("\(count)")
                .font(.system(size: 11, weight: .bold))
        }
        .foregroundStyle(ODINDesign.primary)
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(.white.opacity(0.07), in: Capsule())
    }
}

private struct QuickAppsPreviewView: View {
    @ObservedObject var model: NotchModel
    let ambientActive: Bool
    @State private var draggingQuickAppBundleIdentifier: String?

    var visibleApps: [QuickApp] {
        Array(model.quickApps.prefix(2))
    }

    private var visibleShortcuts: [FileShortcut] {
        [.screenshots, .documents, .downloads]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text("QUICK ACCESS")
                    .font(.system(size: 9, weight: .heavy))
                    .tracking(1.5)
                    .foregroundStyle(ODINDesign.primary)

                Spacer()

                Button(action: { model.chooseQuickAppFromPicker() }) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(ODINDesign.primary)
                        .frame(width: 24, height: 24)
                        .background(.white.opacity(0.10), in: Circle())
                }
                .buttonStyle(.plain)
                .help("Add app")
            }

            LazyVGrid(
                columns: [
                    GridItem(.fixed(62), spacing: 9),
                    GridItem(.fixed(62), spacing: 9),
                    GridItem(.fixed(62), spacing: 9)
                ],
                alignment: .leading,
                spacing: 9
            ) {
                PhonePreviewDropButton(model: model)

                ForEach(visibleApps) { app in
                    Button(action: { QuickAppService.open(bundleIdentifier: app.bundleIdentifier) }) {
                        QuickAppTile(
                            app: app,
                            ambientActive: ambientActive,
                            isDragging: draggingQuickAppBundleIdentifier == app.bundleIdentifier
                        )
                    }
                    .buttonStyle(.plain)
                    .onDrag {
                        draggingQuickAppBundleIdentifier = app.bundleIdentifier
                        return NSItemProvider(object: app.bundleIdentifier as NSString)
                    }
                    .onDrop(
                        of: [UTType.text.identifier, UTType.plainText.identifier],
                        delegate: QuickAppSwapDropDelegate(
                            target: app,
                            model: model,
                            draggingBundleIdentifier: $draggingQuickAppBundleIdentifier
                        )
                    )
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

                ForEach(visibleShortcuts) { shortcut in
                    Button(action: { FileShortcutService.open(shortcut) }) {
                        QuickShortcutTile(shortcut: shortcut, ambientActive: ambientActive)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct QuickAppSwapDropDelegate: DropDelegate {
    let target: QuickApp
    @ObservedObject var model: NotchModel
    @Binding var draggingBundleIdentifier: String?

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [UTType.text.identifier, UTType.plainText.identifier])
    }

    func dropEntered(info: DropInfo) {
        guard let draggingBundleIdentifier else { return }
        model.swapQuickApps(draggedBundleIdentifier: draggingBundleIdentifier, with: target)
    }

    func performDrop(info: DropInfo) -> Bool {
        if let draggingBundleIdentifier {
            model.swapQuickApps(draggedBundleIdentifier: draggingBundleIdentifier, with: target)
            self.draggingBundleIdentifier = nil
            return true
        }

        guard let provider = info.itemProviders(for: [UTType.text.identifier, UTType.plainText.identifier]).first else { return false }

        provider.loadObject(ofClass: NSString.self) { object, _ in
            guard let bundleIdentifier = object as? NSString else { return }
            Task { @MainActor in
                model.swapQuickApps(draggedBundleIdentifier: bundleIdentifier as String, with: target)
            }
        }

        draggingBundleIdentifier = nil
        return true
    }

    func dropExited(info: DropInfo) {}
}

private struct QuickAppTile: View {
    let app: QuickApp
    let ambientActive: Bool
    var isDragging = false
    @State private var isHovering = false

    var body: some View {
        let displayAccent = ambientActive ? accent : Color.white

        VStack(spacing: 5) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(.white.opacity(0.10))
                    .frame(width: 31, height: 31)
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .stroke(.white.opacity(0.16), lineWidth: 1)
                    }
                    .shadow(color: displayAccent.opacity(ambientActive ? (isHovering ? 0.40 : 0.22) : 0), radius: ambientActive ? (isHovering ? 10 : 6) : 0)

                AppIconImage(bundleIdentifier: app.bundleIdentifier)
                    .frame(width: 25, height: 25)
            }

            Text(app.name)
                .font(.system(size: 8.4, weight: .black))
                .foregroundStyle(ODINDesign.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
        .frame(width: 62, height: 62)
        .background(QuickAccessTilePlate(accent: displayAccent, isHovering: isHovering, ambientActive: ambientActive))
        .scaleEffect(isDragging ? 0.92 : (isHovering ? 1.045 : 1))
        .opacity(isDragging ? 0.70 : 1)
        .animation(.spring(response: 0.20, dampingFraction: 0.78), value: isHovering)
        .animation(.spring(response: 0.20, dampingFraction: 0.78), value: isDragging)
        .onHover { isHovering = $0 }
    }

    private var accent: Color {
        let scalars = app.name.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }
        let palette: [Color] = [.blue, .purple, .pink, ODINDesign.amber, .cyan, .green, .orange]
        return palette[abs(scalars) % palette.count]
    }
}

private struct QuickShortcutTile: View {
    let shortcut: FileShortcut
    let ambientActive: Bool
    @State private var isHovering = false

    var body: some View {
        let displayAccent = ambientActive ? accent : Color.white

        VStack(spacing: 5) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [displayAccent.opacity(ambientActive ? 0.28 : 0.08), .white.opacity(0.10), .black.opacity(0.18)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 31, height: 31)
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .stroke(.white.opacity(0.18), lineWidth: 1)
                    }
                    .shadow(color: displayAccent.opacity(ambientActive ? (isHovering ? 0.42 : 0.20) : 0), radius: ambientActive ? (isHovering ? 10 : 6) : 0)

                Image(systemName: shortcut.systemImage)
                    .font(.system(size: 15.5, weight: .black))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.white)
            }

            Text(shortcut.rawValue)
                .font(.system(size: 8.4, weight: .black))
                .foregroundStyle(ODINDesign.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
        .frame(width: 62, height: 62)
        .background(QuickAccessTilePlate(accent: displayAccent, isHovering: isHovering, ambientActive: ambientActive))
        .scaleEffect(isHovering ? 1.045 : 1)
        .animation(.spring(response: 0.20, dampingFraction: 0.78), value: isHovering)
        .onHover { isHovering = $0 }
    }

    private var accent: Color {
        switch shortcut {
        case .downloads:
            return .blue
        case .screenshots:
            return .purple
        case .documents:
            return ODINDesign.amber
        }
    }
}

private struct QuickAddAppTile: View {
    let ambientActive: Bool
    @State private var isHovering = false

    var body: some View {
        let accent = ODINDesign.amber

        VStack(spacing: 5) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(.white.opacity(isHovering ? 0.14 : 0.09))
                    .frame(width: 31, height: 31)
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .stroke(accent.opacity(isHovering ? 0.36 : 0.16), lineWidth: 1)
                    }

                Image(systemName: "plus")
                    .font(.system(size: 15.5, weight: .black))
                    .foregroundStyle(.white)
            }

            Text("Add App")
                .font(.system(size: 8.4, weight: .black))
                .foregroundStyle(ODINDesign.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
        .frame(width: 62, height: 62)
        .background(QuickAccessTilePlate(accent: accent, isHovering: isHovering, ambientActive: ambientActive))
        .scaleEffect(isHovering ? 1.045 : 1)
        .animation(.spring(response: 0.20, dampingFraction: 0.78), value: isHovering)
        .onHover { isHovering = $0 }
    }
}

private struct QuickAccessTilePlate: View {
    let accent: Color
    let isHovering: Bool
    let ambientActive: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 13, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        .white.opacity(isHovering ? 0.14 : 0.095),
                        accent.opacity(ambientActive ? (isHovering ? 0.065 : 0.035) : 0.0),
                        .white.opacity(isHovering ? 0.060 : 0.035)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [.white.opacity(0.20), accent.opacity(ambientActive ? (isHovering ? 0.34 : 0.16) : 0.055), .white.opacity(0.045)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            }
            .overlay(alignment: .topLeading) {
                Circle()
                    .fill(accent.opacity(ambientActive ? (isHovering ? 0.24 : 0.12) : 0.0))
                    .frame(width: 24, height: 24)
                    .blur(radius: 10)
                    .offset(x: -5, y: -6)
            }
            .shadow(color: accent.opacity(ambientActive ? (isHovering ? 0.18 : 0.08) : 0), radius: ambientActive ? (isHovering ? 11 : 7) : 0, x: 0, y: 5)
    }
}

private struct PhonePreviewDropButton: View {
    @ObservedObject var model: NotchModel
    @State private var isTargeted = false
    @State private var isHovering = false

    var body: some View {
        Button(action: {
            model.enterFileDropMode()
        }) {
            VStack(spacing: 6) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [ODINDesign.amber.opacity(0.28), .white.opacity(0.12), .black.opacity(0.18)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 31, height: 31)
                        .overlay {
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .stroke(.white.opacity(0.18), lineWidth: 1)
                        }
                    Image(systemName: isTargeted ? "arrow.down.doc.fill" : "tray.full.fill")
                        .font(.system(size: 15.5, weight: .black))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.white)
                }
                Text(isTargeted ? "Drop" : "Tray")
                    .font(.system(size: 8.4, weight: .black))
                    .lineLimit(1)
            }
            .foregroundStyle(isTargeted ? ODINDesign.amber : ODINDesign.primary)
            .frame(width: 62, height: 62)
            .background(QuickAccessTilePlate(accent: ODINDesign.amber, isHovering: isHovering || isTargeted, ambientActive: isTargeted))
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(isTargeted ? ODINDesign.amber.opacity(0.82) : .white.opacity(0.05), lineWidth: isTargeted ? 1.5 : 1)
            }
            .scaleEffect((isHovering || isTargeted) ? 1.045 : 1)
            .animation(.spring(response: 0.20, dampingFraction: 0.78), value: isTargeted)
            .animation(.spring(response: 0.20, dampingFraction: 0.78), value: isHovering)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .onDrop(of: [UTType.fileURL.identifier], isTargeted: $isTargeted) { providers in
            model.holdDroppedFiles(providers)
        }
        .help("Open Cork Board / ODIN Drop, or drop a file to hold it")
    }
}

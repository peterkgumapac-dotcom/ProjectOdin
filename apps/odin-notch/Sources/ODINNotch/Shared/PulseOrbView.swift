import SwiftUI

struct PulseOrbView: View {
    @State private var pulse = false
    @State private var isHovered = false

    var size: CGFloat = 28
    var music: MusicState?

    var body: some View {
        TimelineView(.animation) { timeline in
            let reactive = music.map { AudioReactiveEngine.state(for: $0, at: timeline.date) } ?? .idle
            let outerScale = reactive.isReactive
                ? 0.86 + (reactive.volume * 0.11) + (reactive.bassEnergy * 0.08)
                : (pulse ? 1.12 : 0.82)
            let coreScale = reactive.isReactive ? 1.0 + (reactive.beatPulse * 0.10) : 1.0
            let haloOpacity = reactive.isReactive
                ? 0.06 + (reactive.volume * 0.08) + (reactive.beatPulse * 0.05)
                : (pulse ? 0.22 : 0.08)
            let ringOpacity = reactive.isBeatLocked ? 0.12 + (reactive.beatPulse * 0.10) : 0.16
            let hoverLift: CGFloat = isHovered ? 1 : 0
            let breath = pulse ? 1.0 : 0.0

            ZStack {
                Circle()
                    .fill(.white.opacity((0.020 + (0.040 * breath)) + (0.075 * hoverLift)))
                    .frame(width: size * (isHovered ? 5.2 : 3.9), height: size * (isHovered ? 5.2 : 3.9))
                    .blur(radius: size * (isHovered ? 1.08 : 0.72))
                    .scaleEffect(0.94 + (0.10 * outerScale))

                Circle()
                    .fill(ODINDesign.amber.opacity(haloOpacity + (0.05 * hoverLift)))
                    .frame(width: size * (isHovered ? 2.35 : 1.85), height: size * (isHovered ? 2.35 : 1.85))
                    .blur(radius: size * (isHovered ? 0.22 : 0.05))
                    .scaleEffect(outerScale)

                Circle()
                    .stroke(.white.opacity(isHovered ? 0.18 : 0.055), lineWidth: 1)
                    .frame(width: size * 2.05, height: size * 2.05)
                    .scaleEffect(outerScale)
                    .blur(radius: 0.6)

                Circle()
                    .stroke(ODINDesign.amber.opacity((reactive.isReactive ? 0.14 : 0.16) + (0.08 * hoverLift)), lineWidth: 1.1)
                    .frame(width: size * 1.55, height: size * 1.55)
                    .scaleEffect(outerScale)

                Circle()
                    .fill(
                        RadialGradient(
                            gradient: Gradient(stops: [
                                .init(color: .white.opacity(isHovered ? 1.0 : 0.94), location: 0.0),
                                .init(color: ODINDesign.amber.opacity(isHovered ? 1.0 : 0.94), location: 0.28),
                                .init(color: Color(red: 0.42, green: 0.19, blue: 0.04), location: 0.62),
                                .init(color: .black.opacity(0.92), location: 1.0)
                            ]),
                            center: UnitPoint(x: 0.35, y: 0.35),
                            startRadius: 1,
                            endRadius: size
                        )
                    )
                    .frame(width: size, height: size)
                    .scaleEffect(coreScale * (isHovered ? 1.06 : 1.0))
                    .shadow(color: .black.opacity(isHovered ? 0.60 : 0.38), radius: isHovered ? size * 0.45 : size * 0.28, x: 0, y: isHovered ? size * 0.18 : size * 0.10)
                    .shadow(color: .white.opacity(isHovered ? 0.09 : 0.02), radius: isHovered ? size * 0.35 : size * 0.14)
                    .overlay {
                        Circle()
                            .stroke(
                                LinearGradient(
                                    colors: [
                                        .white.opacity(isHovered ? 0.56 : 0.26),
                                        ODINDesign.amber.opacity(ringOpacity),
                                        .black.opacity(0.28)
                                    ],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ),
                                lineWidth: reactive.isBeatLocked ? 1.4 : 1
                            )
                            .scaleEffect(1.0 + (reactive.beatPulse * 0.08))
                    }
            }
            .frame(width: size * 5.4, height: size * 5.4)
        }
        .animation(.easeInOut(duration: 1.7).repeatForever(autoreverses: true), value: pulse)
        .animation(.easeInOut(duration: 0.4), value: isHovered)
        .onAppear { pulse = true }
        .onHover { hovering in
            isHovered = hovering
        }
        .accessibilityLabel("ODIN pulse")
    }
}

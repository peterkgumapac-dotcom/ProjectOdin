import Foundation
import SwiftUI

struct AudioReactiveState: Equatable {
    var volume: CGFloat
    var bassEnergy: CGFloat
    var amplitude: CGFloat
    var beatPulse: CGFloat
    var glow: CGFloat
    var tempo: Double
    var isReactive: Bool
    var isBeatLocked: Bool

    static let idle = AudioReactiveState(
        volume: 0,
        bassEnergy: 0,
        amplitude: 0,
        beatPulse: 0,
        glow: 0.45,
        tempo: 72,
        isReactive: false,
        isBeatLocked: false
    )
}

enum AudioReactiveEngine {
    static func state(for music: MusicState, at date: Date) -> AudioReactiveState {
        guard music.isPlaying else { return .idle }

        let tempo = estimatedTempo(for: music)
        let secondsPerBeat = 60 / tempo
        let elapsed = date.timeIntervalSinceReferenceDate
        let phase = (elapsed.truncatingRemainder(dividingBy: secondsPerBeat)) / secondsPerBeat

        let kick = pow(max(0, cos(phase * .pi * 2)), 10)
        let offBeat = pow(max(0, cos((phase - 0.5) * .pi * 2)), 14) * 0.34
        let bass = pow(max(0, sin((phase * .pi * 2) + .pi / 8)), 2.4)
        let shimmer = (sin(elapsed * 7.3) + 1) * 0.06
        let progressLift = music.progress > 0 ? min(max(music.progress, 0), 1) * 0.08 : 0
        let volume = min(max(0.22 + (kick * 0.42) + (bass * 0.26) + offBeat + shimmer + progressLift, 0), 1)
        let amplitude = min(max((volume * 0.58) + (kick * 0.24) + (bass * 0.18), 0), 1)

        return AudioReactiveState(
            volume: CGFloat(volume),
            bassEnergy: CGFloat(bass),
            amplitude: CGFloat(amplitude),
            beatPulse: CGFloat(kick),
            glow: CGFloat(0.55 + (amplitude * 0.45)),
            tempo: tempo,
            isReactive: true,
            isBeatLocked: true
        )
    }

    private static func estimatedTempo(for music: MusicState) -> Double {
        let text = "\(music.title) \(music.artist)".lowercased()

        if text.contains("edm") || text.contains("dance") || text.contains("remix") || text.contains("punk") {
            return 128
        }
        if text.contains("rock") || text.contains("metal") || text.contains("trap") || text.contains("queen") {
            return 116
        }
        if text.contains("acoustic") || text.contains("lofi") || text.contains("ambient") || text.contains("piano") || text.contains("sleep") {
            return 76
        }

        let seed = abs(text.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) })
        return Double(86 + (seed % 38))
    }
}

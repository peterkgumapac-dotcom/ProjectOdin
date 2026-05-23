import Foundation

enum SpotifyLocalService {
    static func currentTrack() async -> MusicState? {
        await runTrackScript()
    }

    static func playPause() async {
        await runCommandScript("playpause")
    }

    static func nextTrack() async {
        await runCommandScript("next track")
    }

    static func previousTrack() async {
        await runCommandScript("previous track")
    }

    static func seek(to progress: Double, durationSeconds: Double) async {
        guard durationSeconds > 0 else { return }
        let clampedProgress = min(max(progress, 0), 1)
        let positionSeconds = durationSeconds * clampedProgress
        await runCommandScript("set player position to \(String(format: "%.2f", positionSeconds))")
    }

    private static func runTrackScript() async -> MusicState? {
        await Task.detached {
            let script = """
            if application "Spotify" is running then
                tell application "Spotify"
                    if player state is stopped then return ""
                    set currentName to name of current track
                    set currentArtist to artist of current track
                    set currentDuration to duration of current track
                    set currentPosition to player position
                    set currentState to player state as string
                    set currentArtwork to ""
                    try
                        set currentArtwork to artwork url of current track
                    end try
                    return currentName & "|||ODIN|||" & currentArtist & "|||ODIN|||" & (currentDuration as string) & "|||ODIN|||" & (currentPosition as string) & "|||ODIN|||" & currentState & "|||ODIN|||" & currentArtwork
                end tell
            end if
            return ""
            """

            guard let result = execute(script), !result.isEmpty else { return nil }
            let parts = result.components(separatedBy: "|||ODIN|||")
            guard parts.count >= 5 else { return nil }

            let durationMs = Double(parts[2]) ?? 0
            let positionSeconds = Double(parts[3]) ?? 0
            let progress = durationMs > 0 ? min(max((positionSeconds * 1000) / durationMs, 0), 1) : 0

            return MusicState(
                title: parts[0],
                artist: parts[1],
                isPlaying: parts[4].localizedCaseInsensitiveContains("playing"),
                progress: progress,
                durationSeconds: durationMs / 1000,
                positionSeconds: positionSeconds,
                sourceName: "Spotify",
                artworkURL: parts.count >= 6 && !parts[5].isEmpty ? parts[5] : nil,
                isAvailable: true
            )
        }.value
    }

    private static func runCommandScript(_ command: String) async {
        let script = """
        if application "Spotify" is running then
            tell application "Spotify"
                \(command)
            end tell
        end if
        """

        await Task.detached(priority: .userInitiated) {
            runProcessCommand(script)
        }.value
    }

    private static func runProcessCommand(_ script: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        process.standardOutput = Pipe()
        process.standardError = Pipe()

        do {
            try process.run()
        } catch {
            NSLog("ODINNotch Spotify command failed: \(error.localizedDescription)")
            return
        }

        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            process.waitUntilExit()
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 1.0) == .timedOut {
            if process.isRunning {
                process.terminate()
            }
            NSLog("ODINNotch Spotify command timed out")
        }
    }

    private static func execute(_ source: String) -> String? {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: source) else { return nil }
        let descriptor = script.executeAndReturnError(&error)

        if let error {
            NSLog("ODINNotch Spotify AppleScript failed: \(error)")
            return nil
        }

        return descriptor.stringValue
    }
}

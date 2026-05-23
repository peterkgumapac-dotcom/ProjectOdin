import Foundation

enum AppleMusicLocalService {
    static func currentTrack() async -> MusicState? {
        let script = """
        tell application "Music"
            if it is not running then return ""
            if player state is stopped then return ""
            set trackName to name of current track
            set artistName to artist of current track
            set durationSeconds to duration of current track
            set positionSeconds to player position
            set playingFlag to "false"
            if player state is playing then set playingFlag to "true"
            return trackName & "||" & artistName & "||" & playingFlag & "||" & durationSeconds & "||" & positionSeconds
        end tell
        """

        guard let raw = await runScript(script), !raw.isEmpty else { return nil }

        let parts = raw.components(separatedBy: "||")
        guard parts.count >= 5 else { return nil }

        let durationSeconds = Double(parts[3]) ?? 0
        let positionSeconds = Double(parts[4]) ?? 0
        let progress = durationSeconds > 0 ? min(max(positionSeconds / durationSeconds, 0), 1) : 0

        return MusicState(
            title: parts[0],
            artist: parts[1],
            isPlaying: parts[2] == "true",
            progress: progress,
            durationSeconds: durationSeconds,
            positionSeconds: positionSeconds,
            sourceName: "Apple Music",
            artworkURL: nil
        )
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

    private static func runCommandScript(_ command: String) async {
        let script = """
        tell application "Music"
            if it is running then \(command)
        end tell
        """

        _ = await runScript(script)
    }

    private static func runScript(_ script: String, timeout: TimeInterval = 1.2) async -> String? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
                process.arguments = ["-e", script]

                let output = Pipe()
                process.standardOutput = output
                process.standardError = Pipe()

                do {
                    try process.run()
                } catch {
                    continuation.resume(returning: nil)
                    return
                }

                let waitGroup = DispatchGroup()
                waitGroup.enter()
                DispatchQueue.global(qos: .utility).async {
                    process.waitUntilExit()
                    waitGroup.leave()
                }

                guard waitGroup.wait(timeout: .now() + timeout) == .success else {
                    if process.isRunning {
                        process.terminate()
                    }
                    NSLog("ODINNotch Apple Music AppleScript timed out")
                    continuation.resume(returning: nil)
                    return
                }

                let data = output.fileHandleForReading.readDataToEndOfFile()
                let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                continuation.resume(returning: raw)
            }
        }
    }
}

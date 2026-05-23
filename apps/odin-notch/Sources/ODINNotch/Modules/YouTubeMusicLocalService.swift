import Foundation

enum YouTubeMusicLocalService {
    static func currentTrack() async -> MusicState? {
        guard let raw = await runBrowserScript(commandJavaScript: nil), !raw.isEmpty else {
            return await currentTrackFromTabTitle()
        }
        let parts = raw.components(separatedBy: "|||ODIN|||")
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
            sourceName: "YouTube Music",
            artworkURL: parts.count >= 6 && !parts[5].isEmpty ? parts[5] : nil,
            isAvailable: true
        )
    }

    static func playPause() async {
        _ = await runBrowserScript(commandJavaScript: "document.querySelector('.play-pause-button')?.click();")
    }

    static func nextTrack() async {
        _ = await runBrowserScript(commandJavaScript: "document.querySelector('.next-button')?.click();")
    }

    static func previousTrack() async {
        _ = await runBrowserScript(commandJavaScript: "document.querySelector('.previous-button')?.click();")
    }

    static func seek(to progress: Double, durationSeconds: Double) async {
        let clampedProgress = min(max(progress, 0), 1)
        let positionSeconds = durationSeconds * clampedProgress
        _ = await runBrowserScript(commandJavaScript: "const video = document.querySelector('video'); if (video) { video.currentTime = \(String(format: "%.2f", positionSeconds)); }")
    }

    private static func runBrowserScript(commandJavaScript: String?) async -> String? {
        await Task.detached {
            let readJavaScript = """
            (() => {
                const clean = (value) => String(value || '').replaceAll('|', ' ').trim();
                const video = document.querySelector('video');
                const title =
                    document.querySelector('ytmusic-player-bar .title')?.textContent ||
                    document.querySelector('.title.ytmusic-player-bar')?.textContent ||
                    document.title.replace(' - YouTube Music', '');
                const artist =
                    document.querySelector('ytmusic-player-bar .subtitle')?.textContent ||
                    document.querySelector('.subtitle.ytmusic-player-bar')?.textContent ||
                    'YouTube Music';
                const image =
                    document.querySelector('ytmusic-player-bar img.image')?.src ||
                    document.querySelector('ytmusic-player-bar img')?.src ||
                    '';
                if (!video || !clean(title) || clean(title) === 'YouTube Music') { return ''; }
                return [clean(title), clean(artist), String(!video.paused), String(video.duration || 0), String(video.currentTime || 0), clean(image)].join('|||ODIN|||');
            })();
            """

            let commandLine = commandJavaScript.map { "set commandResult to execute targetTab javascript \"\($0.escapedForAppleScript)\"" } ?? ""
            let script = """
            if application "Google Chrome" is running then
                tell application "Google Chrome"
                    repeat with browserWindow in windows
                        repeat with targetTab in tabs of browserWindow
                            set targetURL to URL of targetTab
                            if targetURL contains "music.youtube.com" then
                                \(commandLine)
                                set trackResult to execute targetTab javascript "\(readJavaScript.escapedForAppleScript)"
                                return trackResult
                            end if
                        end repeat
                    end repeat
                end tell
            end if
            return ""
            """

            return execute(script)
        }.value
    }

    private static func currentTrackFromTabTitle() async -> MusicState? {
        await Task.detached {
            let script = """
            if application "Google Chrome" is running then
                tell application "Google Chrome"
                    repeat with browserWindow in windows
                        repeat with targetTab in tabs of browserWindow
                            set targetURL to URL of targetTab
                            if targetURL contains "music.youtube.com" then
                                set rawTitle to title of targetTab as string
                                if rawTitle contains " | YouTube Music" then
                                    set AppleScript's text item delimiters to " | YouTube Music"
                                    set trackTitle to text item 1 of rawTitle
                                    set AppleScript's text item delimiters to ""
                                    return trackTitle
                                end if
                            end if
                        end repeat
                    end repeat
                end tell
            end if
            return ""
            """

            guard let title = execute(script), !title.isEmpty, title != "YouTube Music" else { return nil }

            return MusicState(
                title: title,
                artist: "YouTube Music",
                isPlaying: true,
                progress: 0,
                durationSeconds: 0,
                positionSeconds: 0,
                sourceName: "YouTube Music",
                artworkURL: nil,
                isAvailable: true
            )
        }.value
    }

    private static func execute(_ source: String) -> String? {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: source) else { return nil }
        let descriptor = script.executeAndReturnError(&error)

        if let error {
            NSLog("ODINNotch YouTube Music AppleScript failed: \(error)")
            return nil
        }

        return descriptor.stringValue
    }
}

private extension String {
    var escapedForAppleScript: String {
        replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
    }
}

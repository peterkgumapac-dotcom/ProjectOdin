import Foundation

enum MediaProviderService {
    static func currentTrack() async -> MusicState? {
        async let spotifyTrack = SpotifyLocalService.currentTrack()
        async let youtubeMusicTrack = YouTubeMusicLocalService.currentTrack()

        // Keep continuous polling to the providers that are responsive enough for the notch.
        // Music.app AppleScript can hang behind macOS automation/keychain prompts and freeze
        // the whole media card, so Apple Music is only safe to revisit with a non-blocking
        // provider later.
        let tracks = await [youtubeMusicTrack, spotifyTrack].compactMap { $0 }.filter(\.isAvailable)

        return tracks.first(where: \.isPlaying) ?? tracks.first
    }

    static func playPause(sourceName: String) async {
        if isYouTubeMusic(sourceName) {
            await YouTubeMusicLocalService.playPause()
        } else if isAppleMusic(sourceName) {
            await AppleMusicLocalService.playPause()
        } else {
            await SpotifyLocalService.playPause()
        }
    }

    static func nextTrack(sourceName: String) async {
        if isYouTubeMusic(sourceName) {
            await YouTubeMusicLocalService.nextTrack()
        } else if isAppleMusic(sourceName) {
            await AppleMusicLocalService.nextTrack()
        } else {
            await SpotifyLocalService.nextTrack()
        }
    }

    static func previousTrack(sourceName: String) async {
        if isYouTubeMusic(sourceName) {
            await YouTubeMusicLocalService.previousTrack()
        } else if isAppleMusic(sourceName) {
            await AppleMusicLocalService.previousTrack()
        } else {
            await SpotifyLocalService.previousTrack()
        }
    }

    static func seek(to progress: Double, durationSeconds: Double, sourceName: String) async {
        if isYouTubeMusic(sourceName) {
            await YouTubeMusicLocalService.seek(to: progress, durationSeconds: durationSeconds)
        } else if isAppleMusic(sourceName) {
            await AppleMusicLocalService.seek(to: progress, durationSeconds: durationSeconds)
        } else {
            await SpotifyLocalService.seek(to: progress, durationSeconds: durationSeconds)
        }
    }

    private static func isAppleMusic(_ sourceName: String) -> Bool {
        sourceName.localizedCaseInsensitiveContains("apple")
    }

    private static func isYouTubeMusic(_ sourceName: String) -> Bool {
        sourceName.localizedCaseInsensitiveContains("youtube")
    }
}

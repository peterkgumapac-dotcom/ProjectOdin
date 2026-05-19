import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react"
import {
  AlertCircle,
  Check,
  Disc3,
  ExternalLink,
  ListMusic,
  ListPlus,
  Loader2,
  Music2,
  PanelTopOpen,
  Pause,
  Play,
  Radio,
  Plus,
  Search,
  SkipBack,
  SkipForward,
} from "lucide-react"
import { Link } from "react-router-dom"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import {
  connectSpotify,
  queueSpotifyTrack,
  getSpotifyDiagnostics,
  nextSpotify,
  currentPlayback,
  listSpotifyDevices,
  listSpotifyPlaylistTracks,
  listSpotifyPlaylists,
  listSpotifyRecentTracks,
  listSpotifyTopTracks,
  pauseSpotify,
  playSpotify,
  previousSpotify,
  saveTrackToPlaylist,
  searchSpotify,
  type SpotifyBrowsePlaylist,
  type SpotifyBrowseTrack,
  type SpotifyDiagnosticsResponse,
} from "@/lib/connectors/spotify"
import { odinRouteUrl, odinWindowUrl } from "@/lib/desktopRoute"
import {
  type MusicState,
  type MusicTrack,
  useOdinMusicController,
} from "@/lib/musicState"
import {
  LightPageHeader,
  LightPageShell,
} from "@/components/dashboard/LightPageChrome"
import { ConnectionStatusChip } from "@/components/shared/ConnectionStatusChip"

type PlaybackAction = "play" | "pause" | "next" | "previous" | "track"
type TrackFeedKey =
  | "auto"
  | "search"
  | "recent"
  | "top"
  | "explore"
  | "artists"
  | "albums"
  | "suggested"
  | "queue"
  | "history"

interface PlaybackDeviceTarget {
  id: string | null
  label: string
}

function toMusicTrack(track: SpotifyBrowseTrack | MusicTrack): MusicTrack {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    url: track.url,
    uri: track.uri,
    imageUrl: "imageUrl" in track ? track.imageUrl : null,
    durationMs: track.durationMs,
  }
}

function trackKey(
  track: Pick<MusicTrack, "uri" | "url" | "title" | "artist">
): string {
  return track.uri || track.url || `${track.title}:${track.artist}`
}

function rememberRecentTrack(
  history: MusicTrack[],
  track: MusicTrack,
  limit = 32
): MusicTrack[] {
  const key = trackKey(track)
  if (!key || (!track.uri && !track.url)) return history
  const next = [track, ...history.filter((item) => trackKey(item) !== key)]
  return next.slice(0, limit)
}

function browseTrackKey(
  track: Pick<SpotifyBrowseTrack, "id" | "uri" | "url" | "title" | "artist">
): string {
  return track.uri || track.url || track.id || `${track.title}:${track.artist}`
}

function dedupeBrowseTracks(tracks: SpotifyBrowseTrack[]): SpotifyBrowseTrack[] {
  const seen = new Set<string>()
  const unique: SpotifyBrowseTrack[] = []
  tracks.forEach((track) => {
    const key = browseTrackKey(track)
    if (!key || seen.has(key)) return
    seen.add(key)
    unique.push(track)
  })
  return unique
}

function toBrowseTrack(track: MusicTrack, index: number): SpotifyBrowseTrack {
  return {
    id: track.uri || track.url || `${track.title}-${index}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    url: track.url,
    uri: track.uri ?? "",
    imageUrl: track.imageUrl ?? null,
    durationMs: track.durationMs ?? null,
  }
}

function artistSeedTracks(tracks: SpotifyBrowseTrack[]): SpotifyBrowseTrack[] {
  const seen = new Set<string>()
  const rows: SpotifyBrowseTrack[] = []
  for (const track of tracks) {
    const artist = (track.artist || "").split(",")[0]?.trim()
    if (!artist) continue
    const key = artist.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(track)
    if (rows.length >= 24) break
  }
  return rows
}

function albumSeedTracks(tracks: SpotifyBrowseTrack[]): SpotifyBrowseTrack[] {
  const seen = new Set<string>()
  const rows: SpotifyBrowseTrack[] = []
  for (const track of tracks) {
    const album = (track.album || "").trim()
    if (!album) continue
    const key = album.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(track)
    if (rows.length >= 24) break
  }
  return rows
}

function sanitizeSuggestionTerm(term: string): string {
  const normalized = term.trim().replace(/\s+/g, " ")
  return normalized.length ? normalized : ""
}

function buildSuggestionTerms(state: MusicState): string[] {
  const terms = new Set<string>()
  const safeTitle = sanitizeSuggestionTerm(state.current.title || "")
  const safeArtist = sanitizeSuggestionTerm(state.current.artist || "")
  const safeAlbum = sanitizeSuggestionTerm(state.current.album || "")

  if (safeArtist) {
    terms.add(safeArtist)
  }
  if (safeAlbum && safeArtist) {
    terms.add(`${safeArtist} ${safeAlbum}`)
  }
  if (safeTitle &&
    !/no track selected|connect spotify/i.test(safeTitle) &&
    !safeTitle.toLowerCase().includes("ready for integration")
  ) {
    terms.add(safeTitle)
  }

  terms.add("top hits")
  terms.add("new music")
  return Array.from(terms).slice(0, 4)
}

const EXPLORE_TERMS = [
  "new releases",
  "viral hits",
  "chill mix",
  "workout mix",
  "indie pop",
]

function appendUnique(base: MusicTrack[], incoming: MusicTrack[]): MusicTrack[] {
  const seen = new Set(base.map(trackKey))
  const next = [...base]
  incoming.forEach((track) => {
    const key = trackKey(track)
    if (!key || seen.has(key)) return
    seen.add(key)
    next.push(track)
  })
  return next
}

function trackListWithPrimary(
  primary: MusicTrack,
  sourceTracks: Array<SpotifyBrowseTrack | MusicTrack>,
  currentQueue: MusicTrack[]
): MusicTrack[] {
  const normalizedSource = sourceTracks.map((track) => toMusicTrack(track))
  const queue = appendUnique([primary], normalizedSource)
  return appendUnique(queue, currentQueue.filter((track) => track.uri || track.url))
}

function playableQueueTracks(state: MusicState): MusicTrack[] {
  const seen = new Set<string>()
  return [state.current, ...state.queue].filter((track) => {
    const key = trackKey(track)
    if (!track.uri || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function queueNeighborTrack(
  queue: MusicTrack[],
  current: MusicTrack,
  direction: "next" | "previous"
): MusicTrack | null {
  if (queue.length < 2) return null
  const currentIndex = queue.findIndex(
    (track) => track.uri && track.uri === current.uri
  )
  const safeIndex = currentIndex >= 0 ? currentIndex : 0
  const nextIndex =
    direction === "next"
      ? (safeIndex + 1) % queue.length
      : (safeIndex - 1 + queue.length) % queue.length
  return queue[nextIndex] ?? null
}

function currentPositionMs(state: MusicState, now = Date.now()): number {
  const duration = state.current.durationMs ?? 0
  const base = Math.max(0, state.playback.positionMs ?? 0)
  if (!state.playback.isPlaying || !state.playback.startedAt) return base
  const elapsed = Math.max(0, now - state.playback.startedAt)
  const position = base + elapsed
  return duration > 0 ? Math.min(position, duration) : position
}

function formatTime(ms?: number | null, fallback = "--:--"): string {
  if (ms === null || typeof ms === "undefined" || ms < 0) return fallback
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function openMusicPopout() {
  const width = 430
  const height = 680
  const left = Math.max(0, window.screenX + window.outerWidth - width - 28)
  const top = Math.max(0, window.screenY + 72)
  window.open(
    odinWindowUrl("/music?floating=1"),
    "odin-music-box",
    `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  )
}

function spotifyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/No active Spotify device|NO_ACTIVE_DEVICE|active device|404/i.test(message)) {
    return "No active Spotify device found. Open Spotify on this Mac or phone, start any track once, then try ODIN again."
  }
  if (/403|allowlist|premium|Forbidden/i.test(message)) {
    return "Spotify blocked this request. Add this Spotify account to the ODIN app Users Management allowlist and make sure the app owner has Spotify Premium, then reconnect."
  }
  if (/not connected|Unauthorized|401/i.test(message)) {
    return "Spotify needs to be reconnected before ODIN can browse."
  }
  if (/Invalid limit/i.test(message)) {
    return "Spotify rejected the search size. Refresh ODIN and search again."
  }
  if (/Spotify API 400/i.test(message)) {
    return "Spotify rejected that browse request. Refresh ODIN, then try a simpler search term."
  }
  return message
}

async function resolvePlaybackDeviceTarget(
  accountId: string
): Promise<PlaybackDeviceTarget> {
  const deviceResult = await listSpotifyDevices(accountId)
  const active =
    deviceResult.devices.find((device) => device.isActive) ??
    deviceResult.devices.find((device) => device.id && !device.isRestricted)
  if (!active?.id) {
    throw new Error(
      "No active Spotify device found. Open Spotify on this Mac or phone, start any track once, then try ODIN again."
    )
  }
  return {
    id: active.id,
    label: active.name || "Spotify device",
  }
}

export function MusicPage() {
  const { spotify } = useConnectedAccounts()
  const [state, setState] = useOdinMusicController()
  const [connectLabel, setConnectLabel] = useState("Music")
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [searchAttempted, setSearchAttempted] = useState(false)
  const [lastSearchTerm, setLastSearchTerm] = useState("")
  const [searchBusy, setSearchBusy] = useState(false)
  const [browseBusy, setBrowseBusy] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [transportError, setTransportError] = useState<string | null>(null)
  const [transportBusy, setTransportBusy] = useState<PlaybackAction | null>(null)
  const [trackActionBusy, setTrackActionBusy] = useState<{
    type: "queue" | "save"
    key: string
  } | null>(null)
  const [activeDeviceLabel, setActiveDeviceLabel] = useState<string | null>(null)
  const [tracks, setTracks] = useState<SpotifyBrowseTrack[]>([])
  const [playlists, setPlaylists] = useState<SpotifyBrowsePlaylist[]>([])
  const [spotifyPlaylistTracks, setSpotifyPlaylistTracks] = useState<
    SpotifyBrowseTrack[]
  >([])
  const [suggestedTracks, setSuggestedTracks] = useState<
    SpotifyBrowseTrack[]
  >([])
  const [recentSpotifyTracks, setRecentSpotifyTracks] = useState<
    SpotifyBrowseTrack[]
  >([])
  const [topSpotifyTracks, setTopSpotifyTracks] = useState<
    SpotifyBrowseTrack[]
  >([])
  const [exploreTracks, setExploreTracks] = useState<SpotifyBrowseTrack[]>([])
  const [suggestedSourceLabel, setSuggestedSourceLabel] = useState("Popular picks")
  const [suggestionBusy, setSuggestionBusy] = useState(false)
  const [selectedPlaylist, setSelectedPlaylist] =
    useState<SpotifyBrowsePlaylist | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState("")
  const [diagnostics, setDiagnostics] = useState<SpotifyDiagnosticsResponse | null>(
    null
  )
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)
  const [activeFeed, setActiveFeed] = useState<TrackFeedKey>("auto")
  const [now, setNow] = useState(() => Date.now())
  const autoAdvanceRef = useRef("")

  const isFloating =
    new URLSearchParams(window.location.search).get("floating") === "1"
  const spotifyConnected = spotify.length > 0
  const activeAccount =
    spotify.find((account) => account.id === selectedAccountId) ?? spotify[0]
  const spotifySearchUrl = query.trim()
    ? `https://open.spotify.com/search/${encodeURIComponent(query.trim())}`
    : "https://open.spotify.com/search"
  const lastSearchUrl = lastSearchTerm.trim()
    ? `https://open.spotify.com/search/${encodeURIComponent(lastSearchTerm.trim())}`
    : "https://open.spotify.com/search"
  const suggestionTerms = useMemo(
    () => buildSuggestionTerms(state),
    [state.current.artist, state.current.album, state.current.title]
  )
  const suggestionContext = suggestionTerms.join("|")
  const suggestionContextRef = useRef("")
  const localRecentTracks = useMemo(
    () =>
      (state.recentTracks ?? [])
        .filter((track) => Boolean(track.uri || track.url))
        .map((track, index) => toBrowseTrack(track, index)),
    [state.recentTracks]
  )
  const queueTracks = useMemo(
    () =>
      (state.queue ?? [])
        .filter((track) => Boolean(track.uri || track.url))
        .map((track, index) => toBrowseTrack(track, 1000 + index)),
    [state.queue]
  )
  const modularSeedTracks = useMemo(
    () =>
      dedupeBrowseTracks([
        ...recentSpotifyTracks,
        ...topSpotifyTracks,
        ...exploreTracks,
        ...suggestedTracks,
        ...queueTracks,
        ...localRecentTracks,
      ]),
    [
      recentSpotifyTracks,
      topSpotifyTracks,
      exploreTracks,
      suggestedTracks,
      queueTracks,
      localRecentTracks,
    ]
  )
  const artistTracks = useMemo(
    () => artistSeedTracks(modularSeedTracks),
    [modularSeedTracks]
  )
  const albumTracks = useMemo(
    () => albumSeedTracks(modularSeedTracks),
    [modularSeedTracks]
  )
  const feedTracks = useMemo(
    () => ({
      recent: recentSpotifyTracks,
      top: topSpotifyTracks,
      explore: exploreTracks,
      artists: artistTracks,
      albums: albumTracks,
      suggested: suggestedTracks,
      queue: queueTracks,
      history: localRecentTracks,
    }),
    [
      recentSpotifyTracks,
      topSpotifyTracks,
      exploreTracks,
      artistTracks,
      albumTracks,
      suggestedTracks,
      queueTracks,
      localRecentTracks,
    ]
  )
  const fallbackFeed: Exclude<TrackFeedKey, "auto" | "search"> =
    recentSpotifyTracks.length > 0
      ? "recent"
      : topSpotifyTracks.length > 0
      ? "top"
      : exploreTracks.length > 0
      ? "explore"
      : artistTracks.length > 0
      ? "artists"
      : albumTracks.length > 0
      ? "albums"
      : suggestedTracks.length > 0
      ? "suggested"
      : queueTracks.length > 0
      ? "queue"
      : "history"
  const resolvedFeed: Exclude<TrackFeedKey, "auto" | "search"> =
    activeFeed !== "auto" &&
    activeFeed !== "search" &&
    feedTracks[activeFeed].length > 0
      ? activeFeed
      : fallbackFeed

  const visibleTracks = useMemo(
    () => {
      if (spotifyPlaylistTracks.length) return spotifyPlaylistTracks
      if (tracks.length && (activeFeed === "auto" || activeFeed === "search")) {
        return tracks
      }
      return feedTracks[resolvedFeed]
    },
    [
      spotifyPlaylistTracks,
      tracks,
      activeFeed,
      feedTracks,
      resolvedFeed,
    ]
  )
  const positionMs = currentPositionMs(state, now)
  const durationMs = state.current.durationMs ?? null
  const showPlaylistPanel =
    browseBusy || playlists.length > 0 || Boolean(selectedPlaylist) || searchBusy
  const feedButtons = [
    { key: "recent", label: "Recently played", count: recentSpotifyTracks.length },
    { key: "top", label: "Top tracks", count: topSpotifyTracks.length },
    { key: "explore", label: "Explore", count: exploreTracks.length },
    { key: "artists", label: "Artists", count: artistTracks.length },
    { key: "albums", label: "Albums", count: albumTracks.length },
    { key: "queue", label: "Up next", count: queueTracks.length },
    { key: "history", label: "ODIN history", count: localRecentTracks.length },
  ] as const
  const progressPct =
    durationMs && durationMs > 0
      ? Math.max(0, Math.min(100, (positionMs / durationMs) * 100))
      : 0

  const syncFromSpotifyPlayback = useCallback(async () => {
    if (!activeAccount?.id) return
    try {
      const playback = await currentPlayback(activeAccount.id)
      setState((current) => {
        const track = playback.track ? toMusicTrack(playback.track) : current.current
        const positionMs = Number.isFinite(playback.positionMs)
          ? Math.max(0, playback.positionMs)
          : current.playback.positionMs
        const recentTracks = playback.track
          ? rememberRecentTrack(current.recentTracks ?? [], track)
          : current.recentTracks ?? []
        return {
          ...current,
          activeAccountId: activeAccount.id,
          current: track,
          recentTracks,
          playback: {
            ...current.playback,
            isPlaying: Boolean(playback.isPlaying),
            startedAt: playback.isPlaying ? Date.now() - positionMs : null,
            positionMs,
          },
        }
      })
      setNow(Date.now())
    } catch {
      // Keep local controls resilient if playback state cannot be read right now.
    }
  }, [activeAccount?.id, setState])

  const loadSuggestedTracks = useCallback(async () => {
    if (!activeAccount?.id || suggestionContextRef.current === suggestionContext) {
      return
    }
    setSuggestionBusy(true)
    setSuggestedSourceLabel(
      suggestionTerms[0] ? `Based on ${suggestionTerms[0]}` : "Popular picks"
    )
    suggestionContextRef.current = suggestionContext
    try {
      const [recentResult, topShortResult, topMediumResult] =
        await Promise.allSettled([
          listSpotifyRecentTracks(activeAccount.id, 24),
          listSpotifyTopTracks(activeAccount.id, "short_term", 24),
          listSpotifyTopTracks(activeAccount.id, "medium_term", 24),
        ])

      const recentTracks =
        recentResult.status === "fulfilled" ? recentResult.value.tracks ?? [] : []
      const topTracks = dedupeBrowseTracks([
        ...(topShortResult.status === "fulfilled"
          ? topShortResult.value.tracks ?? []
          : []),
        ...(topMediumResult.status === "fulfilled"
          ? topMediumResult.value.tracks ?? []
          : []),
      ]).slice(0, 24)
      const exploreResults = await Promise.allSettled(
        EXPLORE_TERMS.map((term) => searchSpotify(term, activeAccount.id))
      )
      const curatedExplore = dedupeBrowseTracks(
        exploreResults.flatMap((result) =>
          result.status === "fulfilled" ? result.value.tracks ?? [] : []
        )
      ).slice(0, 24)

      setRecentSpotifyTracks(recentTracks)
      setTopSpotifyTracks(topTracks)
      setExploreTracks(curatedExplore)

      const combined: SpotifyBrowseTrack[] = dedupeBrowseTracks([
        ...recentTracks,
        ...topTracks,
        ...curatedExplore,
      ])

      if (combined.length < 24) {
        for (const term of suggestionTerms) {
          const result = await searchSpotify(term, activeAccount.id)
          const enriched = dedupeBrowseTracks([...combined, ...(result.tracks ?? [])])
          combined.splice(0, combined.length, ...enriched)
          if (combined.length >= 24) break
        }
      }

      if (recentTracks.length > 0) {
        setSuggestedSourceLabel("Recently played")
      } else if (topTracks.length > 0) {
        setSuggestedSourceLabel("Top tracks")
      } else if (suggestionTerms[0]) {
        setSuggestedSourceLabel(`Based on ${suggestionTerms[0]}`)
      }
      setSuggestedTracks(combined.slice(0, 24))
    } catch (err) {
      suggestionContextRef.current = ""
      setRecentSpotifyTracks([])
      setTopSpotifyTracks([])
      setExploreTracks([])
      setSuggestedTracks([])
    } finally {
      setSuggestionBusy(false)
    }
  }, [
    activeAccount?.id,
    suggestionContext,
    suggestionTerms,
    listSpotifyRecentTracks,
    listSpotifyTopTracks,
    searchSpotify,
  ])

  const playRandomRecommendation = async (
    accountId: string,
    deviceId: string | null
  ) => {
    const searchTerms = [
      ...new Set([
        ...buildSuggestionTerms(state),
        "top hits",
        "new music",
        "chill",
      ]),
    ]
    const query = searchTerms[Math.floor(Math.random() * searchTerms.length)] ?? "music"
    const result = await searchSpotify(query, accountId)
    const candidates = result.tracks
      .map((track) => ({
        title: track.title,
        artist: track.artist,
        album: track.album,
        url: track.url,
        uri: track.uri,
        imageUrl: track.imageUrl,
        durationMs: track.durationMs,
      }))
      .filter((track) => Boolean(track.uri))
    const fallbackTrack = candidates[Math.floor(Math.random() * candidates.length)]
    if (!fallbackTrack?.uri) throw new Error("No recommendation track available.")
    await playSpotify(accountId, fallbackTrack.uri, deviceId)
    setState((current) => ({
      ...current,
      activeAccountId: accountId,
      current: toMusicTrack(fallbackTrack),
      recentTracks: rememberRecentTrack(
        current.recentTracks ?? [],
        toMusicTrack(fallbackTrack)
      ),
      queue: trackListWithPrimary(toMusicTrack(fallbackTrack), result.tracks, current.queue).slice(0, 50),
      playback: {
        ...current.playback,
        isPlaying: true,
        startedAt: Date.now(),
        positionMs: 0,
      },
    }))
  }

  useEffect(() => {
    if (!state.playback.isPlaying) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [state.playback.isPlaying])

  useEffect(() => {
    if (!activeAccount?.id) return
    void syncFromSpotifyPlayback()
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncFromSpotifyPlayback()
      }
    }, 10000)
    const handleFocus = () => {
      if (document.visibilityState === "visible") void syncFromSpotifyPlayback()
    }
    window.addEventListener("focus", handleFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", handleFocus)
    }
  }, [activeAccount?.id, syncFromSpotifyPlayback])

  useEffect(() => {
    if (!spotify.length) {
      if (selectedAccountId) setSelectedAccountId("")
      if (state.activeAccountId) {
        setState((current) =>
          current.activeAccountId
            ? { ...current, activeAccountId: "" }
            : current
        )
      }
      return
    }
    const preferred = selectedAccountId || state.activeAccountId || ""
    const match = spotify.find((account) => account.id === preferred) ?? spotify[0]
    if (selectedAccountId !== match.id) setSelectedAccountId(match.id)
    if (state.activeAccountId !== match.id) {
      setState((current) =>
        current.activeAccountId === match.id
          ? current
          : { ...current, activeAccountId: match.id }
      )
    }
  }, [selectedAccountId, setState, spotify, state.activeAccountId])

  const loadPlaylists = useCallback(async () => {
    if (!activeAccount?.id) return
    setBrowseBusy(true)
    setBrowseError(null)
    setSearchAttempted(false)
    setLastSearchTerm("")
    setActiveFeed("auto")
    setSelectedPlaylist(null)
    setSpotifyPlaylistTracks([])
    try {
      const result = await listSpotifyPlaylists(activeAccount.id)
      setPlaylists(result.playlists)
      const hasSelection = selectedPlaylist?.id
        ? result.playlists.some((playlist) => playlist.id === selectedPlaylist.id)
        : false
      if (!hasSelection && result.playlists[0]) {
        setSelectedPlaylist(result.playlists[0])
      }
    } catch (err) {
      setBrowseError(spotifyErrorMessage(err))
    } finally {
      setBrowseBusy(false)
    }
  }, [activeAccount?.id, selectedPlaylist?.id])

  useEffect(() => {
    if (!spotifyConnected) return
    void loadPlaylists()
  }, [loadPlaylists, spotifyConnected])

  useEffect(() => {
    setDiagnostics(null)
    setTracks([])
    setSpotifyPlaylistTracks([])
    setSuggestedTracks([])
    setRecentSpotifyTracks([])
    setTopSpotifyTracks([])
    setExploreTracks([])
    setSuggestedSourceLabel("Popular picks")
    suggestionContextRef.current = ""
    setSelectedPlaylist(null)
    setBrowseError(null)
    setTransportError(null)
    setActiveDeviceLabel(null)
    setActiveFeed("auto")
  }, [activeAccount?.id])

  useEffect(() => {
    if (!activeAccount?.id) return
    if (spotifyPlaylistTracks.length || tracks.length) return
    if (suggestionBusy) return
    void loadSuggestedTracks()
  }, [
    activeAccount?.id,
    suggestionBusy,
    spotifyPlaylistTracks.length,
    tracks.length,
    suggestionContext,
    loadSuggestedTracks,
  ])

  const queueTrack = useCallback(
    async (track: SpotifyBrowseTrack | MusicTrack): Promise<boolean> => {
      if (!activeAccount?.id) {
        setTransportError("Connect Spotify first.")
        return false
      }
      const nextTrack = toMusicTrack(track)
      if (!nextTrack.uri) {
        setTransportError("Spotify returned a non-playable track.")
        return false
      }
      const trackUri = nextTrack.uri
      const key = trackKey(nextTrack)
      setTrackActionBusy({ type: "queue", key })
      setTransportError(null)
      try {
        await queueSpotifyTrack(activeAccount.id, trackUri)
          .catch(async (queueError) => {
            const queueErrorText = spotifyErrorMessage(queueError)
            if (/No active Spotify device|NO_ACTIVE_DEVICE|no active|active device not found/i.test(queueErrorText)) {
              const device = await resolvePlaybackDeviceTarget(activeAccount.id)
              setActiveDeviceLabel(device.label)
              await queueSpotifyTrack(activeAccount.id, trackUri, device.id)
            } else {
              throw queueError
            }
          })
      } catch (err) {
        setTransportError(
          `Could not queue on Spotify. Added locally: ${spotifyErrorMessage(err)}`
        )
      } finally {
        setState((current) => ({
          ...current,
          activeAccountId: activeAccount?.id ?? current.activeAccountId ?? "",
          current:
            current.current.uri || current.current.url
              ? current.current
              : nextTrack,
          recentTracks:
            current.current.uri || current.current.url
              ? current.recentTracks ?? []
              : rememberRecentTrack(current.recentTracks ?? [], nextTrack),
          queue: appendUnique(
            current.queue.filter((item) => item.uri || item.url),
            [nextTrack]
          ).slice(0, 36),
          playback:
            current.current.uri || current.current.url
              ? current.playback
              : {
                  isPlaying: false,
                  startedAt: null,
                  positionMs: 0,
                },
        }))
        setTrackActionBusy(null)
      }
      return true
    },
    [activeAccount?.id, setState]
  )

  const saveTrack = useCallback(
    async (track: SpotifyBrowseTrack | MusicTrack): Promise<boolean> => {
      if (!activeAccount?.id) {
        setTransportError("Connect Spotify first.")
        return false
      }
      if (!selectedPlaylist?.id) {
        setTransportError("Pick a playlist first before saving a track.")
        return false
      }
      const nextTrack = toMusicTrack(track)
      if (!nextTrack.uri) {
        setTransportError("Spotify returned a non-playable track.")
        return false
      }
      const key = trackKey(nextTrack)
      setTrackActionBusy({ type: "save", key })
      setTransportError(null)
      try {
        await saveTrackToPlaylist(activeAccount.id, selectedPlaylist.id, nextTrack.uri)
      } catch (err) {
        setTransportError(spotifyErrorMessage(err))
        return false
      } finally {
        setTrackActionBusy(null)
      }
      return true
    },
    [activeAccount?.id, selectedPlaylist?.id]
  )

  const playTrackNow = useCallback(
    async (
      track: SpotifyBrowseTrack | MusicTrack,
      sourceTracks: Array<SpotifyBrowseTrack | MusicTrack> = []
    ) => {
      if (!activeAccount?.id) return
      const nextTrack = toMusicTrack(track)
      if (!nextTrack.uri) {
        setTransportError("Spotify returned a non-playable track.")
        return
      }
      setTransportBusy("track")
      setTransportError(null)
      setBrowseError(null)
      try {
        const device = await resolvePlaybackDeviceTarget(activeAccount.id)
        await playSpotify(activeAccount.id, nextTrack.uri, device.id)
        setActiveDeviceLabel(device.label)
        setState((current) => ({
          ...current,
          activeAccountId: activeAccount.id,
          current: nextTrack,
          recentTracks: rememberRecentTrack(current.recentTracks ?? [], nextTrack),
          queue: trackListWithPrimary(nextTrack, sourceTracks, current.queue).slice(
            0,
            50
          ),
          playback: {
            isPlaying: true,
            startedAt: Date.now(),
            positionMs: 0,
          },
        }))
        void primeSpotifyQueue(activeAccount.id, device.id, nextTrack, sourceTracks)
        await syncFromSpotifyPlayback()
      } catch (err) {
        setTransportError(spotifyErrorMessage(err))
      } finally {
        setTransportBusy(null)
      }
    },
    [activeAccount?.id, setState, syncFromSpotifyPlayback, primeSpotifyQueue]
  )

  const runTransport = useCallback(
    async (action: "play" | "pause" | "next" | "previous") => {
      if (!activeAccount?.id) {
        setTransportError("Connect Spotify first.")
        return
      }
      if ((action === "play" || action === "pause") && !state.current.uri) {
        setTransportError("Pick a Spotify track first.")
        return
      }

      setTransportBusy(action)
      setTransportError(null)
      try {
        const device = await resolvePlaybackDeviceTarget(activeAccount.id)
        setActiveDeviceLabel(device.label)

        if (action === "pause") {
          await pauseSpotify(activeAccount.id, device.id)
          setState((current) => ({
            ...current,
            activeAccountId: activeAccount.id,
            playback: {
              ...current.playback,
              isPlaying: false,
              startedAt: null,
              positionMs: currentPositionMs(current),
            },
          }))
          await syncFromSpotifyPlayback()
          return
        }

        if (action === "play") {
          await playSpotify(activeAccount.id, state.current.uri, device.id)
          setState((current) => ({
            ...current,
            activeAccountId: activeAccount.id,
            playback: {
              ...current.playback,
              isPlaying: true,
              startedAt: Date.now(),
              positionMs: currentPositionMs(current),
            },
          }))
          await syncFromSpotifyPlayback()
          return
        }

        const queue = playableQueueTracks(state)
        const canUseLocalQueue = queue.length >= 2
        const target = canUseLocalQueue ? queueNeighborTrack(queue, state.current, action) : null

        if (canUseLocalQueue && target?.uri) {
          await playSpotify(activeAccount.id, target.uri, device.id)
          setState((current) => ({
            ...current,
            activeAccountId: activeAccount.id,
            current: target,
            recentTracks: rememberRecentTrack(current.recentTracks ?? [], target),
            queue: trackListWithPrimary(target, queue, current.queue).slice(0, 50),
            playback: {
              ...current.playback,
              isPlaying: true,
              startedAt: Date.now(),
              positionMs: 0,
            },
          }))
        } else if (action === "next") {
          try {
            await nextSpotify(activeAccount.id, device.id)
          } catch {
            await playRandomRecommendation(activeAccount.id, device.id)
          }
        } else {
          try {
            await previousSpotify(activeAccount.id, device.id)
          } catch {
            await playRandomRecommendation(activeAccount.id, device.id)
          }
        }
        await syncFromSpotifyPlayback()
      } catch (err) {
        setTransportError(spotifyErrorMessage(err))
      } finally {
        setTransportBusy(null)
      }
    },
    [activeAccount?.id, setState, state, syncFromSpotifyPlayback]
  )

  async function primeSpotifyQueue(
    accountId: string,
    deviceId: string | null,
    current: MusicTrack,
    sourceTracks: Array<SpotifyBrowseTrack | MusicTrack>
  ) {
    const seen = new Set<string>([trackKey(current)])
    const candidates = sourceTracks
      .map((track) => toMusicTrack(track))
      .filter((track) => Boolean(track.uri))
      .filter((track) => {
        const key = trackKey(track)
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 5)

    if (!candidates.length) return
    await Promise.allSettled(
      candidates.map((track) =>
        queueSpotifyTrack(accountId, track.uri!, deviceId ?? undefined)
      )
    )
  }

  useEffect(() => {
    if (!state.playback.isPlaying) return
    if (!state.current.durationMs || !state.current.uri) return
    if (transportBusy) return
    const remaining = state.current.durationMs - positionMs
    if (remaining > 1200) return
    const advanceKey = `${trackKey(state.current)}:${Math.floor(state.current.durationMs / 1000)}`
    if (autoAdvanceRef.current === advanceKey) return
    autoAdvanceRef.current = advanceKey
    void runTransport("next")
  }, [
    positionMs,
    state.playback.isPlaying,
    state.current.durationMs,
    state.current.uri,
    transportBusy,
    runTransport,
  ])

  const runDiagnostics = async () => {
    if (!activeAccount?.id) return
    setDiagnosticsBusy(true)
    setBrowseError(null)
    try {
      const result = await getSpotifyDiagnostics(activeAccount.id)
      setDiagnostics(result)
    } catch (err) {
      setBrowseError(spotifyErrorMessage(err))
      setDiagnostics(null)
    } finally {
      setDiagnosticsBusy(false)
    }
  }

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault()
    const term = query.trim()
    if (!activeAccount?.id || !term) return
    setSearchBusy(true)
    setBrowseError(null)
    setSearchAttempted(true)
    setLastSearchTerm(term)
    setActiveFeed("search")
    setSpotifyPlaylistTracks([])
    try {
      const result = await searchSpotify(term, activeAccount.id)
      setTracks(result.tracks ?? [])
      setPlaylists(result.playlists ?? [])
      const hasSelection = selectedPlaylist?.id
        ? result.playlists.some((playlist) => playlist.id === selectedPlaylist.id)
        : false
      if (!hasSelection && result.playlists.length > 0) {
        setSelectedPlaylist(result.playlists[0] ?? null)
      }
    } catch (err) {
      setBrowseError(spotifyErrorMessage(err))
      setTracks([])
      setPlaylists([])
    } finally {
      setSearchBusy(false)
    }
  }

  const openPlaylist = async (playlist: SpotifyBrowsePlaylist) => {
    if (!activeAccount?.id) return
    setSelectedPlaylist(playlist)
    setActiveFeed("auto")
    setBrowseBusy(true)
    setBrowseError(null)
    setState((current) => ({
      ...current,
      activeAccountId: activeAccount.id,
      playlistName: playlist.name,
      playlistUrl: playlist.url,
    }))
    try {
      const result = await listSpotifyPlaylistTracks(playlist.id, activeAccount.id)
      setSpotifyPlaylistTracks(result.tracks)
      if (!state.current.uri && result.tracks[0]) {
        const seed = toMusicTrack(result.tracks[0])
        setState((current) => ({
          ...current,
          activeAccountId: activeAccount.id,
          current: seed,
          recentTracks: rememberRecentTrack(current.recentTracks ?? [], seed),
          queue: trackListWithPrimary(seed, result.tracks, current.queue).slice(0, 50),
        }))
      }
    } catch (err) {
      setBrowseError(spotifyErrorMessage(err))
      setSpotifyPlaylistTracks([])
    } finally {
      setBrowseBusy(false)
    }
  }

  if (isFloating) {
    return (
      <div className="min-h-screen bg-[#f3eadb] p-4 text-[#2b1d0f]">
        <div className="mx-auto max-w-[430px] space-y-4">
          <section className="rounded-3xl border border-[#dfcfb1] bg-[#fffaf1] p-4 shadow-[0_24px_60px_-48px_rgba(72,45,14,0.7)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
                  Now Playing
                </p>
                <h2 className="mt-1 text-xl font-extrabold tracking-[-0.03em] text-[#2b1d0f]">
                  {state.current.title || "No track selected"}
                </h2>
              </div>
              <Link to="/music" className="odin-light-action h-9 px-3 text-xs">
                Full
              </Link>
            </div>
            <QueueList
              tracks={state.queue.filter((track) => track.uri || track.url)}
            />
          </section>
        </div>
      </div>
    )
  }

  const startSpotifyLogin = async () => {
    if (connectBusy) return
    setConnectBusy(true)
    setConnectError(null)
    try {
      await connectSpotify({
        label: connectLabel.trim() || "Music",
        redirectTo: odinRouteUrl("/music"),
      })
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Could not start Spotify login."
      )
      setConnectBusy(false)
    }
  }

  return (
    <LightPageShell>
      <div className="mx-auto w-full max-w-[1680px] space-y-8">
        <LightPageHeader
          title="Music"
          subtitle="Spotify browser"
          action={
            <Link to="/connections" className="odin-light-action h-11 px-5 text-sm">
              <Radio size={14} />
              Accounts
            </Link>
          }
        />
        <div className="-mt-4 flex flex-wrap items-center gap-2">
          <ConnectionStatusChip
            label="Spotify"
            tone={spotifyConnected ? "connected" : "disconnected"}
            detail={spotifyConnected ? `${spotify.length} account${spotify.length === 1 ? "" : "s"}` : "not linked"}
          />
        </div>

        {!spotifyConnected ? (
          <section className="odin-light-card rounded-3xl p-7">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <label className="grid gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#9b815e]">
                  Account Label
                </span>
                <input
                  value={connectLabel}
                  onChange={(event) => setConnectLabel(event.target.value)}
                  className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-sm"
                  placeholder="Music"
                />
              </label>
              <button
                type="button"
                onClick={() => void startSpotifyLogin()}
                disabled={connectBusy}
                className="odin-light-action-primary h-11 rounded-xl px-5 text-sm disabled:opacity-60"
              >
                <Radio size={14} />
                {connectBusy ? "Opening Spotify..." : "Login with Spotify"}
              </button>
            </div>
            {connectError && (
              <p
                className="mt-4 rounded-xl border border-[#bd5a18]/30 bg-[#fff2e8] px-3 py-2 text-xs font-semibold text-[#9b3e12]"
                role="alert"
              >
                {connectError}
              </p>
            )}
          </section>
        ) : (
          <section className="grid gap-5 xl:h-[calc(100dvh-210px)] xl:grid-cols-[minmax(340px,410px)_minmax(0,1fr)]">
            <section className="odin-light-card flex min-h-[500px] flex-col rounded-3xl p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
                    Now Playing
                  </p>
                  <p className="mt-1 text-xs font-bold text-[#6d5334]">
                    {activeDeviceLabel ? `Device: ${activeDeviceLabel}` : "Spotify ready"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={openMusicPopout}
                  className="odin-light-action h-10 px-4 text-xs"
                >
                  <PanelTopOpen size={13} />
                  Floating player
                </button>
              </div>

              <div className="mt-4 rounded-3xl border border-[#dfcfb1] bg-[#080808] p-3.5 text-white shadow-[0_24px_56px_-42px_rgba(0,0,0,0.9)]">
                <div className="flex items-start gap-4">
                  <Artwork url={state.current.imageUrl ?? null} label={state.current.title} size="hero" />
                  <div className="min-w-0 flex-1 pt-1">
                    <h3 className="truncate text-3xl font-extrabold tracking-[-0.03em]">
                      {state.current.title || "No track selected"}
                    </h3>
                    <p className="mt-2 truncate text-base font-semibold text-white/70">
                      {[state.current.artist, state.current.album].filter(Boolean).join(" · ") ||
                        "Connect Spotify"}
                    </p>
                  </div>
                </div>

                <div className="mt-6 flex items-center justify-center gap-7">
                  <button
                    type="button"
                    onClick={() => void runTransport("previous")}
                    disabled={Boolean(transportBusy)}
                    className="grid h-10 w-10 place-items-center rounded-full text-white/85 transition hover:text-white disabled:opacity-50"
                    aria-label="Previous track"
                    title="Previous track"
                  >
                    {transportBusy === "previous" ? (
                      <Loader2 size={20} className="animate-spin" />
                    ) : (
                      <SkipBack size={22} fill="currentColor" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void runTransport(state.playback.isPlaying ? "pause" : "play")
                    }
                    disabled={Boolean(transportBusy)}
                    className="grid h-14 w-14 place-items-center rounded-full bg-white text-black transition hover:scale-[1.03] disabled:opacity-60"
                    aria-label={state.playback.isPlaying ? "Pause track" : "Play track"}
                    title={state.playback.isPlaying ? "Pause track" : "Play track"}
                  >
                    {transportBusy === "play" || transportBusy === "pause" ? (
                      <Loader2 size={24} className="animate-spin" />
                    ) : state.playback.isPlaying ? (
                      <Pause size={24} fill="currentColor" />
                    ) : (
                      <Play size={24} fill="currentColor" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runTransport("next")}
                    disabled={Boolean(transportBusy)}
                    className="grid h-10 w-10 place-items-center rounded-full text-white/85 transition hover:text-white disabled:opacity-50"
                    aria-label="Next track"
                    title="Next track"
                  >
                    {transportBusy === "next" ? (
                      <Loader2 size={20} className="animate-spin" />
                    ) : (
                      <SkipForward size={22} fill="currentColor" />
                    )}
                  </button>
                </div>

                <div className="mt-5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 font-mono-data text-sm font-bold text-white/75">
                  <span>{formatTime(positionMs, "0:00")}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/22">
                    <span
                      className="block h-full rounded-full bg-white transition-[width] duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <span>{formatTime(durationMs)}</span>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {state.current.url ? (
                  <a
                    href={state.current.url}
                    target="_blank"
                    rel="noreferrer"
                    className="odin-light-action h-10 px-4 text-xs"
                  >
                    <ExternalLink size={13} />
                    Open track
                  </a>
                ) : null}
                <a
                  href={spotifySearchUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="odin-light-action h-10 px-4 text-xs"
                >
                  <ExternalLink size={13} />
                  Open Spotify
                </a>
              </div>

              {transportError ? (
                <p
                  className="mt-4 rounded-xl border border-[#bd5a18]/30 bg-[#fff2e8] px-3 py-2 text-xs font-semibold text-[#9b3e12]"
                  role="alert"
                >
                  {transportError}
                </p>
              ) : null}
            </section>

            <section className="odin-light-card flex min-h-[500px] flex-col rounded-3xl p-5">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#9b815e]">
                    Spotify account
                  </span>
                  <select
                    value={activeAccount?.id ?? ""}
                    onChange={(event) => {
                      const nextId = event.target.value
                      setSelectedAccountId(nextId)
                      setState((current) => ({
                        ...current,
                        activeAccountId: nextId,
                      }))
                    }}
                    className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-sm"
                  >
                    {spotify.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.accountLabel}
                        {account.accountEmail ? ` · ${account.accountEmail}` : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  onClick={() => void runDiagnostics()}
                  disabled={diagnosticsBusy}
                  className="odin-light-action h-11 px-4 text-xs disabled:opacity-55"
                >
                  {diagnosticsBusy ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Check size={13} />
                  )}
                  Check link
                </button>

                <a
                  href={spotifySearchUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="odin-light-action h-11 px-4 text-xs"
                >
                  <ExternalLink size={13} />
                  Open Spotify
                </a>
              </div>

              <form onSubmit={runSearch} className="mt-4 flex gap-2">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="odin-light-control h-12 min-w-0 flex-1 rounded-xl border-[#d7c29d] bg-white px-3 text-sm"
                  placeholder="Search songs, artists, playlists"
                />
                <button
                  type="submit"
                  disabled={searchBusy || !query.trim()}
                  className="odin-light-action-primary h-12 rounded-xl px-5 text-sm disabled:opacity-55"
                >
                  {searchBusy ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Search size={15} />
                  )}
                  Browse
                </button>
              </form>

              {diagnostics ? (
                <div className="mt-4 rounded-2xl border border-[#dfcfb1] bg-[#fffaf1] px-4 py-3 text-xs font-semibold text-[#6d5334]">
                  <p>
                    {diagnostics.profile?.displayName ||
                      diagnostics.account?.label ||
                      "Spotify account"}{" "}
                    · {(diagnostics.profile?.product || "unknown").toUpperCase()} ·{" "}
                    {(diagnostics.profile?.country || "??").toUpperCase()} · probe "
                    {diagnostics.probes?.searchQuery || "The Weeknd"}" ={" "}
                    {diagnostics.probes?.searchTracks ?? 0} track(s)
                  </p>
                  {Array.isArray(diagnostics.warnings) &&
                  diagnostics.warnings.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-[#9b3e12]">
                      {diagnostics.warnings.map((warning) => (
                        <li key={warning} className="flex gap-2">
                          <AlertCircle size={12} className="mt-0.5 shrink-0" />
                          <span>{warning}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {browseError ? (
                <p
                  className="mt-4 rounded-xl border border-[#bd5a18]/30 bg-[#fff2e8] px-3 py-2 text-xs font-semibold text-[#9b3e12]"
                  role="alert"
                >
                  {browseError}
                </p>
              ) : null}

              <div className="mt-4 grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(240px,0.75fr)_minmax(0,1.25fr)]">
                {showPlaylistPanel ? (
                  <section className="flex min-h-0 flex-col rounded-2xl border border-[#dfcfb1] bg-[#fffaf1] p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
                          Playlists
                        </p>
                        <h3 className="mt-1 text-lg font-extrabold text-[#2b1d0f]">
                          {selectedPlaylist ? selectedPlaylist.name : "Spotify library"}
                        </h3>
                      </div>
                      {browseBusy ? (
                        <Loader2 className="animate-spin text-[#b6531c]" size={18} />
                      ) : (
                        <Disc3 className="text-[#b6531c]" size={18} />
                      )}
                    </div>

                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                      {playlists.length ? (
                        playlists.map((playlist) => (
                          <PlaylistRow
                            key={`${playlist.id}-${playlist.uri}`}
                            playlist={playlist}
                            selected={selectedPlaylist?.id === playlist.id}
                            onSelect={() => void openPlaylist(playlist)}
                          />
                        ))
                      ) : (
                        <div className="rounded-2xl border border-[#dfcfb1] bg-white px-3 py-3 text-xs font-semibold text-[#8a6b46]">
                          {searchAttempted
                            ? `No playlists matched "${lastSearchTerm}".`
                            : "No saved playlists were returned for this account."}
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void loadPlaylists()}
                              disabled={browseBusy}
                              className="odin-light-action h-8 px-3 text-[11px] disabled:opacity-55"
                            >
                              {browseBusy ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Disc3 size={12} />
                              )}
                              Refresh
                            </button>
                            <a
                              href={lastSearchUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="odin-light-action h-8 px-3 text-[11px]"
                            >
                              <ExternalLink size={12} />
                              Open in Spotify
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                ) : null}

                <section
                  className={[
                    "flex min-h-0 flex-col rounded-2xl border border-[#dfcfb1] bg-[#fffaf1] p-4",
                    showPlaylistPanel ? "" : "lg:col-span-2",
                  ].join(" ")}
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
                        Tracks
                      </p>
                      <h3 className="mt-1 text-lg font-extrabold text-[#2b1d0f]">
                        {selectedPlaylist
                          ? selectedPlaylist.name
                          : tracks.length
                          ? "Search results"
                          : resolvedFeed === "recent"
                          ? "Recently played"
                          : resolvedFeed === "top"
                          ? "Top tracks"
                          : resolvedFeed === "explore"
                          ? "Explore now"
                          : resolvedFeed === "artists"
                          ? "Artists you play"
                          : resolvedFeed === "albums"
                          ? "Albums you play"
                          : resolvedFeed === "queue"
                          ? "Up next"
                          : suggestedTracks.length
                          ? suggestedSourceLabel
                          : localRecentTracks.length
                          ? "Recently played in ODIN"
                          : searchAttempted
                          ? "Search results"
                          : "Pick from Spotify"}
                      </h3>
                    </div>
                    <ListMusic className="text-[#b6531c]" size={18} />
                  </div>

                  {spotifyPlaylistTracks.length === 0 && tracks.length === 0 ? (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {feedButtons.map((feed) =>
                        feed.count > 0 ? (
                          <button
                            key={feed.key}
                            type="button"
                            onClick={() => setActiveFeed(feed.key)}
                            className={[
                              "rounded-full border px-3 py-1.5 text-[11px] font-bold transition",
                              resolvedFeed === feed.key
                                ? "border-[#b6531c] bg-[#fff2e8] text-[#8b3f14]"
                                : "border-[#dfcfb1] bg-white text-[#8a6b46] hover:border-[#b6531c]/55",
                            ].join(" ")}
                          >
                            {feed.label} · {feed.count}
                          </button>
                        ) : null
                      )}
                    </div>
                  ) : null}

                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                    {visibleTracks.length ? (
                      visibleTracks.map((track) => (
                        <TrackRow
                          key={`${track.id}-${track.uri}`}
                          track={track}
                          active={state.current.uri === track.uri}
                          busy={transportBusy === "track"}
                          onPlay={() => void playTrackNow(track, visibleTracks)}
                          onQueue={() => queueTrack(track)}
                          onSave={() => saveTrack(track)}
                          playlistSelected={showPlaylistPanel && Boolean(selectedPlaylist)}
                          trackActionState={
                            trackActionBusy?.key === trackKey(track)
                              ? trackActionBusy.type
                              : null
                          }
                        />
                      ))
                    ) : (
                      <p className="rounded-2xl border border-[#dfcfb1] bg-white px-4 py-4 text-sm font-bold text-[#8a6b46]">
                        {suggestionBusy
                          ? "Loading suggested tracks..."
                          : suggestedTracks.length
                          ? "No tracks matched this view. Start a search to load fresh results."
                          : queueTracks.length
                          ? "No Spotify suggestions returned yet. Showing your queue."
                          : localRecentTracks.length
                          ? "No Spotify suggestions returned yet. Showing your ODIN recent plays."
                          : searchAttempted
                          ? `No tracks returned for "${lastSearchTerm}". Open this query in Spotify Web or run "Check link" to verify this account.`
                          : "Search Spotify or open a playlist. ODIN also pulls recent, top, artist, album, and queue-based picks automatically."}
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </section>
          </section>
        )}
      </div>
    </LightPageShell>
  )
}

function TrackRow({
  track,
  active,
  busy,
  onPlay,
  onQueue,
  onSave,
  playlistSelected,
  trackActionState,
}: {
  track: SpotifyBrowseTrack
  active: boolean
  busy: boolean
  onPlay: () => void
  onQueue: () => Promise<boolean>
  onSave: () => Promise<boolean>
  playlistSelected: boolean
  trackActionState: "queue" | "save" | null
}) {
  const [reaction, setReaction] = useState<"queued" | "saved" | null>(null)

  const queueWithReaction = async () => {
    setReaction(null)
    const ok = await onQueue()
    if (ok) {
      setReaction("queued")
      window.setTimeout(() => setReaction(null), 900)
    }
  }

  const saveWithReaction = async () => {
    if (!playlistSelected) return
    setReaction(null)
    const ok = await onSave()
    if (ok) {
      setReaction("saved")
      window.setTimeout(() => setReaction(null), 900)
    }
  }

  return (
    <div
      data-odin-track-row="search-result"
      data-reaction={reaction ?? "idle"}
      className={[
        "odin-track-row relative flex min-h-14 items-center gap-3 overflow-hidden rounded-2xl border bg-[#fffaf1] px-3 py-2.5 text-left transition",
        active
          ? "border-[#b6531c] shadow-[0_16px_34px_-30px_rgba(181,83,28,0.9)]"
          : "border-[#dfcfb1] hover:border-[#b6531c]/55",
      ].join(" ")}
    >
      {reaction ? (
        <span className="odin-track-row__toast">
          {reaction === "queued" ? "Queued after current" : "Saved to playlist"}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onPlay}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Artwork url={track.imageUrl} label={track.title} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-extrabold text-[#2b1d0f]">
            {track.title}
          </span>
          <span className="block truncate text-xs font-bold text-[#9b815e]">
            {track.artist} {track.album ? `· ${track.album}` : ""}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onPlay}
          disabled={busy}
          className="grid h-8 w-8 place-items-center rounded-full bg-[#b6531c] text-white transition hover:bg-[#9d4617] disabled:opacity-60"
          aria-label={`Play ${track.title}`}
          title="Play now"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Play size={13} fill="currentColor" />
          )}
        </button>
        <button
          type="button"
          onClick={() => void queueWithReaction()}
          className={[
            "grid h-8 w-8 place-items-center rounded-full border transition",
            trackActionState === "queue"
              ? "odin-track-action-pop border-[#b6531c] bg-[#fff2e8] text-[#b6531c]"
              : "border-[#dfcfb1] text-[#6d5334] hover:border-[#b6531c]/55",
          ].join(" ")}
          aria-label={`Queue ${track.title}`}
          title="Queue track"
        >
          {trackActionState === "queue" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : reaction === "queued" ? (
            <Check size={14} />
          ) : (
            <ListPlus size={14} />
          )}
        </button>
        {playlistSelected ? (
          <button
            type="button"
            onClick={() => void saveWithReaction()}
            className="grid h-8 w-8 place-items-center rounded-full border border-[#dfcfb1] text-[#6d5334] transition hover:border-[#b6531c]/55"
            aria-label={`Save ${track.title}`}
            title="Save track to playlist"
          >
            {trackActionState === "save" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : reaction === "saved" ? (
              <Check size={14} />
            ) : (
              <Plus size={14} />
            )}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function QueueList({ tracks }: { tracks: MusicTrack[] }) {
  if (!tracks.length) {
    return (
      <p className="mt-4 rounded-2xl border border-[#dfcfb1] bg-[#fffaf1] px-4 py-4 text-sm font-bold text-[#8a6b46]">
        Queue tracks from the full Music page.
      </p>
    )
  }
  return (
    <div className="mt-4 grid gap-2">
      {tracks.slice(0, 8).map((track, index) => (
        <div
          key={`${trackKey(track)}-${index}`}
          className="flex min-h-14 items-center gap-3 rounded-2xl border border-[#dfcfb1] bg-[#fffaf1] px-3 py-2"
        >
          <Artwork url={track.imageUrl ?? null} label={track.title} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-extrabold text-[#2b1d0f]">
              {track.title}
            </span>
            <span className="block truncate text-xs font-bold text-[#9b815e]">
              {track.artist}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

function PlaylistRow({
  playlist,
  selected,
  onSelect,
}: {
  playlist: SpotifyBrowsePlaylist
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "flex min-h-16 items-center gap-3 rounded-2xl border px-3 py-3 text-left transition",
        selected
          ? "border-[#b6531c] bg-[#fff2e8]"
          : "border-[#dfcfb1] bg-[#fffaf1] hover:border-[#b6531c]/55",
      ].join(" ")}
    >
      <Artwork url={playlist.imageUrl} label={playlist.name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-extrabold text-[#2b1d0f]">
          {playlist.name}
        </span>
        <span className="block truncate text-xs font-bold text-[#9b815e]">
          {playlist.owner} · {playlist.total} tracks
        </span>
      </span>
    </button>
  )
}

function Artwork({
  url,
  label,
  size = "row",
}: {
  url: string | null
  label: string
  size?: "row" | "hero"
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(url)
  const [lastGoodUrl, setLastGoodUrl] = useState<string | null>(url)

  useEffect(() => {
    if (url) {
      setResolvedUrl(url)
      return
    }
    setResolvedUrl(lastGoodUrl)
  }, [lastGoodUrl, url])

  const shellClass =
    size === "hero"
      ? "h-[148px] w-[148px] rounded-2xl border-white/18 bg-white/10"
      : "h-11 w-11 rounded-xl border-[#dfcfb1] bg-[#f8eddb]"
  const iconClass =
    size === "hero" ? "text-white/78" : "text-[#b6531c]"
  const iconSize = size === "hero" ? 30 : 16

  return (
    <span
      className={[
        "grid shrink-0 place-items-center overflow-hidden border",
        shellClass,
      ].join(" ")}
    >
      {resolvedUrl ? (
        <img
          src={resolvedUrl}
          alt={label}
          className="h-full w-full object-cover"
          loading="lazy"
          onLoad={() => setLastGoodUrl(resolvedUrl)}
          onError={() => {
            if (lastGoodUrl && lastGoodUrl !== resolvedUrl) {
              setResolvedUrl(lastGoodUrl)
            } else {
              setResolvedUrl(null)
            }
          }}
        />
      ) : (
        <Music2 size={iconSize} className={iconClass} />
      )}
    </span>
  )
}

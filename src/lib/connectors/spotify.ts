import { supabase } from "@/lib/supabaseClient"
import { odinRouteUrl } from "@/lib/desktopRoute"
import { invokeProxy } from "@/lib/connectors/proxy"

export const SPOTIFY_PROVIDER = "spotify"

interface OAuthStartResponse {
  data?: { url: string; state: string }
  error?: string
}

async function readFunctionError(error: unknown): Promise<string> {
  const fallback =
    error instanceof Error ? error.message : "Failed to start Spotify connect."

  if (error && typeof error === "object" && "context" in error) {
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const payload = (await context.clone().json()) as {
          error?: string
          message?: string
        }
        const message = payload.error ?? payload.message
        if (message === "Server not configured") {
          return "Spotify OAuth is missing SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Supabase secrets."
        }
        if (message) return message
      } catch {
        // Keep the Supabase client fallback when the body is not JSON.
      }
    }
  }

  if (fallback === "Failed to send a request to the Edge Function") {
    return "Spotify OAuth function is not reachable. Deploy oauth-start-spotify and check Supabase function config."
  }

  return fallback
}

export interface StartSpotifyOptions {
  label?: string
  redirectTo?: string
}

export async function startSpotifyConnect(
  opts: StartSpotifyOptions = {}
): Promise<string> {
  const body: Record<string, unknown> = {}
  if (opts.redirectTo) body.redirect_to = opts.redirectTo
  if (opts.label) body.label = opts.label

  const { data, error } = await supabase.functions.invoke<OAuthStartResponse>(
    "oauth-start-spotify",
    { body }
  )
  if (error) throw new Error(await readFunctionError(error))
  if (data?.error) throw new Error(data.error)
  if (!data?.data?.url) {
    throw new Error("oauth-start-spotify returned no URL")
  }
  return data.data.url
}

export async function connectSpotify(
  opts: StartSpotifyOptions = {}
): Promise<void> {
  const here = odinRouteUrl("/music")
  const url = await startSpotifyConnect({
    redirectTo: here,
    ...opts,
  })
  window.location.assign(url)
}

export async function disconnectSpotify(
  userId: string,
  accountId: string
): Promise<void> {
  const { error } = await supabase
    .from("connected_accounts")
    .delete()
    .eq("user_id", userId)
    .eq("id", accountId)
    .eq("provider", SPOTIFY_PROVIDER)
  if (error) throw new Error(error.message)
}

export interface SpotifyBrowseTrack {
  id: string
  title: string
  artist: string
  album: string
  url: string
  uri: string
  imageUrl: string | null
  durationMs: number | null
}

export interface SpotifyBrowsePlaylist {
  id: string
  name: string
  owner: string
  url: string
  uri: string
  imageUrl: string | null
  total: number
}

export interface SpotifySearchResponse {
  ok: boolean
  error?: string
  tracks: SpotifyBrowseTrack[]
  playlists: SpotifyBrowsePlaylist[]
}

export interface SpotifyPlaylistsResponse {
  ok: boolean
  error?: string
  total: number
  playlists: SpotifyBrowsePlaylist[]
}

export interface SpotifyPlaylistTracksResponse {
  ok: boolean
  error?: string
  total: number
  tracks: SpotifyBrowseTrack[]
}

export interface SpotifyRecentTracksResponse {
  ok: boolean
  error?: string
  tracks: SpotifyBrowseTrack[]
}

export interface SpotifyTopTracksResponse {
  ok: boolean
  error?: string
  tracks: SpotifyBrowseTrack[]
}

export interface SpotifyPlaybackResponse {
  ok: boolean
  error?: string
  status: number | null
}

export interface SpotifyCurrentPlaybackTrack {
  id: string
  title: string
  artist: string
  album: string
  url: string
  uri: string
  imageUrl: string | null
  durationMs: number | null
}

export interface SpotifyCurrentPlaybackResponse {
  ok: boolean
  error?: string
  isPlaying: boolean
  positionMs: number
  track: SpotifyCurrentPlaybackTrack | null
}

export interface SpotifyQueueResponse {
  ok: boolean
  error?: string
  status: number | null
}

export interface SpotifySaveToPlaylistResponse {
  ok: boolean
  error?: string
  status: number | null
  snapshotId?: string | null
}

export interface SpotifyDevice {
  id: string | null
  name: string
  type: string
  isActive: boolean
  isRestricted: boolean
}

export interface SpotifyDevicesResponse {
  ok: boolean
  error?: string
  devices: SpotifyDevice[]
}

export interface SpotifyDiagnosticsResponse {
  ok: boolean
  error?: string
  account?: {
    id: string
    label: string
    workspace: string | null
    email: string | null
    isPrimary: boolean
    expiresAt: string | null
  }
  profile?: {
    id: string | null
    displayName: string | null
    email: string | null
    country: string | null
    product: string | null
    uri: string | null
    profileUrl: string | null
  }
  scopes?: string[]
  probes?: {
    searchQuery: string
    searchTracks: number
    playlistsTotal: number
  }
  warnings?: string[]
}

const SPOTIFY_PROXY = "spotify-proxy"
const CURRENT_PLAYBACK_CACHE_TTL_MS = 10_500
const CURRENT_PLAYBACK_MAX_COOLDOWN_MS = 60_000

type PlaybackCacheEntry = {
  value: SpotifyCurrentPlaybackResponse | null
  fetchedAt: number
  inFlight: Promise<SpotifyCurrentPlaybackResponse> | null
  failureCount: number
  blockedUntil: number
  lastError: Error | null
}

const playbackCache = new Map<string, PlaybackCacheEntry>()

function playbackCacheKey(accountId?: string | null) {
  return accountId?.trim() || "__primary__"
}

function playbackEntry(accountId?: string | null): PlaybackCacheEntry {
  const key = playbackCacheKey(accountId)
  const existing = playbackCache.get(key)
  if (existing) return existing
  const created: PlaybackCacheEntry = {
    value: null,
    fetchedAt: 0,
    inFlight: null,
    failureCount: 0,
    blockedUntil: 0,
    lastError: null,
  }
  playbackCache.set(key, created)
  return created
}

function notePlaybackFailure(entry: PlaybackCacheEntry, error: Error) {
  const message = error.message || ""
  if (
    /no active spotify device|no active device|spotify playback 404|premium|required|reconnect|unauthorized/i.test(
      message
    )
  ) {
    entry.failureCount = Math.max(entry.failureCount, 1)
    entry.blockedUntil = Date.now() + CURRENT_PLAYBACK_MAX_COOLDOWN_MS
    entry.lastError = error
    return
  }
  const nextFailureCount = entry.failureCount + 1
  const cooldownMs = Math.min(
    CURRENT_PLAYBACK_MAX_COOLDOWN_MS,
    Math.max(5_000, 5_000 * 2 ** Math.min(nextFailureCount - 1, 4))
  )
  entry.failureCount = nextFailureCount
  entry.blockedUntil = Date.now() + cooldownMs
  entry.lastError = error
}

export function invalidateCurrentPlaybackCache(accountId?: string | null) {
  if (accountId) {
    playbackCache.delete(playbackCacheKey(accountId))
    return
  }
  playbackCache.clear()
}

function spotifyProxyError(action: string, message?: string) {
  return new Error(message ? `Spotify ${action} failed: ${message}` : `Spotify ${action} failed.`)
}

export async function searchSpotify(
  q: string,
  accountId?: string | null
): Promise<SpotifySearchResponse> {
  const { data, error } = await invokeProxy<SpotifySearchResponse>(
    SPOTIFY_PROXY,
    "search",
    { q, limit: 10 },
    accountId
  )
  if (error) throw error
  if (!data?.ok) throw spotifyProxyError("search", data?.error)
  return data
}

export async function listSpotifyPlaylists(
  accountId?: string | null
): Promise<SpotifyPlaylistsResponse> {
  const { data, error } = await invokeProxy<SpotifyPlaylistsResponse>(
    SPOTIFY_PROXY,
    "list_playlists",
    { limit: 20 },
    accountId
  )
  if (error) throw error
  if (!data?.ok) throw spotifyProxyError("playlist browse", data?.error)
  return data
}

export async function listSpotifyPlaylistTracks(
  playlistId: string,
  accountId?: string | null
): Promise<SpotifyPlaylistTracksResponse> {
  const { data, error } = await invokeProxy<SpotifyPlaylistTracksResponse>(
    SPOTIFY_PROXY,
    "playlist_tracks",
    { playlist_id: playlistId, limit: 30 },
    accountId
  )
  if (error) throw error
  if (!data?.ok) throw spotifyProxyError("playlist tracks", data?.error)
  return data
}

export async function listSpotifyRecentTracks(
  accountId?: string | null,
  limit = 30
): Promise<SpotifyRecentTracksResponse> {
  const { data, error } = await invokeProxy<SpotifyRecentTracksResponse>(
    SPOTIFY_PROXY,
    "recent_tracks",
    { limit },
    accountId
  )
  if (error) throw error
  if (!data?.ok) throw spotifyProxyError("recent tracks", data?.error)
  return data
}

export async function listSpotifyTopTracks(
  accountId?: string | null,
  timeRange: "short_term" | "medium_term" | "long_term" = "short_term",
  limit = 20
): Promise<SpotifyTopTracksResponse> {
  const { data, error } = await invokeProxy<SpotifyTopTracksResponse>(
    SPOTIFY_PROXY,
    "top_tracks",
    { time_range: timeRange, limit },
    accountId
  )
  if (error) throw error
  if (!data?.ok) throw spotifyProxyError("top tracks", data?.error)
  return data
}

function playbackErrorMessage(message?: string) {
  const raw = message ?? ""
  if (/404|NO_ACTIVE_DEVICE|No active device|not found/i.test(raw)) {
    return "No active Spotify device found. Open Spotify on this Mac or phone, start any track once, then try ODIN again."
  }
  if (/403|PREMIUM_REQUIRED|premium|Forbidden/i.test(raw)) {
    return "Spotify playback control requires a Premium account and an allowlisted user."
  }
  if (/401|Unauthorized/i.test(raw)) {
    return "Spotify needs to be reconnected before playback can be controlled."
  }
  return raw || "Spotify playback failed."
}

async function invokePlayback(
  action: "play" | "pause" | "next" | "previous",
  accountId?: string | null,
  uri?: string,
  deviceId?: string | null
): Promise<SpotifyPlaybackResponse> {
  const params: Record<string, string> = {}
  if (uri) params.uri = uri
  if (deviceId) params.device_id = deviceId
  const { data, error } = await invokeProxy<SpotifyPlaybackResponse>(
    SPOTIFY_PROXY,
    action,
    params,
    accountId,
    { timeoutMs: 6_000 }
  )
  if (error) throw error
  if (!data?.ok) throw spotifyProxyError("playback", playbackErrorMessage(data?.error))
  invalidateCurrentPlaybackCache(accountId)
  return data
}

async function invokeSimpleAction<T extends { status?: number | null }>(
  action: string,
  accountId?: string | null,
  params?: Record<string, string>
): Promise<T> {
  const { data, error } = await invokeProxy<T>(
    SPOTIFY_PROXY,
    action,
    params ?? {},
    accountId
  )
  if (error) throw error
  if (!data || data === null) {
    throw spotifyProxyError(action, "No response from Spotify proxy.")
  }
  if (!("ok" in data)) {
    throw spotifyProxyError(action, "Invalid Spotify proxy response.")
  }
  if (!(data as { ok: boolean }).ok) {
    throw spotifyProxyError(
      action,
      playbackErrorMessage((data as { error?: string }).error)
    )
  }
  return data
}

export function playSpotify(
  accountId?: string | null,
  uri?: string,
  deviceId?: string | null
): Promise<SpotifyPlaybackResponse> {
  return invokePlayback("play", accountId, uri, deviceId)
}

export function pauseSpotify(
  accountId?: string | null,
  deviceId?: string | null
): Promise<SpotifyPlaybackResponse> {
  return invokePlayback("pause", accountId, undefined, deviceId)
}

export async function currentPlayback(
  accountId?: string | null
): Promise<SpotifyCurrentPlaybackResponse> {
  const entry = playbackEntry(accountId)
  const now = Date.now()

  if (entry.value && now - entry.fetchedAt < CURRENT_PLAYBACK_CACHE_TTL_MS) {
    return entry.value
  }
  if (entry.inFlight) {
    return entry.inFlight
  }
  if (entry.blockedUntil > now) {
    if (entry.value) return entry.value
    throw (
      entry.lastError ??
      spotifyProxyError(
        "current playback",
        "Playback sync is cooling down after repeated Spotify errors."
      )
    )
  }

  const request = (async () => {
    const { data, error } = await invokeProxy<SpotifyCurrentPlaybackResponse>(
      SPOTIFY_PROXY,
      "current_playback",
      {},
      accountId,
      { timeoutMs: 6_000 }
    )
    if (error) throw error
    if (!data?.ok) throw spotifyProxyError("current playback", data?.error)
    return {
      ...data,
      track: data.track ?? null,
      isPlaying: Boolean(data.isPlaying),
      positionMs: typeof data.positionMs === "number" ? data.positionMs : 0,
    }
  })()

  entry.inFlight = request
  try {
    const result = await request
    entry.value = result
    entry.fetchedAt = Date.now()
    entry.failureCount = 0
    entry.blockedUntil = 0
    entry.lastError = null
    return result
  } catch (err) {
    const error =
      err instanceof Error ? err : new Error("Spotify current playback request failed.")
    notePlaybackFailure(entry, error)
    throw error
  } finally {
    entry.inFlight = null
  }
}

export function nextSpotify(
  accountId?: string | null,
  deviceId?: string | null
): Promise<SpotifyPlaybackResponse> {
  return invokePlayback("next", accountId, undefined, deviceId)
}

export function previousSpotify(
  accountId?: string | null,
  deviceId?: string | null
): Promise<SpotifyPlaybackResponse> {
  return invokePlayback("previous", accountId, undefined, deviceId)
}

export async function listSpotifyDevices(
  accountId?: string | null
): Promise<SpotifyDevicesResponse> {
  const { data, error } = await invokeProxy<SpotifyDevicesResponse>(
    SPOTIFY_PROXY,
    "devices",
    {},
    accountId,
    { timeoutMs: 6_000 }
  )
  if (error) throw error
  if (!data?.ok) throw spotifyProxyError("devices", playbackErrorMessage(data?.error))
  return data
}

export async function getSpotifyDiagnostics(
  accountId?: string | null
): Promise<SpotifyDiagnosticsResponse> {
  const { data, error } = await invokeProxy<SpotifyDiagnosticsResponse>(
    SPOTIFY_PROXY,
    "diagnostics",
    {},
    accountId
  )
  if (error) throw error
  if (!data?.ok) throw spotifyProxyError("diagnostics", data?.error)
  return data
}

export function queueSpotifyTrack(
  accountId: string | null,
  uri: string,
  deviceId?: string | null
): Promise<SpotifyQueueResponse> {
  if (!uri) throw new Error("Track URI is required to queue.")
  const params: Record<string, string> = { uri }
  if (deviceId) params.device_id = deviceId
  invalidateCurrentPlaybackCache(accountId)
  return invokeSimpleAction<SpotifyQueueResponse>("queue", accountId, params)
}

export function saveTrackToPlaylist(
  accountId: string | null,
  playlistId: string,
  uri: string
): Promise<SpotifySaveToPlaylistResponse> {
  if (!playlistId) throw new Error("Playlist is required.")
  if (!uri) throw new Error("Track URI is required.")
  return invokeSimpleAction<SpotifySaveToPlaylistResponse>(
    "save_to_playlist",
    accountId,
    { playlist_id: playlistId, uri }
  )
}

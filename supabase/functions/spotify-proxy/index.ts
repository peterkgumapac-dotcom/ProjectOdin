// Edge Function: spotify-proxy
// JWT-required. Lets ODIN browse Spotify through the caller's connected account.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import {
  getFreshSpotifyTokens,
  spotifyFetch,
  spotifyFetchJson,
} from "../_shared/spotify.ts"

const BASE = "https://api.spotify.com/v1"

interface ActionBody {
  action: string
  account_id?: string | null
  params?: Record<string, unknown>
}

interface SpotifyImage {
  url?: string
  height?: number | null
  width?: number | null
}

interface SpotifyArtist {
  name?: string
}

interface SpotifyAlbum {
  name?: string
  images?: SpotifyImage[]
}

interface SpotifyTrack {
  id?: string
  name?: string
  uri?: string
  duration_ms?: number
  external_urls?: { spotify?: string }
  artists?: SpotifyArtist[]
  album?: SpotifyAlbum
}

interface SpotifyPlaylist {
  id?: string
  name?: string
  uri?: string
  external_urls?: { spotify?: string }
  images?: SpotifyImage[]
  owner?: { display_name?: string | null }
  items?: { total?: number }
  tracks?: { total?: number }
}

interface SpotifySearchResponse {
  tracks?: { items?: SpotifyTrack[] }
  playlists?: { items?: Array<SpotifyPlaylist | null> }
}

interface SpotifyPlaylistsResponse {
  items?: Array<SpotifyPlaylist | null>
  total?: number
}

interface SpotifyPlaylistItemsResponse {
  items?: Array<{
    item?: SpotifyTrack | null
    track?: SpotifyTrack | null
  }>
  total?: number
}

interface SpotifyRecentlyPlayedResponse {
  items?: Array<{
    track?: SpotifyTrack | null
  }>
}

interface SpotifyTopTracksResponse {
  items?: SpotifyTrack[]
}

interface SpotifyDevicesResponse {
  devices?: Array<{
    id?: string | null
    is_active?: boolean
    is_restricted?: boolean
    name?: string
    type?: string
  }>
}

interface SpotifyProfileResponse {
  id?: string
  display_name?: string | null
  email?: string | null
  country?: string | null
  product?: string | null
  uri?: string | null
  external_urls?: { spotify?: string }
}

interface SpotifyCurrentPlayback {
  is_playing?: boolean
  progress_ms?: number | null
  item?: SpotifyTrack | null
}

function stringParam(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function numberParam(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function firstImage(images?: SpotifyImage[]): string | null {
  return images?.find((image) => typeof image.url === "string")?.url ?? null
}

function compactTrack(track: SpotifyTrack | null | undefined) {
  if (!track?.id || !track.name) return null
  return {
    id: track.id,
    title: track.name,
    artist: (track.artists ?? [])
      .map((artist) => artist.name)
      .filter(Boolean)
      .join(", ") || "Spotify",
    album: track.album?.name ?? "",
    url: track.external_urls?.spotify ?? "",
    uri: track.uri ?? "",
    imageUrl: firstImage(track.album?.images),
    durationMs: track.duration_ms ?? null,
  }
}

function parseCurrentPlaybackBody(value: unknown) {
  if (!value || typeof value !== "object") return { isPlaying: false, progressMs: 0, track: null }
  const candidate = value as SpotifyCurrentPlayback
  const track = compactTrack(candidate.item)
  return {
    isPlaying: Boolean(candidate.is_playing),
    progressMs: Number.isFinite(candidate.progress_ms) ? Math.max(0, candidate.progress_ms ?? 0) : 0,
    track,
  }
}

async function currentPlayback(userId: string, accountId: string | null) {
  const res = await spotifyFetch(userId, `${BASE}/me/player`, {}, accountId)

  if (res.status === 204) {
    return {
      ok: true,
      isPlaying: false,
      positionMs: 0,
      track: null,
    }
  }

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Spotify playback ${res.status}: ${text.slice(0, 500)}`)
  }

  if (!text.trim()) {
    return {
      ok: true,
      isPlaying: false,
      positionMs: 0,
      track: null,
    }
  }

  try {
    const parsed = parseCurrentPlaybackBody(JSON.parse(text))
    return {
      ok: true,
      isPlaying: parsed.isPlaying,
      positionMs: parsed.progressMs,
      track: parsed.track,
    }
  } catch {
    throw new Error(`Spotify playback parse error: could not decode /me/player response`)
  }
}

function compactPlaylist(playlist: SpotifyPlaylist | null | undefined) {
  if (!playlist?.id || !playlist.name) return null
  return {
    id: playlist.id,
    name: playlist.name,
    owner: playlist.owner?.display_name ?? "Spotify",
    url: playlist.external_urls?.spotify ?? "",
    uri: playlist.uri ?? "",
    imageUrl: firstImage(playlist.images),
    total: playlist.items?.total ?? playlist.tracks?.total ?? 0,
  }
}

async function search(
  userId: string,
  accountId: string | null,
  params: Record<string, unknown>
) {
  const q = stringParam(params.q).trim()
  if (!q) return { ok: true, tracks: [], playlists: [] }
  const limit = numberParam(params.limit, 10, 1, 20)
  const requestedMarket = stringParam(params.market).trim()
  const primaryMarket = requestedMarket || "from_token"
  const fallbackMarket = requestedMarket ? null : "US"
  const attempts: Array<{ market: string | null; normalizedQ: string }> = [
    { market: primaryMarket, normalizedQ: q },
  ]
  if (fallbackMarket) attempts.push({ market: fallbackMarket, normalizedQ: q })
  attempts.push({
    market: null,
    normalizedQ: q.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim() || q,
  })

  let lastError: Error | null = null
  let fallbackBody: SpotifySearchResponse | null = null
  for (const attempt of attempts) {
    try {
      const qs = new URLSearchParams({
        q: attempt.normalizedQ,
        type: "track,playlist",
        limit: String(limit),
      })
      if (attempt.market) qs.set("market", attempt.market)
      const body = await spotifyFetchJson<SpotifySearchResponse>(
        userId,
        `${BASE}/search?${qs.toString()}`,
        {},
        accountId
      )
      const tracks = (body.tracks?.items ?? []).map(compactTrack).filter(Boolean)
      const playlists = (body.playlists?.items ?? []).map(compactPlaylist).filter(Boolean)
      if (tracks.length > 0 || playlists.length > 0) {
        return {
          ok: true,
          tracks,
          playlists,
        }
      }
      fallbackBody = body
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/Invalid limit/i.test(message) && limit > 5) {
        const qs = new URLSearchParams({
          q: attempt.normalizedQ,
          type: "track,playlist",
          limit: "5",
        })
        if (attempt.market) qs.set("market", attempt.market)
        const body = await spotifyFetchJson<SpotifySearchResponse>(
          userId,
          `${BASE}/search?${qs.toString()}`,
          {},
          accountId
        )
        const tracks = (body.tracks?.items ?? []).map(compactTrack).filter(Boolean)
        const playlists = (body.playlists?.items ?? []).map(compactPlaylist).filter(Boolean)
        if (tracks.length > 0 || playlists.length > 0) {
          return {
            ok: true,
            tracks,
            playlists,
          }
        }
        fallbackBody = body
        continue
      }
      lastError = err instanceof Error ? err : new Error(message)
    }
  }

  if (lastError) throw lastError
  return {
    ok: true,
    tracks: (fallbackBody?.tracks?.items ?? []).map(compactTrack).filter(Boolean),
    playlists: (fallbackBody?.playlists?.items ?? []).map(compactPlaylist).filter(Boolean),
  }
}

async function listPlaylists(
  userId: string,
  accountId: string | null,
  params: Record<string, unknown>
) {
  const limit = numberParam(params.limit, 20, 1, 50)
  const offset = numberParam(params.offset, 0, 0, 100_000)
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const body = await spotifyFetchJson<SpotifyPlaylistsResponse>(
    userId,
    `${BASE}/me/playlists?${qs.toString()}`,
    {},
    accountId
  )
  return {
    ok: true,
    total: body.total ?? 0,
    playlists: (body.items ?? []).map(compactPlaylist).filter(Boolean),
  }
}

async function playlistTracks(
  userId: string,
  accountId: string | null,
  params: Record<string, unknown>
) {
  const playlistId = stringParam(params.playlist_id).trim()
  if (!playlistId) throw new Error("playlist_id is required")
  const limit = numberParam(params.limit, 20, 1, 50)
  const offset = numberParam(params.offset, 0, 0, 100_000)
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    additional_types: "track",
  })
  const body = await spotifyFetchJson<SpotifyPlaylistItemsResponse>(
    userId,
    `${BASE}/playlists/${playlistId}/items?${qs.toString()}`,
    {},
    accountId
  )
  return {
    ok: true,
    total: body.total ?? 0,
    tracks: (body.items ?? [])
      .map((item) => compactTrack(item.item ?? item.track))
      .filter(Boolean),
  }
}

async function recentTracks(
  userId: string,
  accountId: string | null,
  params: Record<string, unknown>
) {
  const limit = numberParam(params.limit, 30, 1, 50)
  const qs = new URLSearchParams({ limit: String(limit) })
  const body = await spotifyFetchJson<SpotifyRecentlyPlayedResponse>(
    userId,
    `${BASE}/me/player/recently-played?${qs.toString()}`,
    {},
    accountId
  )
  return {
    ok: true,
    tracks: (body.items ?? [])
      .map((item) => compactTrack(item.track))
      .filter(Boolean),
  }
}

async function topTracks(
  userId: string,
  accountId: string | null,
  params: Record<string, unknown>
) {
  const limit = numberParam(params.limit, 20, 1, 50)
  const requestedRange = stringParam(params.time_range, "short_term").trim()
  const timeRange =
    requestedRange === "medium_term" || requestedRange === "long_term"
      ? requestedRange
      : "short_term"
  const qs = new URLSearchParams({
    limit: String(limit),
    time_range: timeRange,
  })
  const body = await spotifyFetchJson<SpotifyTopTracksResponse>(
    userId,
    `${BASE}/me/top/tracks?${qs.toString()}`,
    {},
    accountId
  )
  return {
    ok: true,
    tracks: (body.items ?? []).map(compactTrack).filter(Boolean),
  }
}

async function playbackCommand(
  userId: string,
  accountId: string | null,
  action: string,
  params: Record<string, unknown>
) {
  const deviceId = stringParam(params.device_id).trim()
  const uri = stringParam(params.uri).trim()
  let path = "/me/player/play"
  let method = "PUT"
  let body: string | undefined

  if (action === "pause") {
    path = "/me/player/pause"
    method = "PUT"
  } else if (action === "next") {
    path = "/me/player/next"
    method = "POST"
  } else if (action === "previous") {
    path = "/me/player/previous"
    method = "POST"
  } else if (action === "play" && uri) {
    body = JSON.stringify({ uris: [uri] })
  }

  const qs = new URLSearchParams()
  if (deviceId) qs.set("device_id", deviceId)
  const target = `${BASE}${path}${qs.size ? `?${qs.toString()}` : ""}`
  const res = await spotifyFetch(
    userId,
    target,
    {
      method,
      ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
    },
    accountId
  )

  if (res.status === 204 || res.status === 202) {
    return { ok: true, status: res.status }
  }

  const text = await res.text()
  if (res.ok) return { ok: true, status: res.status }
  throw new Error(`Spotify playback ${res.status}: ${text.slice(0, 500)}`)
}

async function queueTrack(
  userId: string,
  accountId: string | null,
  params: Record<string, unknown>
) {
  const uri = stringParam(params.uri).trim()
  if (!uri) throw new Error("track uri is required")
  const deviceId = stringParam(params.device_id).trim()
  const qs = new URLSearchParams({ uri })
  if (deviceId) qs.set("device_id", deviceId)

  const target = `${BASE}/me/player/queue?${qs.toString()}`
  const res = await spotifyFetch(
    userId,
    target,
    { method: "POST" },
    accountId
  )

  const text = await res.text()
  if (res.status === 204 || res.status === 200) {
    return { ok: true, status: res.status }
  }
  throw new Error(`Spotify queue ${res.status}: ${text.slice(0, 500)}`)
}

async function saveTrackToPlaylist(
  userId: string,
  accountId: string | null,
  params: Record<string, unknown>
) {
  const playlistId = stringParam(params.playlist_id).trim()
  const uri = stringParam(params.uri).trim()
  if (!playlistId) throw new Error("playlist_id is required")
  if (!uri) throw new Error("track uri is required")

  const target = `${BASE}/playlists/${playlistId}/tracks`
  const res = await spotifyFetch(
    userId,
    target,
    {
      method: "POST",
      body: JSON.stringify({ uris: [uri] }),
      headers: { "content-type": "application/json" },
    },
    accountId
  )

  const text = await res.text()
  if (res.status === 201 || res.status === 200) {
    let snapshotId: string | null = null
    try {
      const payload = JSON.parse(text) as { snapshot_id?: string }
      snapshotId = payload.snapshot_id ?? null
    } catch {
      // Keep response parsing conservative for non-json success bodies.
    }
    return { ok: true, status: res.status, snapshotId }
  }

  throw new Error(`Spotify save_to_playlist ${res.status}: ${text.slice(0, 500)}`)
}

async function devices(userId: string, accountId: string | null) {
  const body = await spotifyFetchJson<SpotifyDevicesResponse>(
    userId,
    `${BASE}/me/player/devices`,
    {},
    accountId
  )
  return {
    ok: true,
    devices: (body.devices ?? []).map((device) => ({
      id: device.id ?? null,
      name: device.name ?? "Spotify device",
      type: device.type ?? "device",
      isActive: Boolean(device.is_active),
      isRestricted: Boolean(device.is_restricted),
    })),
  }
}

async function diagnostics(userId: string, accountId: string | null) {
  const tokens = await getFreshSpotifyTokens(userId, accountId ?? null)

  const profile = await spotifyFetchJson<SpotifyProfileResponse>(
    userId,
    `${BASE}/me`,
    {},
    accountId
  )

  const playlistProbe = await spotifyFetchJson<SpotifyPlaylistsResponse>(
    userId,
    `${BASE}/me/playlists?limit=1`,
    {},
    accountId
  )

  const probeQuery = "The Weeknd"
  const searchQs = new URLSearchParams({
    q: probeQuery,
    type: "track",
    limit: "1",
    market: profile.country ?? "from_token",
  })
  const searchProbe = await spotifyFetchJson<SpotifySearchResponse>(
    userId,
    `${BASE}/search?${searchQs.toString()}`,
    {},
    accountId
  )

  const probeTracks = searchProbe.tracks?.items?.length ?? 0
  const warnings: string[] = []
  if (probeTracks === 0) {
    warnings.push(
      `Search probe returned zero tracks for "${probeQuery}". Reconnect this Spotify account from Connections and confirm it is allowlisted in the ODIN Spotify app.`
    )
  }
  if (!tokens.scopes?.some((scope) => scope.includes("playlist-read"))) {
    warnings.push("Missing playlist read scope. Reconnect Spotify to refresh scopes.")
  }
  if (!tokens.scopes?.some((scope) => scope.includes("playlist-modify"))) {
    warnings.push("Missing playlist modify scope. Save-to-playlist actions will fail until reconnect.")
  }
  if ((profile.product ?? "").toLowerCase() !== "premium") {
    warnings.push("Spotify playback controls require Premium on the connected account.")
  }

  return {
    ok: true,
    account: {
      id: tokens.id,
      label: tokens.account_label ?? "Music",
      workspace: tokens.workspace_name ?? null,
      email: tokens.account_email ?? null,
      isPrimary: tokens.is_primary,
      expiresAt: tokens.token_expires_at ?? null,
    },
    profile: {
      id: profile.id ?? null,
      displayName: profile.display_name ?? null,
      email: profile.email ?? null,
      country: profile.country ?? null,
      product: profile.product ?? null,
      uri: profile.uri ?? null,
      profileUrl: profile.external_urls?.spotify ?? null,
    },
    scopes: tokens.scopes ?? [],
    probes: {
      searchQuery: probeQuery,
      searchTracks: probeTracks,
      playlistsTotal: playlistProbe.total ?? 0,
    },
    warnings,
  }
}

function emptyData(action: string, message: string) {
  if (action === "search") return { ok: false, error: message, tracks: [], playlists: [] }
  if (action === "list_playlists") return { ok: false, error: message, playlists: [] }
  if (action === "playlist_tracks") return { ok: false, error: message, tracks: [] }
  if (action === "recent_tracks") return { ok: false, error: message, tracks: [] }
  if (action === "top_tracks") return { ok: false, error: message, tracks: [] }
  if (action === "devices") return { ok: false, error: message, devices: [] }
  if (action === "queue") return { ok: false, error: message, status: null }
  if (action === "save_to_playlist") return { ok: false, error: message, status: null }
  if (action === "current_playback") return { ok: false, error: message, track: null, isPlaying: false, positionMs: 0 }
  if (action === "diagnostics") {
    return { ok: false, error: message, probes: { searchTracks: 0, playlistsTotal: 0 }, warnings: [] }
  }
  if (["play", "pause", "next", "previous"].includes(action)) {
    return { ok: false, error: message, status: null }
  }
  return { ok: false, error: message }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  const userId = await getCallerUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)

  let body: ActionBody
  try {
    body = (await req.json()) as ActionBody
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }

  const action = body.action
  const accountId = body.account_id ?? null
  const params = body.params ?? {}

  try {
    switch (action) {
      case "search":
        return jsonResponse({ data: await search(userId, accountId, params) })
      case "list_playlists":
        return jsonResponse({ data: await listPlaylists(userId, accountId, params) })
      case "playlist_tracks":
        return jsonResponse({ data: await playlistTracks(userId, accountId, params) })
      case "recent_tracks":
        return jsonResponse({ data: await recentTracks(userId, accountId, params) })
      case "top_tracks":
        return jsonResponse({ data: await topTracks(userId, accountId, params) })
      case "play":
      case "pause":
      case "next":
      case "previous":
        return jsonResponse({
          data: await playbackCommand(userId, accountId, action, params),
        })
      case "queue":
        return jsonResponse({ data: await queueTrack(userId, accountId, params) })
      case "current_playback":
        return jsonResponse({ data: await currentPlayback(userId, accountId) })
      case "save_to_playlist":
        return jsonResponse({ data: await saveTrackToPlaylist(userId, accountId, params) })
      case "devices":
        return jsonResponse({ data: await devices(userId, accountId) })
      case "diagnostics":
        return jsonResponse({ data: await diagnostics(userId, accountId) })
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[spotify-proxy]", message)
    return jsonResponse({ data: emptyData(action, message) })
  }
})

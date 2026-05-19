// Spotify-specific helpers: token refresh + authenticated Web API fetch.

import {
  getProviderTokens,
  isExpired,
  updateAccessTokenById,
  type ProviderTokens,
} from "./connected_accounts.ts"

const TOKEN_URL = "https://accounts.spotify.com/api/token"
const PROVIDER = "spotify"

// @ts-expect-error Deno global
const clientId = Deno.env.get("SPOTIFY_CLIENT_ID")
// @ts-expect-error Deno global
const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET")

interface RefreshResponse {
  access_token: string
  token_type?: string
  scope?: string
  expires_in: number
  refresh_token?: string
}

function basicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`)
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string
  expires_at: string
  refresh_token: string | null
}> {
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not configured")
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  })
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Spotify token refresh failed: ${text.slice(0, 500)}`)
  }
  const json = (await res.json()) as RefreshResponse
  return {
    access_token: json.access_token,
    expires_at: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    refresh_token: json.refresh_token ?? null,
  }
}

export async function getFreshSpotifyTokens(
  userId: string,
  accountId?: string | null,
  forceRefresh = false
): Promise<ProviderTokens> {
  const tokens = await getProviderTokens(userId, PROVIDER, accountId ?? null)
  if (!tokens) {
    throw new Error("Spotify account not connected for this user")
  }
  if (!forceRefresh && !isExpired(tokens)) return tokens
  if (!tokens.refresh_token) {
    throw new Error("Spotify token expired and no refresh_token is available")
  }

  const refreshed = await refreshAccessToken(tokens.refresh_token)
  await updateAccessTokenById(
    tokens.id,
    refreshed.access_token,
    refreshed.expires_at,
    refreshed.refresh_token
  )
  return {
    ...tokens,
    access_token: refreshed.access_token,
    token_expires_at: refreshed.expires_at,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
  }
}

export async function spotifyFetch(
  userId: string,
  url: string,
  init: RequestInit = {},
  accountId?: string | null
): Promise<Response> {
  const tokens = await getFreshSpotifyTokens(userId, accountId ?? null)
  const headers = new Headers(init.headers ?? {})
  headers.set("Authorization", `Bearer ${tokens.access_token}`)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return fetch(url, { ...init, headers })
}

export async function spotifyFetchJson<T>(
  userId: string,
  url: string,
  init: RequestInit = {},
  accountId?: string | null
): Promise<T> {
  const res = await spotifyFetch(userId, url, init, accountId ?? null)
  if (res.ok) return (await res.json()) as T

  const text = await res.text()
  if (res.status !== 401) {
    throw new Error(`Spotify API ${res.status}: ${text.slice(0, 500)}`)
  }

  const refreshed = await getFreshSpotifyTokens(userId, accountId ?? null, true)
  const headers = new Headers(init.headers ?? {})
  headers.set("Authorization", `Bearer ${refreshed.access_token}`)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  const retry = await fetch(url, { ...init, headers })
  if (!retry.ok) {
    const retryText = await retry.text()
    throw new Error(`Spotify API ${retry.status}: ${retryText.slice(0, 500)}`)
  }
  return (await retry.json()) as T
}

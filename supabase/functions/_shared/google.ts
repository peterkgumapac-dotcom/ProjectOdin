// Google-specific helpers: token refresh + authenticated fetch.

import {
  getProviderTokens,
  isExpired,
  updateAccessTokenById,
  type ProviderTokens,
} from "./connected_accounts.ts"

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const PROVIDER = "google"

// @ts-expect-error Deno global
const clientId = Deno.env.get("GOOGLE_CLIENT_ID")
// @ts-expect-error Deno global
const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")

interface RefreshResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string
  expires_at: string
  refresh_token: string | null
}> {
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured")
  }
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  })
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google token refresh failed: ${text}`)
  }
  const json = (await res.json()) as RefreshResponse
  return {
    access_token: json.access_token,
    expires_at: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    refresh_token: json.refresh_token ?? null,
  }
}

/**
 * Resolve fresh tokens for a specific Google account.
 *
 * - `accountId` is the connected_accounts row id (preferred).
 * - When omitted, falls back to the user's primary Google account, or the
 *   oldest one if no primary is flagged.
 */
export async function getFreshGoogleTokens(
  userId: string,
  accountId?: string | null
): Promise<ProviderTokens> {
  const tokens = await getProviderTokens(userId, PROVIDER, accountId ?? null)
  if (!tokens) {
    throw new Error("Google account not connected for this user")
  }
  if (!isExpired(tokens)) return tokens

  if (!tokens.refresh_token) {
    throw new Error(
      "Access token expired and no refresh_token available — reconnect required"
    )
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

export async function googleFetch(
  userId: string,
  url: string,
  init: RequestInit = {},
  accountId?: string | null
): Promise<Response> {
  const tokens = await getFreshGoogleTokens(userId, accountId ?? null)
  const headers = new Headers(init.headers ?? {})
  headers.set("Authorization", `Bearer ${tokens.access_token}`)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return fetch(url, { ...init, headers })
}

export async function googleFetchJson<T>(
  userId: string,
  url: string,
  init: RequestInit = {},
  accountId?: string | null
): Promise<T> {
  const res = await googleFetch(userId, url, init, accountId ?? null)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google API ${res.status}: ${text.slice(0, 500)}`)
  }
  return (await res.json()) as T
}

// Edge Function: oauth-callback-spotify
// verify_jwt = false (Spotify hits this directly).
// Exchanges code for tokens, reads the Spotify profile, then upserts
// connected_accounts keyed by (user_id, provider, account_email, workspace_id).

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { consumeAuthState } from "../_shared/oauth_state.ts"
import { upsertProviderTokens } from "../_shared/connected_accounts.ts"

const PROVIDER = "spotify"
const TOKEN_URL = "https://accounts.spotify.com/api/token"
const PROFILE_URL = "https://api.spotify.com/v1/me"

// @ts-expect-error Deno global
const clientId = Deno.env.get("SPOTIFY_CLIENT_ID")
// @ts-expect-error Deno global
const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET")
// @ts-expect-error Deno global
const redirectBase = Deno.env.get("OAUTH_REDIRECT_BASE")
// @ts-expect-error Deno global
const appBase = Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173"

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } })
}

function fail(reason: string, redirectTo: string | null): Response {
  const target = new URL(redirectTo ?? `${appBase}/music`)
  target.searchParams.set("provider", PROVIDER)
  target.searchParams.set("status", "error")
  target.searchParams.set("reason", reason)
  return redirect(target.toString())
}

function ok(redirectTo: string | null, accountId: string | null): Response {
  const target = new URL(redirectTo ?? `${appBase}/music`)
  target.searchParams.set("provider", PROVIDER)
  target.searchParams.set("status", "ok")
  if (accountId) target.searchParams.set("account", accountId)
  return redirect(target.toString())
}

interface SpotifyTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  expires_in?: number
  refresh_token?: string
  error?: string
  error_description?: string
}

interface SpotifyProfile {
  id?: string
  display_name?: string | null
  email?: string | null
  country?: string | null
  product?: string | null
  uri?: string | null
  external_urls?: {
    spotify?: string
  }
  images?: Array<{
    url?: string
    height?: number | null
    width?: number | null
  }>
}

interface SpotifyProfileFetchResult {
  profile: SpotifyProfile | null
  reason: string | null
  status: number | null
  body: string | null
}

function basicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`)
}

function profileFailureReason(status: number): string {
  if (status === 401) return "spotify_profile_unauthorized"
  if (status === 403) return "spotify_user_not_allowlisted_or_premium_required"
  if (status === 429) return "spotify_rate_limited"
  return `spotify_profile_fetch_failed_${status}`
}

async function fetchSpotifyProfile(
  accessToken: string
): Promise<SpotifyProfileFetchResult> {
  const profileRes = await fetch(PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (profileRes.ok) {
    return {
      profile: (await profileRes.json()) as SpotifyProfile,
      reason: null,
      status: profileRes.status,
      body: null,
    }
  }

  const text = await profileRes.text()
  console.error(
    "[oauth-callback-spotify] Profile error:",
    profileRes.status,
    text
  )

  return {
    profile: null,
    reason: profileFailureReason(profileRes.status),
    status: profileRes.status,
    body: text.slice(0, 500),
  }
}

serve(async (req: Request) => {
  if (!clientId || !clientSecret || !redirectBase) {
    console.error("[oauth-callback-spotify] Server not configured.")
    return fail("server_not_configured", null)
  }

  const url = new URL(req.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const errParam = url.searchParams.get("error")

  if (errParam) return fail(errParam, null)
  if (!code || !state) return fail("missing_code_or_state", null)

  const consumed = await consumeAuthState(state, PROVIDER)
  if (!consumed) return fail("invalid_or_expired_state", null)

  const callbackUri = `${redirectBase}/oauth-callback-spotify`
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUri,
  })

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  })

  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    console.error("[oauth-callback-spotify] HTTP error:", tokenRes.status, text)
    return fail("token_exchange_failed", consumed.redirect_to)
  }

  const token = (await tokenRes.json()) as SpotifyTokenResponse
  if (token.error || !token.access_token) {
    console.error("[oauth-callback-spotify] Spotify error:", token.error)
    return fail(token.error ?? "spotify_error", consumed.redirect_to)
  }

  const profileResult = await fetchSpotifyProfile(token.access_token)
  if (!profileResult.profile) {
    return fail(profileResult.reason ?? "profile_fetch_failed", consumed.redirect_to)
  }

  const profile = profileResult.profile
  const spotifyUserId = profile.id
  if (!spotifyUserId) return fail("missing_spotify_user", consumed.redirect_to)

  const scopes = token.scope?.split(/\s+/).filter(Boolean) ?? null
  const expiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : null

  try {
    const result = await upsertProviderTokens({
      user_id: consumed.user_id,
      provider: PROVIDER,
      account_email: profile.email ?? null,
      workspace_id: spotifyUserId,
      workspace_name: profile.display_name ?? profile.email ?? "Spotify",
      account_label: consumed.account_label ?? "Music",
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      token_expires_at: expiresAt,
      scopes,
      metadata: {
        spotify_user_id: spotifyUserId,
        display_name: profile.display_name ?? null,
        country: profile.country ?? null,
        product: profile.product ?? null,
        uri: profile.uri ?? null,
        profile_url: profile.external_urls?.spotify ?? null,
        image_url: profile.images?.[0]?.url ?? null,
        token_type: token.token_type ?? null,
        profile_fetch_status: profileResult.status,
      },
    })
    return ok(consumed.redirect_to, result.id)
  } catch (err) {
    console.error("[oauth-callback-spotify] Failed to persist tokens:", err)
    return fail("persistence_failed", consumed.redirect_to)
  }
})

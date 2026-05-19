// Edge Function: oauth-callback-google
// verify_jwt = false (Google hits this directly).
// Validates CSRF state, exchanges code for tokens, upserts connected_accounts
// keyed by (user_id, provider, account_email), then 302-redirects to the SPA.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { consumeAuthState } from "../_shared/oauth_state.ts"
import { upsertProviderTokens } from "../_shared/connected_accounts.ts"

const PROVIDER = "google"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

// @ts-expect-error Deno global
const clientId = Deno.env.get("GOOGLE_CLIENT_ID")
// @ts-expect-error Deno global
const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")
// @ts-expect-error Deno global
const redirectBase = Deno.env.get("OAUTH_REDIRECT_BASE")
// @ts-expect-error Deno global
const appBase = Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173"

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } })
}

function fail(reason: string, redirectTo: string | null): Response {
  const target = new URL(redirectTo ?? `${appBase}/connections`)
  target.searchParams.set("provider", PROVIDER)
  target.searchParams.set("status", "error")
  target.searchParams.set("reason", reason)
  return redirect(target.toString())
}

function ok(redirectTo: string | null, accountId: string | null): Response {
  const target = new URL(redirectTo ?? `${appBase}/connections`)
  target.searchParams.set("provider", PROVIDER)
  target.searchParams.set("status", "ok")
  if (accountId) target.searchParams.set("account", accountId)
  return redirect(target.toString())
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
  token_type: string
  id_token?: string
}

interface UserInfo {
  id: string
  email?: string
  name?: string
  picture?: string
}

serve(async (req: Request) => {
  if (!clientId || !clientSecret || !redirectBase) {
    console.error("[oauth-callback-google] Server not configured.")
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

  const callbackUri = `${redirectBase}/oauth-callback-google`

  const tokenForm = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: callbackUri,
    grant_type: "authorization_code",
  })

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm.toString(),
  })

  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    console.error("[oauth-callback-google] Token exchange failed:", text)
    return fail("token_exchange_failed", consumed.redirect_to)
  }

  const tokenJson = (await tokenRes.json()) as TokenResponse
  const expiresAt = new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
  const scopes = tokenJson.scope ? tokenJson.scope.split(" ") : []

  let providerEmail: string | null = null
  let userMetadata: Record<string, unknown> = {}

  try {
    const userRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    })
    if (userRes.ok) {
      const userInfo = (await userRes.json()) as UserInfo
      providerEmail = userInfo.email ?? null
      userMetadata = {
        google_user_id: userInfo.id,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
      }
    } else {
      console.warn(
        "[oauth-callback-google] userinfo returned",
        userRes.status,
        await userRes.text()
      )
    }
  } catch (err) {
    console.warn("[oauth-callback-google] userinfo fetch failed:", err)
  }

  if (!providerEmail) {
    return fail("userinfo_missing_email", consumed.redirect_to)
  }

  try {
    const result = await upsertProviderTokens({
      user_id: consumed.user_id,
      provider: PROVIDER,
      account_email: providerEmail,
      account_label: consumed.account_label ?? "Account",
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token ?? null,
      token_expires_at: expiresAt,
      scopes,
      metadata: userMetadata,
    })
    return ok(consumed.redirect_to, result.id)
  } catch (err) {
    console.error("[oauth-callback-google] Failed to persist tokens:", err)
    return fail("persistence_failed", consumed.redirect_to)
  }
})

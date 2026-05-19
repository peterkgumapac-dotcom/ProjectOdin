// Edge Function: oauth-callback-slack
// verify_jwt = false (Slack hits this directly).
// Exchanges code for tokens via oauth.v2.access, then upserts connected_accounts
// keyed by (user_id, provider, workspace_id).

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { consumeAuthState } from "../_shared/oauth_state.ts"
import { upsertProviderTokens } from "../_shared/connected_accounts.ts"

const PROVIDER = "slack"
const TOKEN_URL = "https://slack.com/api/oauth.v2.access"

// @ts-expect-error Deno global
const clientId = Deno.env.get("SLACK_CLIENT_ID")
// @ts-expect-error Deno global
const clientSecret = Deno.env.get("SLACK_CLIENT_SECRET")
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

interface SlackOAuthResponse {
  ok: boolean
  error?: string
  app_id?: string
  team?: { id: string; name: string }
  authed_user?: {
    id: string
    scope?: string
    access_token?: string
    token_type?: string
  }
  scope?: string
  bot_user_id?: string
  access_token?: string // bot token (we use user token instead)
}

serve(async (req: Request) => {
  if (!clientId || !clientSecret || !redirectBase) {
    console.error("[oauth-callback-slack] Server not configured.")
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

  const callbackUri = `${redirectBase}/oauth-callback-slack`

  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: callbackUri,
  })

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })

  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    console.error("[oauth-callback-slack] HTTP error:", tokenRes.status, text)
    return fail("token_exchange_failed", consumed.redirect_to)
  }

  const json = (await tokenRes.json()) as SlackOAuthResponse
  if (!json.ok) {
    console.error("[oauth-callback-slack] Slack error:", json.error)
    return fail(json.error ?? "slack_error", consumed.redirect_to)
  }

  const userToken = json.authed_user?.access_token
  if (!userToken) {
    console.error("[oauth-callback-slack] No authed_user.access_token in response.")
    return fail("no_user_token", consumed.redirect_to)
  }

  const team = json.team
  if (!team) {
    return fail("no_team_in_response", consumed.redirect_to)
  }

  const userScopes = json.authed_user?.scope
    ? json.authed_user.scope.split(",")
    : []

  try {
    const result = await upsertProviderTokens({
      user_id: consumed.user_id,
      provider: PROVIDER,
      workspace_id: team.id,
      workspace_name: team.name,
      account_label: consumed.account_label ?? team.name,
      access_token: userToken,
      refresh_token: null,
      token_expires_at: null, // Slack user tokens do not expire by default
      scopes: userScopes,
      metadata: {
        slack_user_id: json.authed_user?.id,
        bot_user_id: json.bot_user_id ?? null,
        app_id: json.app_id ?? null,
      },
    })
    return ok(consumed.redirect_to, result.id)
  } catch (err) {
    console.error("[oauth-callback-slack] Failed to persist tokens:", err)
    return fail("persistence_failed", consumed.redirect_to)
  }
})

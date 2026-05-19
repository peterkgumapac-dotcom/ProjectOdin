// Edge Function: oauth-callback-withings
// verify_jwt = false. Exchanges Withings authorization code for tokens.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { consumeAuthState } from "../_shared/oauth_state.ts"
import { upsertProviderTokens } from "../_shared/connected_accounts.ts"
import { exchangeWithingsCode } from "../_shared/withings.ts"

const PROVIDER = "withings"

// @ts-expect-error Deno global
const redirectBase = Deno.env.get("OAUTH_REDIRECT_BASE")
// @ts-expect-error Deno global
const appBase = Deno.env.get("APP_BASE_URL") ?? "http://localhost:5175"

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } })
}

function fail(reason: string, redirectTo: string | null): Response {
  const target = new URL(redirectTo ?? `${appBase}/dashboard`)
  target.searchParams.set("provider", PROVIDER)
  target.searchParams.set("status", "error")
  target.searchParams.set("reason", reason)
  return redirect(target.toString())
}

function ok(redirectTo: string | null, accountId: string | null): Response {
  const target = new URL(redirectTo ?? `${appBase}/dashboard`)
  target.searchParams.set("provider", PROVIDER)
  target.searchParams.set("status", "ok")
  if (accountId) target.searchParams.set("account", accountId)
  return redirect(target.toString())
}

serve(async (req: Request) => {
  if (!redirectBase) {
    console.error("[oauth-callback-withings] OAUTH_REDIRECT_BASE not set.")
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

  const callbackUri = `${redirectBase}/oauth-callback-withings`

  try {
    const token = await exchangeWithingsCode(code, callbackUri)
    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString()
    const scopes = token.scope
      ? token.scope.split(",").map((scope) => scope.trim()).filter(Boolean)
      : null
    const withingsUserId = String(token.userid)
    const result = await upsertProviderTokens({
      user_id: consumed.user_id,
      provider: PROVIDER,
      workspace_id: withingsUserId,
      workspace_name: "Withings",
      account_label: consumed.account_label ?? "Withings",
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_expires_at: expiresAt,
      scopes,
      metadata: {
        withings_user_id: withingsUserId,
        token_type: token.token_type ?? "Bearer",
      },
    })
    return ok(consumed.redirect_to, result.id)
  } catch (err) {
    console.error("[oauth-callback-withings]", err)
    return fail("token_exchange_failed", consumed.redirect_to)
  }
})

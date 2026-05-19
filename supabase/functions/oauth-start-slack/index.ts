// Edge Function: oauth-start-slack
// JWT-required. Returns the Slack OAuth v2 authorize URL with CSRF state.
//
// Body:
//   { redirect_to?: string, label?: string }

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { CORS_HEADERS, corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { createAuthState } from "../_shared/oauth_state.ts"

const PROVIDER = "slack"
const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"

// User Token Scopes — let the user read their own DMs, mentions, and channels.
const USER_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "team:read",
  "search:read",
].join(",")

// @ts-expect-error Deno global
const clientId = Deno.env.get("SLACK_CLIENT_ID")
// @ts-expect-error Deno global
const redirectBase = Deno.env.get("OAUTH_REDIRECT_BASE")

if (!clientId) {
  console.error("[oauth-start-slack] SLACK_CLIENT_ID not set.")
}
if (!redirectBase) {
  console.error("[oauth-start-slack] OAUTH_REDIRECT_BASE not set.")
}

interface StartBody {
  redirect_to?: string
  label?: string
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }
  if (!clientId || !redirectBase) {
    return jsonResponse({ error: "Server not configured" }, 500)
  }

  const userId = await getCallerUserId(req)
  if (!userId) {
    return jsonResponse({ error: "Unauthorized" }, 401)
  }

  const body = await req.json().catch(() => ({})) as StartBody

  const redirectTo = body.redirect_to ?? null
  const label = (body.label ?? "Workspace").slice(0, 60)

  const state = await createAuthState(userId, PROVIDER, redirectTo, label)
  const callbackUri = `${redirectBase}/oauth-callback-slack`

  const params = new URLSearchParams({
    client_id: clientId,
    user_scope: USER_SCOPES,
    redirect_uri: callbackUri,
    state,
  })

  const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`
  return new Response(JSON.stringify({ data: { url: authorizeUrl, state } }), {
    status: 200,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  })
})

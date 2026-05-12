// Edge Function: oauth-start-google
// JWT-required. Returns the Google authorize URL with CSRF state stored in auth_state.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { CORS_HEADERS, corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { createAuthState } from "../_shared/oauth_state.ts"

const PROVIDER = "google"
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"

// User has granted these scopes in the Google Cloud consent screen.
// Adding more here without expanding the consent screen will fail with invalid_scope.
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
]

// @ts-expect-error Deno global
const clientId = Deno.env.get("GOOGLE_CLIENT_ID")
// @ts-expect-error Deno global
const redirectBase = Deno.env.get("OAUTH_REDIRECT_BASE")

if (!clientId) {
  console.error("[oauth-start-google] GOOGLE_CLIENT_ID not set.")
}
if (!redirectBase) {
  console.error("[oauth-start-google] OAUTH_REDIRECT_BASE not set.")
}

interface StartBody {
  redirect_to?: string
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

  let body: StartBody = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const redirectTo = body.redirect_to ?? null

  const state = await createAuthState(userId, PROVIDER, redirectTo)
  const callbackUri = `${redirectBase}/oauth-callback-google`

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  })

  const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`
  return new Response(JSON.stringify({ data: { url: authorizeUrl, state } }), {
    status: 200,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  })
})

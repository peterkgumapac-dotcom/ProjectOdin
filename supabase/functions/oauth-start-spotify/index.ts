// Edge Function: oauth-start-spotify
// JWT-required. Returns the Spotify authorize URL with CSRF state.
//
// Body:
//   { redirect_to?: string, label?: string }

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { CORS_HEADERS, corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { createAuthState } from "../_shared/oauth_state.ts"

const PROVIDER = "spotify"
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize"

const SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ")

// @ts-expect-error Deno global
const clientId = Deno.env.get("SPOTIFY_CLIENT_ID")
// @ts-expect-error Deno global
const redirectBase = Deno.env.get("OAUTH_REDIRECT_BASE")

if (!clientId) {
  console.error("[oauth-start-spotify] SPOTIFY_CLIENT_ID not set.")
}
if (!redirectBase) {
  console.error("[oauth-start-spotify] OAUTH_REDIRECT_BASE not set.")
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
  const label = (body.label ?? "Music").slice(0, 60)

  const state = await createAuthState(userId, PROVIDER, redirectTo, label)
  const callbackUri = `${redirectBase}/oauth-callback-spotify`

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: callbackUri,
    scope: SCOPES,
    state,
    show_dialog: "true",
  })

  const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`
  return new Response(JSON.stringify({ data: { url: authorizeUrl, state } }), {
    status: 200,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  })
})

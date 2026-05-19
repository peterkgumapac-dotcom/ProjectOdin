// Edge Function: oauth-start-withings
// JWT-required. Returns the Withings OAuth authorization URL with CSRF state.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { CORS_HEADERS, corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { createAuthState } from "../_shared/oauth_state.ts"

const PROVIDER = "withings"
const AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2"
const SCOPES = ["user.activity", "user.metrics"].join(",")

// @ts-expect-error Deno global
const clientId = Deno.env.get("WITHINGS_CLIENT_ID")
// @ts-expect-error Deno global
const redirectBase = Deno.env.get("OAUTH_REDIRECT_BASE")

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
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)

  const body = await req.json().catch(() => ({})) as StartBody

  const redirectTo = body.redirect_to ?? null
  const label = (body.label ?? "Withings").slice(0, 60)
  const state = await createAuthState(userId, PROVIDER, redirectTo, label)
  const callbackUri = `${redirectBase}/oauth-callback-withings`

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: callbackUri,
    state,
  })

  return new Response(
    JSON.stringify({
      data: { url: `${AUTHORIZE_URL}?${params.toString()}`, state },
    }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    }
  )
})

// Service-role Supabase client for edge functions.
// NEVER expose SUPABASE_SERVICE_ROLE_KEY to the browser.

// @ts-expect-error npm specifier resolves in Deno deploy.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@^2"

// @ts-expect-error Deno global
const url = Deno.env.get("SUPABASE_URL")
// @ts-expect-error Deno global
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")

if (!url || !serviceKey) {
  console.error(
    "[supabase_admin] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from edge function env."
  )
}

let cached: SupabaseClient | null = null

export function getAdminClient(): SupabaseClient {
  if (!cached) {
    cached = createClient(url ?? "", serviceKey ?? "", {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return cached
}

// Verifies the caller's JWT and returns the user_id. Returns null on invalid.
export async function getCallerUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? ""
  const token = auth.replace(/^Bearer\s+/i, "").trim()
  if (!token) return null
  const admin = getAdminClient()
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

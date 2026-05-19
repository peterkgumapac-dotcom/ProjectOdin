import { supabase } from "@/lib/supabaseClient"
import { odinRouteUrl } from "@/lib/desktopRoute"

export const GOOGLE_PROVIDER = "google"

interface OAuthStartResponse {
  data?: { url: string; state: string }
  error?: string
}

export interface StartGoogleOptions {
  label?: string
  mode?: "connect" | "add"
  redirectTo?: string
}

export async function startGoogleConnect(
  opts: StartGoogleOptions = {}
): Promise<string> {
  const body: Record<string, unknown> = {}
  if (opts.redirectTo) body.redirect_to = opts.redirectTo
  if (opts.label) body.label = opts.label
  if (opts.mode) body.mode = opts.mode

  const { data, error } = await supabase.functions.invoke<OAuthStartResponse>(
    "oauth-start-google",
    { body }
  )
  if (error) throw new Error(error.message)
  if (data?.error) throw new Error(data.error)
  if (!data?.data?.url) {
    throw new Error("oauth-start-google returned no URL")
  }
  return data.data.url
}

export async function connectGoogle(opts: StartGoogleOptions = {}): Promise<void> {
  const here = odinRouteUrl("/connections")
  const url = await startGoogleConnect({
    redirectTo: here,
    ...opts,
  })
  window.location.assign(url)
}

/**
 * Disconnect a specific Google account by row id. Falls back to deleting all
 * Google rows when no id is provided (kept for legacy callers).
 */
export async function disconnectGoogle(
  userId: string,
  accountId?: string
): Promise<void> {
  let query = supabase.from("connected_accounts").delete().eq("user_id", userId)
  if (accountId) {
    query = query.eq("id", accountId)
  } else {
    query = query.eq("provider", GOOGLE_PROVIDER)
  }
  const { error } = await query
  if (error) throw new Error(error.message)
}

import { supabase } from "@/lib/supabaseClient"

export const GOOGLE_PROVIDER = "google"

interface OAuthStartResponse {
  data?: { url: string; state: string }
  error?: string
}

export async function startGoogleConnect(redirectTo?: string): Promise<string> {
  const body = redirectTo ? { redirect_to: redirectTo } : {}
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

export async function connectGoogle(): Promise<void> {
  const here = `${window.location.origin}/connections`
  const url = await startGoogleConnect(here)
  window.location.assign(url)
}

export async function disconnectGoogle(userId: string): Promise<void> {
  const { error } = await supabase
    .from("connected_accounts")
    .delete()
    .eq("user_id", userId)
    .eq("provider", GOOGLE_PROVIDER)
  if (error) throw new Error(error.message)
}

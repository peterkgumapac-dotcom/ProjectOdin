import { getAdminClient } from "./supabase_admin.ts"

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

function randomState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export async function createAuthState(
  userId: string,
  provider: string,
  redirectTo: string | null
): Promise<string> {
  const state = randomState()
  const admin = getAdminClient()
  const { error } = await admin.from("auth_state").insert({
    state,
    user_id: userId,
    provider,
    redirect_to: redirectTo,
  })
  if (error) throw new Error(`Failed to persist auth_state: ${error.message}`)
  return state
}

export interface ConsumedState {
  user_id: string
  provider: string
  redirect_to: string | null
}

export async function consumeAuthState(
  state: string,
  provider: string
): Promise<ConsumedState | null> {
  const admin = getAdminClient()
  const { data, error } = await admin
    .from("auth_state")
    .select("user_id, provider, redirect_to, created_at")
    .eq("state", state)
    .eq("provider", provider)
    .maybeSingle()

  if (error || !data) return null

  const createdAtMs = new Date(data.created_at).getTime()
  if (Date.now() - createdAtMs > STATE_TTL_MS) {
    await admin.from("auth_state").delete().eq("state", state)
    return null
  }

  // Best-effort cleanup of the consumed row + any stale state.
  await admin
    .from("auth_state")
    .delete()
    .or(
      `state.eq.${state},created_at.lt.${new Date(
        Date.now() - STATE_TTL_MS
      ).toISOString()}`
    )

  return {
    user_id: data.user_id,
    provider: data.provider,
    redirect_to: data.redirect_to,
  }
}

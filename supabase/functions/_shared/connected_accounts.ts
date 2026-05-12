import { getAdminClient } from "./supabase_admin.ts"

export interface ProviderTokens {
  access_token: string
  refresh_token: string | null
  token_expires_at: string | null
  scopes: string[] | null
  metadata: Record<string, unknown>
}

export async function getProviderTokens(
  userId: string,
  provider: string
): Promise<ProviderTokens | null> {
  const admin = getAdminClient()
  const { data, error } = await admin
    .from("connected_accounts")
    .select("access_token, refresh_token, token_expires_at, scopes, metadata")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle()
  if (error || !data || !data.access_token) return null
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expires_at: data.token_expires_at,
    scopes: data.scopes,
    metadata: (data.metadata as Record<string, unknown>) ?? {},
  }
}

export interface UpsertParams {
  user_id: string
  provider: string
  provider_account_id?: string | null
  access_token: string
  refresh_token?: string | null
  token_expires_at?: string | null
  scopes?: string[] | null
  metadata?: Record<string, unknown>
}

export async function upsertProviderTokens(params: UpsertParams): Promise<void> {
  const admin = getAdminClient()
  const { error } = await admin
    .from("connected_accounts")
    .upsert(
      {
        user_id: params.user_id,
        provider: params.provider,
        provider_account_id: params.provider_account_id ?? null,
        access_token: params.access_token,
        refresh_token: params.refresh_token ?? null,
        token_expires_at: params.token_expires_at ?? null,
        scopes: params.scopes ?? null,
        metadata: params.metadata ?? {},
      },
      { onConflict: "user_id,provider" }
    )
  if (error) {
    throw new Error(`Failed to upsert connected_account: ${error.message}`)
  }
}

export async function updateAccessToken(
  userId: string,
  provider: string,
  accessToken: string,
  expiresAt: string,
  refreshToken?: string | null
): Promise<void> {
  const admin = getAdminClient()
  const update: Record<string, unknown> = {
    access_token: accessToken,
    token_expires_at: expiresAt,
  }
  if (refreshToken) update.refresh_token = refreshToken
  const { error } = await admin
    .from("connected_accounts")
    .update(update)
    .eq("user_id", userId)
    .eq("provider", provider)
  if (error) {
    throw new Error(`Failed to update token: ${error.message}`)
  }
}

export function isExpired(tokens: ProviderTokens): boolean {
  if (!tokens.token_expires_at) return false
  const expMs = new Date(tokens.token_expires_at).getTime()
  // Refresh 60s before expiry to avoid mid-flight 401s.
  return Date.now() + 60_000 >= expMs
}

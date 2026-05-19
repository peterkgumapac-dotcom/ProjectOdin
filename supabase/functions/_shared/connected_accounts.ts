import { getAdminClient } from "./supabase_admin.ts"

export interface ProviderTokens {
  id: string
  provider: string
  account_email: string | null
  workspace_id: string | null
  workspace_name: string | null
  account_label: string | null
  access_token: string
  refresh_token: string | null
  token_expires_at: string | null
  scopes: string[] | null
  metadata: Record<string, unknown>
  is_primary: boolean
}

export interface AccountSummary {
  id: string
  provider: string
  account_email: string | null
  workspace_id: string | null
  workspace_name: string | null
  account_label: string | null
  is_primary: boolean
  scopes: string[] | null
  token_expires_at: string | null
  metadata: Record<string, unknown>
}

const SELECT_COLS =
  "id, provider, account_email, workspace_id, workspace_name, account_label, access_token, refresh_token, token_expires_at, scopes, metadata, is_primary"

const SUMMARY_COLS =
  "id, provider, account_email, workspace_id, workspace_name, account_label, is_primary, scopes, token_expires_at, metadata"

function rowToTokens(row: Record<string, unknown>): ProviderTokens {
  return {
    id: row.id as string,
    provider: row.provider as string,
    account_email: (row.account_email as string | null) ?? null,
    workspace_id: (row.workspace_id as string | null) ?? null,
    workspace_name: (row.workspace_name as string | null) ?? null,
    account_label: (row.account_label as string | null) ?? null,
    access_token: row.access_token as string,
    refresh_token: (row.refresh_token as string | null) ?? null,
    token_expires_at: (row.token_expires_at as string | null) ?? null,
    scopes: (row.scopes as string[] | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    is_primary: Boolean(row.is_primary),
  }
}

export async function listProviderAccounts(
  userId: string,
  provider: string
): Promise<AccountSummary[]> {
  const admin = getAdminClient()
  const { data, error } = await admin
    .from("connected_accounts")
    .select(SUMMARY_COLS)
    .eq("user_id", userId)
    .eq("provider", provider)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
  if (error) throw new Error(`Failed to list accounts: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    account_email: row.account_email ?? null,
    workspace_id: row.workspace_id ?? null,
    workspace_name: row.workspace_name ?? null,
    account_label: row.account_label ?? null,
    is_primary: Boolean(row.is_primary),
    scopes: row.scopes,
    token_expires_at: row.token_expires_at,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  }))
}

/**
 * Resolve a specific account's tokens.
 *
 * Resolution order when `accountId` is omitted:
 *   1. The user's primary account for the provider, if any.
 *   2. Otherwise the oldest row.
 */
export async function getProviderTokens(
  userId: string,
  provider: string,
  accountId?: string | null
): Promise<ProviderTokens | null> {
  const admin = getAdminClient()

  if (accountId) {
    const { data, error } = await admin
      .from("connected_accounts")
      .select(SELECT_COLS)
      .eq("id", accountId)
      .eq("user_id", userId)
      .eq("provider", provider)
      .maybeSingle()
    if (error || !data || !data.access_token) return null
    return rowToTokens(data)
  }

  const { data, error } = await admin
    .from("connected_accounts")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .eq("provider", provider)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error || !data || !data.access_token) return null
  return rowToTokens(data)
}

export interface UpsertParams {
  user_id: string
  provider: string
  account_email?: string | null
  workspace_id?: string | null
  workspace_name?: string | null
  account_label?: string | null
  access_token: string
  refresh_token?: string | null
  token_expires_at?: string | null
  scopes?: string[] | null
  metadata?: Record<string, unknown>
}

/**
 * Upsert keyed by (user_id, provider, account_email, workspace_id) with
 * NULLS NOT DISTINCT. Reconnecting the same Gmail/workspace refreshes the row;
 * a different one creates a new row.
 *
 * Returns the row id for downstream consumers (callbacks that need to redirect
 * with ?account=...).
 */
export async function upsertProviderTokens(
  params: UpsertParams
): Promise<{ id: string }> {
  const admin = getAdminClient()
  const { data, error } = await admin
    .from("connected_accounts")
    .upsert(
      {
        user_id: params.user_id,
        provider: params.provider,
        account_email: params.account_email ?? null,
        workspace_id: params.workspace_id ?? null,
        workspace_name: params.workspace_name ?? null,
        account_label: params.account_label ?? null,
        access_token: params.access_token,
        refresh_token: params.refresh_token ?? null,
        token_expires_at: params.token_expires_at ?? null,
        scopes: params.scopes ?? null,
        metadata: params.metadata ?? {},
      },
      { onConflict: "user_id,provider,account_email,workspace_id" }
    )
    .select("id")
    .single()
  if (error || !data) {
    throw new Error(`Failed to upsert connected_account: ${error?.message}`)
  }
  return { id: data.id as string }
}

export async function updateAccessTokenById(
  accountId: string,
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
    .eq("id", accountId)
  if (error) throw new Error(`Failed to update token: ${error.message}`)
}

export function isExpired(tokens: ProviderTokens): boolean {
  if (!tokens.token_expires_at) return false
  const expMs = new Date(tokens.token_expires_at).getTime()
  // Refresh 60s before expiry to avoid mid-flight 401s.
  return Date.now() + 60_000 >= expMs
}

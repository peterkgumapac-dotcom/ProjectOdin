// Slack-specific helpers. Tokens never expire automatically (no rotation by
// default), so we just look up the access_token by accountId or workspace.

import {
  getProviderTokens,
  type ProviderTokens,
} from "./connected_accounts.ts"

const PROVIDER = "slack"

/**
 * Resolve tokens for a specific Slack workspace.
 *
 * `accountId` is the connected_accounts row id. When omitted the helper picks
 * the user's primary Slack workspace, falling back to the oldest one.
 */
export async function getSlackTokens(
  userId: string,
  accountId?: string | null
): Promise<ProviderTokens> {
  const tokens = await getProviderTokens(userId, PROVIDER, accountId ?? null)
  if (!tokens) {
    throw new Error("Slack workspace not connected for this user")
  }
  return tokens
}

/**
 * Authenticated fetch against the Slack Web API. Slack returns JSON with an
 * `ok` discriminator and an `error` string when something fails; we propagate
 * those upward as exceptions so callers can `try/catch` them like Google calls.
 */
export async function slackFetchJson<T extends { ok: boolean; error?: string }>(
  userId: string,
  url: string,
  init: RequestInit = {},
  accountId?: string | null
): Promise<T> {
  const tokens = await getSlackTokens(userId, accountId ?? null)
  const headers = new Headers(init.headers ?? {})
  headers.set("Authorization", `Bearer ${tokens.access_token}`)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8")
  }
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Slack API ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = (await res.json()) as T
  if (!json.ok) {
    throw new Error(`Slack API error: ${json.error ?? "unknown"}`)
  }
  return json
}

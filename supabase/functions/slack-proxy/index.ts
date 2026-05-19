// Edge Function: slack-proxy
// JWT-required. Routes Slack Web API calls on behalf of the caller, scoped to
// a single connected workspace identified by `account_id`.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { slackFetchJson } from "../_shared/slack.ts"

const BASE = "https://slack.com/api"

interface ActionBody {
  action: string
  account_id?: string | null
  params?: Record<string, unknown>
}

interface ConversationsListResponse {
  ok: boolean
  error?: string
  channels?: Array<{
    id: string
    name: string
    is_channel: boolean
    is_private: boolean
    is_member?: boolean
    num_members?: number
    topic?: { value?: string }
  }>
  response_metadata?: { next_cursor?: string }
}

interface ConversationsHistoryResponse {
  ok: boolean
  error?: string
  messages?: Array<{
    user?: string
    text?: string
    ts: string
    thread_ts?: string
    reactions?: Array<{ name: string; count: number }>
  }>
  has_more?: boolean
  response_metadata?: { next_cursor?: string }
}

interface AuthTestResponse {
  ok: boolean
  error?: string
  user?: string
  team?: string
  user_id?: string
  team_id?: string
  url?: string
}

interface UnreadChannelsResponse {
  ok: boolean
  error?: string
  channels: Array<{
    id: string
    name: string
    is_member?: boolean
    unread_count: number
    last_read?: string
  }>
}

interface ChannelMessagesBatchResponse {
  ok: boolean
  channels: Array<{
    channel_id: string
    ok: boolean
    message: {
      user?: string
      text?: string
      ts: string
      thread_ts?: string
    } | null
    error?: string
  }>
}

interface UsersInfoBatchResponse {
  ok: boolean
  users: Array<{
    id: string
    display_name: string
    real_name?: string
  }>
}

function errorDataForAction(action: string, message: string) {
  switch (action) {
    case "list_channels":
      return { ok: false, error: message, channels: [] }
    case "channel_history":
    case "get_channel_history":
    case "list_messages":
      return { ok: false, error: message, messages: [] }
    case "auth_test":
      return { ok: false, error: message }
    case "unread_counts":
      return { ok: false, error: message, channels: [] }
    case "channel_messages_batch":
      return { ok: false, error: message, channels: [] }
    case "users_info":
      return { ok: false, error: message, users: [] }
    default:
      return { ok: false, error: message }
  }
}

async function fetchAllConversations(
  userId: string,
  accountId: string | null,
  params: Record<string, string>,
  maxPages = 10
) {
  const channels: NonNullable<ConversationsListResponse["channels"]> = []
  let cursor = ""

  for (let page = 0; page < maxPages; page += 1) {
    const qs = new URLSearchParams(params)
    if (cursor) qs.set("cursor", cursor)
    const resp = await slackFetchJson<ConversationsListResponse>(
      userId,
      `${BASE}/conversations.list?${qs.toString()}`,
      {},
      accountId
    )
    if (!resp.ok) return { ...resp, channels }
    channels.push(...(resp.channels ?? []))
    cursor = resp.response_metadata?.next_cursor ?? ""
    if (!cursor) break
  }

  return { ok: true, channels }
}

async function listChannels(
  userId: string,
  accountId: string | null,
  params: { include_all?: unknown } = {}
) {
  const includeAll = params.include_all === true
  const qs = new URLSearchParams({
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: "1000",
  })
  const resp = await fetchAllConversations(
    userId,
    accountId,
    Object.fromEntries(qs.entries())
  )
  const raw = resp.channels ?? []
  return {
    ...resp,
    channels: raw
      .filter((c) => includeAll || c.is_member !== false)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  }
}

async function unreadCounts(
  userId: string,
  accountId: string | null
): Promise<UnreadChannelsResponse> {
  const qs = new URLSearchParams({
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: "1000",
  })
  const resp = await fetchAllConversations(
    userId,
    accountId,
    Object.fromEntries(qs.entries())
  )
  const raw = resp.channels ?? []
  const filtered = raw
    .filter((c) => c.is_member !== false)
    .map((c) => {
      const cAny = c as unknown as Record<string, unknown>
      return {
        id: c.id,
        name: c.name,
        is_member: c.is_member,
        unread_count:
          typeof cAny.unread_count === "number" ? (cAny.unread_count as number) : 0,
        last_read:
          typeof cAny.last_read === "string" ? (cAny.last_read as string) : undefined,
      }
    })
    .sort((a, b) => b.unread_count - a.unread_count)
  return { ok: resp.ok, error: resp.error, channels: filtered }
}

async function channelMessagesBatch(
  userId: string,
  accountId: string | null,
  params: { channel_ids?: unknown; limit?: unknown }
): Promise<ChannelMessagesBatchResponse> {
  const ids = Array.isArray(params.channel_ids)
    ? (params.channel_ids as unknown[]).filter(
        (v): v is string => typeof v === "string"
      )
    : []
  if (ids.length === 0) {
    return { ok: true, channels: [] }
  }
  const limit = typeof params.limit === "number" ? params.limit : 1
  const settled = await Promise.allSettled(
    ids.map(async (channel) => {
      const qs = new URLSearchParams({ channel, limit: String(limit) })
      const hist = await slackFetchJson<ConversationsHistoryResponse>(
        userId,
        `${BASE}/conversations.history?${qs.toString()}`,
        {},
        accountId
      )
      return {
        channel_id: channel,
        ok: hist.ok,
        message: hist.messages?.[0] ?? null,
        error: hist.error,
      }
    })
  )
  return {
    ok: true,
    channels: settled.map((res, i) =>
      res.status === "fulfilled"
        ? res.value
        : {
            channel_id: ids[i],
            ok: false,
            message: null,
            error: res.reason instanceof Error ? res.reason.message : "Unknown",
          }
    ),
  }
}

interface UsersInfoResponse {
  ok: boolean
  error?: string
  user?: {
    id: string
    real_name?: string
    profile?: {
      display_name?: string
      real_name?: string
    }
  }
}

async function usersInfoBatch(
  userId: string,
  accountId: string | null,
  params: { user_ids?: unknown }
): Promise<UsersInfoBatchResponse> {
  const ids = Array.isArray(params.user_ids)
    ? (params.user_ids as unknown[]).filter(
        (v): v is string => typeof v === "string"
      )
    : []
  if (ids.length === 0) return { ok: true, users: [] }
  const settled = await Promise.allSettled(
    ids.map(async (uid) => {
      const qs = new URLSearchParams({ user: uid })
      const resp = await slackFetchJson<UsersInfoResponse>(
        userId,
        `${BASE}/users.info?${qs.toString()}`,
        {},
        accountId
      )
      const display =
        resp.user?.profile?.display_name?.trim() ||
        resp.user?.profile?.real_name?.trim() ||
        resp.user?.real_name?.trim() ||
        uid
      return {
        id: uid,
        display_name: display,
        real_name: resp.user?.real_name,
      }
    })
  )
  return {
    ok: true,
    users: settled.map((res, i) =>
      res.status === "fulfilled"
        ? res.value
        : { id: ids[i], display_name: ids[i] }
    ),
  }
}

async function channelHistory(
  userId: string,
  accountId: string | null,
  params: { channel: string; limit?: number }
) {
  if (!params.channel) throw new Error("channel is required")
  const qs = new URLSearchParams({
    channel: params.channel,
    limit: String(params.limit ?? 20),
  })
  return slackFetchJson<ConversationsHistoryResponse>(
    userId,
    `${BASE}/conversations.history?${qs.toString()}`,
    {},
    accountId
  )
}

async function authTest(userId: string, accountId: string | null) {
  return slackFetchJson<AuthTestResponse>(
    userId,
    `${BASE}/auth.test`,
    { method: "POST" },
    accountId
  )
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const userId = await getCallerUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)

  let body: ActionBody
  try {
    body = (await req.json()) as ActionBody
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }

  const action = body.action
  const accountId = body.account_id ?? null
  const params = body.params ?? {}

  try {
    switch (action) {
      case "list_channels":
        return jsonResponse({
          data: await listChannels(
            userId,
            accountId,
            params as { include_all?: unknown }
          ),
        })
      case "channel_history":
      case "get_channel_history":
      case "list_messages":
        return jsonResponse({
          data: await channelHistory(
            userId,
            accountId,
            params as { channel: string; limit?: number }
          ),
        })
      case "auth_test":
        return jsonResponse({ data: await authTest(userId, accountId) })
      case "unread_counts":
        return jsonResponse({ data: await unreadCounts(userId, accountId) })
      case "channel_messages_batch":
        return jsonResponse({
          data: await channelMessagesBatch(
            userId,
            accountId,
            params as { channel_ids?: unknown; limit?: unknown }
          ),
        })
      case "users_info":
        return jsonResponse({
          data: await usersInfoBatch(
            userId,
            accountId,
            params as { user_ids?: unknown }
          ),
        })
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[slack-proxy]", message)
    return jsonResponse({ data: errorDataForAction(action, message) })
  }
})

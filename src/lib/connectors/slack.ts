import { supabase } from "@/lib/supabaseClient"
import { odinRouteUrl } from "@/lib/desktopRoute"
import { invokeProxy } from "@/lib/connectors/proxy"

export const SLACK_PROVIDER = "slack"

interface OAuthStartResponse {
  data?: { url: string; state: string }
  error?: string
}

export interface StartSlackOptions {
  label?: string
  redirectTo?: string
}

export async function startSlackConnect(
  opts: StartSlackOptions = {}
): Promise<string> {
  const body: Record<string, unknown> = {}
  if (opts.redirectTo) body.redirect_to = opts.redirectTo
  if (opts.label) body.label = opts.label

  const { data, error } = await supabase.functions.invoke<OAuthStartResponse>(
    "oauth-start-slack",
    { body }
  )
  if (error) throw new Error(error.message)
  if (data?.error) throw new Error(data.error)
  if (!data?.data?.url) {
    throw new Error("oauth-start-slack returned no URL")
  }
  return data.data.url
}

export async function connectSlack(opts: StartSlackOptions = {}): Promise<void> {
  const here = odinRouteUrl("/connections")
  const url = await startSlackConnect({
    redirectTo: here,
    ...opts,
  })
  window.location.assign(url)
}

export async function disconnectSlack(
  userId: string,
  accountId: string
): Promise<void> {
  const { error } = await supabase
    .from("connected_accounts")
    .delete()
    .eq("user_id", userId)
    .eq("id", accountId)
  if (error) throw new Error(error.message)
}

// ─── Slack proxy actions ──────────────────────────────────────────────────

const FN = "slack-proxy"

export interface SlackChannel {
  id: string
  name: string
  is_channel: boolean
  is_private: boolean
  is_member?: boolean
  num_members?: number
}

export interface SlackChannelsResponse {
  ok: boolean
  channels?: SlackChannel[]
}

export interface SlackMessage {
  user?: string
  text?: string
  ts: string
  thread_ts?: string
}

export interface SlackHistoryResponse {
  ok: boolean
  messages?: SlackMessage[]
}

export function listSlackChannels(accountId: string, includeAll = false) {
  return invokeProxy<SlackChannelsResponse>(
    FN,
    "list_channels",
    { include_all: includeAll },
    accountId
  )
}

export function getSlackChannelHistory(
  accountId: string,
  channel: string,
  limit = 20
) {
  return invokeProxy<SlackHistoryResponse>(
    FN,
    "channel_history",
    { channel, limit },
    accountId
  )
}

export interface SlackUnreadChannel {
  id: string
  name: string
  is_member?: boolean
  unread_count: number
  last_read?: string
}

export interface SlackUnreadCountsResponse {
  ok: boolean
  channels: SlackUnreadChannel[]
}

export interface SlackChannelLatest {
  channel_id: string
  ok: boolean
  message: {
    user?: string
    text?: string
    ts: string
    thread_ts?: string
  } | null
  error?: string
}

export interface SlackChannelMessagesBatchResponse {
  ok: boolean
  channels: SlackChannelLatest[]
}

export interface SlackUserInfo {
  id: string
  display_name: string
  real_name?: string
}

export interface SlackUsersInfoResponse {
  ok: boolean
  users: SlackUserInfo[]
}

export function getSlackUnreadCounts(accountId: string) {
  return invokeProxy<SlackUnreadCountsResponse>(
    FN,
    "unread_counts",
    {},
    accountId
  )
}

export function getSlackChannelMessagesBatch(
  accountId: string,
  channelIds: string[],
  limit = 1
) {
  return invokeProxy<SlackChannelMessagesBatchResponse>(
    FN,
    "channel_messages_batch",
    { channel_ids: channelIds, limit },
    accountId
  )
}

export function resolveSlackUsers(accountId: string, userIds: string[]) {
  return invokeProxy<SlackUsersInfoResponse>(
    FN,
    "users_info",
    { user_ids: userIds },
    accountId
  )
}

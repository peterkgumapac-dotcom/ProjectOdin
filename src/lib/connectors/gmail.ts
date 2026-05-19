import { invokeProxy } from "@/lib/connectors/proxy"

const FN = "gmail-proxy"

export interface GmailLabelMeta {
  messagesTotal?: number
  messagesUnread?: number
}

export interface UnreadCount {
  inbox_total: number
  inbox_unread: number
}

export interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>
  nextPageToken?: string
  resultSizeEstimate?: number
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  payload?: {
    headers?: Array<{ name: string; value: string }>
  }
  internalDate?: string
}

export interface GmailProfile {
  emailAddress: string
  messagesTotal: number
  threadsTotal: number
}

export function unreadCount(accountId?: string | null) {
  return invokeProxy<UnreadCount>(FN, "unread_count", {}, accountId ?? null)
}

export function profile(accountId?: string | null) {
  return invokeProxy<GmailProfile>(FN, "profile", {}, accountId ?? null)
}

export function listMessages(
  params: { maxResults?: number; q?: string },
  accountId?: string | null
) {
  return invokeProxy<GmailListResponse>(FN, "list_messages", params, accountId ?? null)
}

export function getMessage(
  id: string,
  format: "metadata" | "full" = "metadata",
  accountId?: string | null
) {
  return invokeProxy<GmailMessage>(
    FN,
    "get_message",
    { id, format },
    accountId ?? null
  )
}

export function search(q: string, maxResults = 20, accountId?: string | null) {
  return invokeProxy<GmailListResponse>(
    FN,
    "search",
    { q, maxResults },
    accountId ?? null
  )
}

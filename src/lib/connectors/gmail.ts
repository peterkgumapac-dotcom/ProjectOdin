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

export function unreadCount() {
  return invokeProxy<UnreadCount>(FN, "unread_count")
}

export function profile() {
  return invokeProxy<GmailProfile>(FN, "profile")
}

export function listMessages(params: { maxResults?: number; q?: string }) {
  return invokeProxy<GmailListResponse>(FN, "list_messages", params)
}

export function getMessage(id: string, format: "metadata" | "full" = "metadata") {
  return invokeProxy<GmailMessage>(FN, "get_message", { id, format })
}

export function search(q: string, maxResults = 20) {
  return invokeProxy<GmailListResponse>(FN, "search", { q, maxResults })
}

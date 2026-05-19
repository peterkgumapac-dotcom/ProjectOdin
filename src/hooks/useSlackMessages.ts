import { useCallback, useEffect, useRef, useState } from "react"
import {
  getSlackChannelMessagesBatch,
  getSlackUnreadCounts,
  resolveSlackUsers,
  type SlackUnreadChannel,
} from "@/lib/connectors/slack"
import {
  useConnectedAccounts,
  type ConnectedAccount,
} from "@/hooks/useConnectedAccounts"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

const POLL_MS_DEFAULT = 60_000
const MAX_CHANNELS = 6

export interface SlackMessageItem {
  channelId: string
  channelName: string
  senderId: string
  senderName: string
  text: string
  ts: string
  timeLabel: string
  isUnread: boolean
  unreadCount: number
}

export interface WorkspaceMessages {
  accountId: string
  accountLabel: string
  workspaceName: string
  messages: SlackMessageItem[]
  totalUnread: number
  loading: boolean
  error: string | null
}

function tsToTimeLabel(ts: string): string {
  const seconds = parseFloat(ts)
  if (!Number.isFinite(seconds)) return ""
  const date = new Date(seconds * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function cleanSlackText(raw: string | undefined): string {
  if (!raw) return ""
  return raw
    .replace(/<@([A-Z0-9]+)\|?([^>]*)>/g, (_m, _id, label) => (label ? `@${label}` : "@user"))
    .replace(/<#([A-Z0-9]+)\|?([^>]*)>/g, (_m, _id, label) => (label ? `#${label}` : "#channel"))
    .replace(/<!subteam\^[A-Z0-9]+\|?([^>]*)>/g, (_m, l) => l || "@group")
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/:[a-z0-9_+-]+:/g, "")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function normalizeSlackWorkspaceError(message: string): string {
  if (/401|unauthorized|invalid_auth|account_inactive|token_revoked/i.test(message)) {
    return "Slack authorization expired. Reconnect this workspace in Connections."
  }
  return message
}

async function fetchWorkspaceMessages(
  accountId: string
): Promise<{ messages: SlackMessageItem[]; totalUnread: number }> {
  const unreadResp = await getSlackUnreadCounts(accountId)
  if (unreadResp.error) throw unreadResp.error
  if (unreadResp.data && !unreadResp.data.ok) {
    throw new Error("Slack unread scan failed")
  }
  const allChannels: SlackUnreadChannel[] = unreadResp.data?.channels ?? []

  const unreadFirst = [...allChannels].sort(
    (a, b) => b.unread_count - a.unread_count
  )
  const top = unreadFirst.slice(0, MAX_CHANNELS)
  if (top.length === 0) {
    return { messages: [], totalUnread: 0 }
  }
  const totalUnread = allChannels.reduce(
    (sum, c) => sum + (c.unread_count || 0),
    0
  )

  const batchResp = await getSlackChannelMessagesBatch(
    accountId,
    top.map((c) => c.id)
  )
  if (batchResp.error) throw batchResp.error
  if (batchResp.data && !batchResp.data.ok) {
    throw new Error("Slack message scan failed")
  }
  const latest = batchResp.data?.channels ?? []

  const senderIds = Array.from(
    new Set(
      latest
        .map((cl) => cl.message?.user)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  )

  const userMap = new Map<string, string>()
  if (senderIds.length > 0) {
    const usersResp = await resolveSlackUsers(accountId, senderIds)
    if (!usersResp.error && usersResp.data) {
      for (const u of usersResp.data.users) {
        userMap.set(u.id, u.display_name)
      }
    }
  }

  const messages: SlackMessageItem[] = latest
    .filter((cl) => cl.message)
    .map((cl) => {
      const meta = top.find((c) => c.id === cl.channel_id)
      const message = cl.message!
      return {
        channelId: cl.channel_id,
        channelName: meta?.name ?? cl.channel_id,
        senderId: message.user ?? "",
        senderName: message.user
          ? userMap.get(message.user) ?? message.user.slice(0, 8)
          : "Unknown",
        text: cleanSlackText(message.text) || "(attachment)",
        ts: message.ts,
        timeLabel: tsToTimeLabel(message.ts),
        isUnread: (meta?.unread_count ?? 0) > 0,
        unreadCount: meta?.unread_count ?? 0,
      }
    })
    .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))

  return { messages, totalUnread }
}

export interface UseSlackMessagesResult {
  workspaces: WorkspaceMessages[]
  totalUnread: number
  loading: boolean
  checkedAt: string | null
  refresh: () => Promise<void>
}

interface CachedSlackMessages {
  workspaces: WorkspaceMessages[]
  checkedAt: string | null
}

function cacheKey(key: string) {
  return `odin.slack.messages.${key || "none"}`
}

function readCachedSlack(key: string): CachedSlackMessages | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedSlackMessages
    return Array.isArray(parsed.workspaces) ? parsed : null
  } catch {
    return null
  }
}

function writeCachedSlack(
  key: string,
  workspaces: WorkspaceMessages[],
  checkedAt: string
) {
  try {
    window.localStorage.setItem(
      cacheKey(key),
      JSON.stringify({ workspaces, checkedAt })
    )
  } catch {
    // Cache is only for manual-scan continuity.
  }
}

export function useSlackMessages(
  pollMs: number = POLL_MS_DEFAULT,
  auto = true
): UseSlackMessagesResult {
  const { slack, loading: accountsLoading } = useConnectedAccounts()
  const [workspaces, setWorkspaces] = useState<WorkspaceMessages[]>([])
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const key = slack
    .map((a) => `${a.id}:${a.accountLabel}:${a.workspaceName ?? ""}`)
    .join("|")

  const refresh = useCallback(async () => {
    if (slack.length === 0) {
      setWorkspaces([])
      setCheckedAt(null)
      return
    }

    setWorkspaces((prev) =>
      slack.map<WorkspaceMessages>((acct: ConnectedAccount) => {
        const existing = prev.find((w) => w.accountId === acct.id)
        return (
          existing ?? {
            accountId: acct.id,
            accountLabel: acct.accountLabel,
            workspaceName: acct.workspaceName ?? acct.accountLabel,
            messages: [],
            totalUnread: 0,
            loading: true,
            error: null,
          }
        )
      })
    )

    const workspaceMap = new Map<string, WorkspaceMessages>(
      slack.map((acct) => [
        acct.id,
        {
          accountId: acct.id,
          accountLabel: acct.accountLabel,
          workspaceName: acct.workspaceName ?? acct.accountLabel,
          messages: [],
          totalUnread: 0,
          loading: false,
          error: null,
        },
      ])
    )

    await Promise.allSettled(
      slack.map(async (acct) => {
        try {
          const { messages, totalUnread } = await fetchWorkspaceMessages(acct.id)
          const next = {
            accountId: acct.id,
            accountLabel: acct.accountLabel,
            workspaceName: acct.workspaceName ?? acct.accountLabel,
            messages,
            totalUnread,
            loading: false,
            error: null,
          }
          workspaceMap.set(acct.id, next)
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.accountId === acct.id
                ? next
                : w
            )
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error"
          const next = {
            accountId: acct.id,
            accountLabel: acct.accountLabel,
            workspaceName: acct.workspaceName ?? acct.accountLabel,
            messages: [],
            totalUnread: 0,
            loading: false,
            error: normalizeSlackWorkspaceError(message),
          }
          workspaceMap.set(acct.id, next)
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.accountId === acct.id
                ? next
                : w
            )
          )
        }
      })
    )
    const now = new Date().toISOString()
    const nextWorkspaces = Array.from(workspaceMap.values())
    setWorkspaces(nextWorkspaces)
    setCheckedAt(now)
    writeCachedSlack(key, nextWorkspaces, now)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (accountsLoading) return
    const cached = readCachedSlack(key)
    if (cached) {
      setWorkspaces(cached.workspaces)
      setCheckedAt(cached.checkedAt)
    }

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void refresh()
    }
    const handleVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refresh()
      }
    }
    if (auto) refresh()
    if (pollMs > 0) intervalRef.current = setInterval(tick, pollMs)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisible)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisible)
      }
    }
  }, [refresh, accountsLoading, auto, key, pollMs])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "slack")) return
      void refresh()
    })
  }, [refresh])

  const totalUnread = workspaces.reduce((sum, w) => sum + w.totalUnread, 0)
  const loading = accountsLoading || workspaces.some((w) => w.loading)

  return { workspaces, totalUnread, loading, checkedAt, refresh }
}

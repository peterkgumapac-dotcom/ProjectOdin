import { useCallback, useEffect, useState } from "react"
import { getMessage, listMessages, type GmailMessage } from "@/lib/connectors/gmail"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

const POLL_MS = 60_000

export interface RecentEmail {
  id: string
  sender: string
  subject: string
  preview: string
  time: string
  unread: boolean
}

export interface UseRecentEmailsResult {
  emails: RecentEmail[]
  loading: boolean
  error: Error | null
}

function header(message: GmailMessage, name: string): string {
  return (
    message.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    )?.value ?? ""
  )
}

function senderName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return (match?.[1] ?? from).replace(/^['"]|['"]$/g, "").trim() || "Unknown"
}

function timeLabel(internalDate?: string): string {
  const ms = Number(internalDate)
  if (!Number.isFinite(ms)) return ""
  const date = new Date(ms)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  if (diffMs < 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function toRecentEmail(message: GmailMessage): RecentEmail {
  const subject = header(message, "Subject")
  return {
    id: message.id,
    sender: senderName(header(message, "From")),
    subject: subject || "(no subject)",
    preview: message.snippet ?? "",
    time: timeLabel(message.internalDate),
    unread: message.labelIds?.includes("UNREAD") ?? false,
  }
}

export function useRecentEmails(
  accountId: string | null | undefined,
  enabled: boolean
): UseRecentEmailsResult {
  const [emails, setEmails] = useState<RecentEmail[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled || !accountId) {
      setEmails([])
      return
    }
    setLoading(true)
    let list = await listMessages(
      { q: "in:inbox is:unread newer_than:7d", maxResults: 4 },
      accountId
    )
    if (list.error) {
      setError(list.error)
      setLoading(false)
      return
    }

    let ids = list.data?.messages ?? []
    if (ids.length === 0) {
      list = await listMessages(
        { q: "in:inbox newer_than:7d", maxResults: 4 },
        accountId
      )
      if (list.error) {
        setError(list.error)
        setLoading(false)
        return
      }
      ids = list.data?.messages ?? []
    }

    const settled = await Promise.allSettled(
      ids.map((msg) => getMessage(msg.id, "metadata", accountId))
    )

    const next = settled
      .map((res) => (res.status === "fulfilled" ? res.value.data : null))
      .filter((msg): msg is GmailMessage => Boolean(msg))
      .map(toRecentEmail)

    setEmails(next)
    setError(null)
    setLoading(false)
  }, [accountId, enabled])

  useEffect(() => {
    if (!enabled || !accountId) {
      setEmails([])
      return
    }
    let cancelled = false

    async function fetchOnce() {
      setLoading(true)
      let list = await listMessages(
        { q: "in:inbox is:unread newer_than:7d", maxResults: 4 },
        accountId
      )
      if (cancelled) return
      if (list.error) {
        setError(list.error)
        setLoading(false)
        return
      }

      let ids = list.data?.messages ?? []
      if (ids.length === 0) {
        list = await listMessages(
          { q: "in:inbox newer_than:7d", maxResults: 4 },
          accountId
        )
        if (cancelled) return
        if (list.error) {
          setError(list.error)
          setLoading(false)
          return
        }
        ids = list.data?.messages ?? []
      }

      const settled = await Promise.allSettled(
        ids.map((msg) => getMessage(msg.id, "metadata", accountId))
      )
      if (cancelled) return

      const next = settled
        .map((res) => (res.status === "fulfilled" ? res.value.data : null))
        .filter((msg): msg is GmailMessage => Boolean(msg))
        .map(toRecentEmail)

      setEmails(next)
      setError(null)
      setLoading(false)
    }

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void fetchOnce()
    }
    const handleVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void fetchOnce()
      }
    }
    fetchOnce()
    const interval = setInterval(tick, POLL_MS)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisible)
    }
    return () => {
      cancelled = true
      clearInterval(interval)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisible)
      }
    }
  }, [accountId, enabled])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "gmail")) return
      void refresh()
    })
  }, [refresh])

  return { emails, loading, error }
}

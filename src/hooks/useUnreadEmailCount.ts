import { useCallback, useEffect, useState } from "react"
import { unreadCount } from "@/lib/connectors/gmail"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

const POLL_MS = 60_000

export interface UseUnreadEmailCount {
  total: number | null
  unread: number | null
  loading: boolean
  error: Error | null
}

/**
 * Live unread count for a single Google account.
 *
 * - `enabled` gates whether the hook actually polls (false when Google is not
 *   connected for this user).
 * - `accountId` selects a specific connected_accounts row. When omitted, the
 *   gmail-proxy falls back to the user's primary Google account.
 */
export function useUnreadEmailCount(
  enabled: boolean,
  accountId?: string | null
): UseUnreadEmailCount {
  const [total, setTotal] = useState<number | null>(null)
  const [unread, setUnread] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setTotal(null)
      setUnread(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const { data, error: err } = await unreadCount(accountId ?? null)
    if (err) {
      setError(err)
      setLoading(false)
      return
    }
    setError(null)
    setTotal(data?.inbox_total ?? null)
    setUnread(data?.inbox_unread ?? null)
    setLoading(false)
  }, [accountId, enabled])

  useEffect(() => {
    let cancelled = false

    async function fetchOnce() {
      if (!enabled) {
        setTotal(null)
        setUnread(null)
        setLoading(false)
        return
      }
      setLoading(true)
      const { data, error: err } = await unreadCount(accountId ?? null)
      if (cancelled) return
      if (err) {
        setError(err)
        setLoading(false)
        return
      }
      setError(null)
      setTotal(data?.inbox_total ?? null)
      setUnread(data?.inbox_unread ?? null)
      setLoading(false)
    }

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void fetchOnce()
    }

    fetchOnce()
    const interval = setInterval(tick, POLL_MS)
    const handleVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void fetchOnce()
      }
    }
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
  }, [enabled, accountId])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "gmail")) return
      void refresh()
    })
  }, [refresh])

  return { total, unread, loading, error }
}

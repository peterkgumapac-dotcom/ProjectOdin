import { useEffect, useState } from "react"
import { unreadCount } from "@/lib/connectors/gmail"

const POLL_MS = 60_000

export interface UseUnreadEmailCount {
  total: number | null
  unread: number | null
  loading: boolean
  error: Error | null
}

export function useUnreadEmailCount(enabled: boolean): UseUnreadEmailCount {
  const [total, setTotal] = useState<number | null>(null)
  const [unread, setUnread] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!enabled) {
      setTotal(null)
      setUnread(null)
      return
    }
    let cancelled = false

    async function fetchOnce() {
      setLoading(true)
      const { data, error: err } = await unreadCount()
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

    fetchOnce()
    const interval = setInterval(fetchOnce, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [enabled])

  return { total, unread, loading, error }
}

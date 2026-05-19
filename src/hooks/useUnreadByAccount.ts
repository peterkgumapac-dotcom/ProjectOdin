import { useCallback, useEffect, useState } from "react"
import { unreadCount } from "@/lib/connectors/gmail"
import type { ConnectedAccount } from "@/hooks/useConnectedAccounts"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

const POLL_MS = 60_000

export interface UnreadEntry {
  accountId: string
  accountLabel: string
  accountEmail: string | null
  unread: number | null
  total: number | null
  error: Error | null
}

export interface UseUnreadByAccountResult {
  entries: UnreadEntry[]
  totalUnread: number
  loading: boolean
  checkedAt: string | null
  refresh: () => Promise<void>
}

interface UseUnreadByAccountOptions {
  auto?: boolean
  pollMs?: number
}

interface CachedUnreadEntries {
  entries: UnreadEntry[]
  checkedAt: string | null
}

function cacheKey(key: string) {
  return `odin.gmail.unread.${key || "none"}`
}

function readCachedEntries(key: string): CachedUnreadEntries | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedUnreadEntries
    return Array.isArray(parsed.entries) ? parsed : null
  } catch {
    return null
  }
}

function writeCachedEntries(key: string, entries: UnreadEntry[], checkedAt: string) {
  try {
    window.localStorage.setItem(
      cacheKey(key),
      JSON.stringify({ entries, checkedAt })
    )
  } catch {
    // Local cache is best-effort only.
  }
}

/**
 * Polls Gmail unread/total counts in parallel for every Google account passed
 * in. Used by the RAVEN: EMAIL card when more than one Gmail account is
 * connected and by the chat system prompt to inject per-account context.
 */
export function useUnreadByAccount(
  accounts: ConnectedAccount[] | undefined,
  options: UseUnreadByAccountOptions = {}
): UseUnreadByAccountResult {
  const [entries, setEntries] = useState<UnreadEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)

  const safeAccounts: ConnectedAccount[] = Array.isArray(accounts)
    ? accounts
    : []

  // Stable key so we don't refetch when array identity changes but contents do not.
  const key = safeAccounts
    .map((a) => `${a.id}:${a.accountLabel}:${a.accountEmail ?? ""}`)
    .join("|")

  const refresh = useCallback(async () => {
    if (safeAccounts.length === 0) {
      setEntries([])
      setCheckedAt(null)
      setLoading(false)
      return
    }

    setLoading(true)
    const results = await Promise.all(
      safeAccounts.map(async (acct) => {
        const { data, error } = await unreadCount(acct.id)
        return {
          accountId: acct.id,
          accountLabel: acct.accountLabel,
          accountEmail: acct.accountEmail,
          unread: data?.inbox_unread ?? null,
          total: data?.inbox_total ?? null,
          error: error,
        } satisfies UnreadEntry
      })
    )
    const now = new Date().toISOString()
    setEntries(results)
    setCheckedAt(now)
    writeCachedEntries(key, results, now)
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    const cached = readCachedEntries(key)
    if (cached) {
      setEntries(cached.entries)
      setCheckedAt(cached.checkedAt)
    }

    if (options.auto === false) return

    let cancelled = false

    async function fetchAll() {
      await refresh()
      if (cancelled) return
    }

    fetchAll()
    const interval = setInterval(fetchAll, options.pollMs ?? POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [key, options.auto, options.pollMs, refresh])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "gmail")) return
      void refresh()
    })
  }, [refresh])

  const totalUnread = entries.reduce(
    (sum, e) => sum + (typeof e.unread === "number" ? e.unread : 0),
    0
  )

  return { entries, totalUnread, loading, checkedAt, refresh }
}

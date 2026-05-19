import { useCallback, useEffect, useState } from "react"
import type { ConnectedAccount } from "@/hooks/useConnectedAccounts"
import { rangeEvents, type CalendarEvent } from "@/lib/connectors/calendar"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

const CALENDAR_CACHE_MAX_AGE_MS = 8 * 60 * 60 * 1000
const POLL_MS = CALENDAR_CACHE_MAX_AGE_MS
const CALENDAR_CACHE_PREFIX = "odin.calendar.today"
const OPS_HOME_TIMEZONE = "Asia/Manila"

function opsDate(): string {
  const now = new Date()
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OPS_HOME_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

function operationsCalendarWindowIso(): { timeMin: string; timeMax: string } {
  const now = Date.now()
  return {
    // ODIN serves Laguna/Manila while Peter works Nashville and Norway.
    // A rolling window avoids losing "today" meetings when one ops timezone
    // has crossed midnight and another has not.
    timeMin: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
  }
}

function eventStartMs(event: CalendarEvent): number {
  const raw = event.start?.dateTime ?? event.start?.date
  return raw ? new Date(raw).getTime() : Number.MAX_SAFE_INTEGER
}

interface CachedTodayEvents {
  date: string
  items: CalendarEvent[]
  checkedAt: string | null
}

interface UseTodayEventsOptions {
  auto?: boolean
  pollMs?: number
}

export interface UseTodayEvents {
  events: CalendarEvent[]
  loading: boolean
  error: Error | null
  checkedAt: string | null
  refresh: () => Promise<void>
}

function cacheKeyFor(accountsKey: string, date: string): string {
  return `${CALENDAR_CACHE_PREFIX}.${accountsKey || "none"}.${date}`
}

function readCachedEvents(key: string, date: string): CachedTodayEvents | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedTodayEvents>
    if (parsed.date !== date || !Array.isArray(parsed.items)) return null
    return {
      date,
      items: parsed.items,
      checkedAt: parsed.checkedAt ?? null,
    }
  } catch {
    return null
  }
}

function writeCachedEvents(
  key: string,
  date: string,
  items: CalendarEvent[],
  checkedAt: string
) {
  if (typeof window === "undefined") return
  try {
    const payload: CachedTodayEvents = { date, items, checkedAt }
    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Cache writes are opportunistic; live scans should not fail because storage is full.
  }
}

function isFreshCache(checkedAt: string | null | undefined): boolean {
  if (!checkedAt) return false
  const time = new Date(checkedAt).getTime()
  if (!Number.isFinite(time)) return false
  return Date.now() - time <= CALENDAR_CACHE_MAX_AGE_MS
}

export function useTodayEvents(
  accounts: ConnectedAccount[],
  options: UseTodayEventsOptions = {}
): UseTodayEvents {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const key = accounts.map((account) => account.id).join("|")
  const today = opsDate()
  const cacheKey = cacheKeyFor(key, today)
  const auto = options.auto ?? false
  const pollMs = options.pollMs ?? POLL_MS

  const refresh = useCallback(async () => {
    if (accounts.length === 0) {
      setEvents([])
      setError(null)
      setCheckedAt(null)
      setLoading(false)
      return
    }

    setLoading(true)
    const { timeMin, timeMax } = operationsCalendarWindowIso()
    const results = await Promise.all(
      accounts.map(async (account) => {
        const { data, error: err } = await rangeEvents(
          timeMin,
          timeMax,
          account.id,
          40
        )
        return {
          account,
          events: data?.items ?? [],
          error: err,
        }
      })
    )

    const failed = results.filter((result) => result.error)
    const merged = results
      .flatMap((result) =>
        result.events.map((event) => ({
          ...event,
          sourceAccountId: result.account.id,
          sourceAccountLabel: result.account.accountLabel,
        }))
      )
      .sort((a, b) => eventStartMs(a) - eventStartMs(b))

    if (failed.length === results.length) {
      setError(failed[0]?.error ?? new Error("Calendar unavailable."))
      setEvents([])
      setLoading(false)
      return
    }

    setError(failed[0]?.error ?? null)
    setEvents(merged)
    const checked = new Date().toISOString()
    setCheckedAt(checked)
    writeCachedEvents(cacheKey, today, merged, checked)
    setLoading(false)
  }, [accounts, cacheKey, today])

  useEffect(() => {
    const cached = readCachedEvents(cacheKey, today)
    if (cached) {
      setEvents(cached.items)
      setCheckedAt(cached.checkedAt)
      setError(null)
    }

    if (!auto) {
      setLoading(false)
      return
    }

    if (!cached || !isFreshCache(cached.checkedAt)) {
      void refresh()
    }
    if (pollMs <= 0) return

    const interval = setInterval(refresh, pollMs)
    return () => {
      clearInterval(interval)
    }
  }, [auto, cacheKey, pollMs, refresh, today])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "calendar")) return
      void refresh()
    })
  }, [refresh])

  return { events, loading, error, checkedAt, refresh }
}

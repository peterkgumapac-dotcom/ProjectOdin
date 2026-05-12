import { useEffect, useState } from "react"
import { todayEvents, type CalendarEvent } from "@/lib/connectors/calendar"

const POLL_MS = 60_000

export interface UseTodayEvents {
  events: CalendarEvent[]
  loading: boolean
  error: Error | null
}

export function useTodayEvents(enabled: boolean): UseTodayEvents {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!enabled) {
      setEvents([])
      return
    }
    let cancelled = false

    async function fetchOnce() {
      setLoading(true)
      const { data, error: err } = await todayEvents()
      if (cancelled) return
      if (err) {
        setError(err)
        setLoading(false)
        return
      }
      setError(null)
      setEvents(data?.items ?? [])
      setLoading(false)
    }

    fetchOnce()
    const interval = setInterval(fetchOnce, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [enabled])

  return { events, loading, error }
}

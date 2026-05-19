import { Link } from "react-router-dom"
import { CalendarClock } from "lucide-react"
import type { CalendarEvent } from "@/lib/connectors/calendar"

interface TodayOperationsProps {
  events: CalendarEvent[]
  loading: boolean
  connected: boolean
  error: Error | null
}

function eventStart(event: CalendarEvent): Date | null {
  const raw = event.start?.dateTime ?? event.start?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function timeLabel(date: Date | null): string {
  if (!date) return "All day"
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

export function TodayOperations({
  events,
  loading,
  connected,
  error,
}: TodayOperationsProps) {
  return (
    <section className="glass-card rounded-lg p-4 h-full">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock size={15} className="text-gold" />
          <span className="label-track text-foreground">Today</span>
        </div>
        <Link
          to="/calendar"
          className="text-[10px] font-semibold uppercase tracking-wider text-tertiary transition-colors hover:text-gold"
        >
          Calendar →
        </Link>
      </header>

      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-tertiary">
        Commitments
      </p>
      {loading ? (
        <p className="text-xs text-tertiary">Checking calendar…</p>
      ) : !connected ? (
        <p className="text-xs text-tertiary">
          Connect Google Calendar to anchor the day.
        </p>
      ) : error ? (
        <p className="text-xs text-destructive">{error.message}</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No calendar events scheduled today.
        </p>
      ) : (
        <ul className="space-y-2">
          {events.slice(0, 5).map((event) => {
            const start = eventStart(event)
            return (
              <li
                key={`${event.sourceAccountId}:${event.id}`}
                className="flex gap-3 rounded-md border border-border/50 bg-background/25 px-3 py-2"
              >
                <span className="w-14 shrink-0 font-mono-data text-xs text-gold">
                  {timeLabel(start)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-foreground">
                    {event.summary ?? "Untitled event"}
                  </p>
                  <p className="truncate text-[10px] text-tertiary">
                    {[event.sourceAccountLabel, event.location]
                      .filter(Boolean)
                      .join(" · ") || "Calendar"}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

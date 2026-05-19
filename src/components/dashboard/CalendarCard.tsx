import { Link } from "react-router-dom"
import type { CalendarEvent } from "@/lib/connectors/calendar"

interface CalendarCardProps {
  events: CalendarEvent[]
  loading: boolean
  connected: boolean
  error: Error | null
}

function eventTime(e: CalendarEvent): string {
  const dt = e.start?.dateTime ?? e.start?.date
  if (!dt) return ""
  const d = new Date(dt)
  if (e.start?.date && !e.start?.dateTime) return "All day"
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

function eventDuration(e: CalendarEvent): string {
  const s = e.start?.dateTime
  const en = e.end?.dateTime
  if (!s || !en) return ""
  const mins = Math.round(
    (new Date(en).getTime() - new Date(s).getTime()) / 60000
  )
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function MiniMonth() {
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth()
  const firstWeekday = new Date(year, month, 1).getDay() // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: Array<number | null> = []
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const monthLabel = today
    .toLocaleDateString(undefined, { month: "long", year: "numeric" })
    .toUpperCase()

  return (
    <div className="w-[160px] shrink-0">
      <div className="label-track text-gold mb-2">{monthLabel}</div>
      <div className="grid grid-cols-7 gap-y-1 text-[10px] text-tertiary mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i} className="text-center">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-[11px] font-mono-data">
        {cells.map((d, i) => {
          const isToday = d === today.getDate()
          return (
            <span
              key={i}
              className={[
                "text-center w-5 h-5 leading-5 mx-auto rounded-full",
                isToday
                  ? "bg-gold text-background font-semibold"
                  : d === null
                    ? "text-tertiary/40"
                    : "text-muted-foreground",
              ].join(" ")}
            >
              {d ?? ""}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function CalendarCard({
  events,
  loading,
  connected,
  error,
}: CalendarCardProps) {
  return (
    <section className="glass-card rounded-lg p-4 flex flex-col h-full">
      <header className="flex items-center justify-between mb-4">
        <span className="label-track text-foreground">CALENDAR</span>
        <span className="label-track text-tertiary">TODAY</span>
      </header>

      <div className="flex gap-5 flex-1 min-h-0">
        <MiniMonth />

        <div className="flex-1 min-w-0 border-l border-border/60 pl-5 overflow-hidden">
          {!connected && (
            <p className="text-xs text-tertiary">
              Connect Google to see today's council.
            </p>
          )}
          {connected && error && (
            <p className="text-xs text-destructive">{error.message}</p>
          )}
          {connected && !error && events.length === 0 && !loading && (
            <p className="text-xs text-tertiary">No councils scheduled</p>
          )}
          {connected && events.length > 0 && (
            <ul className="space-y-3">
              {events.slice(0, 4).map((e) => (
                <li key={e.id} className="flex items-start gap-3">
                  <div className="font-mono-data text-xs text-gold shrink-0 w-14">
                    {eventTime(e)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-foreground truncate">
                      {e.summary ?? "(no title)"}
                    </p>
                    <p className="text-[10px] text-tertiary mt-0.5">
                      {[eventDuration(e), e.sourceAccountLabel, e.location]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <footer className="mt-4 pt-3 border-t border-border/60">
        <Link
          to="/calendar"
          className="label-track text-tertiary hover:text-gold transition-colors"
        >
          VIEW FULL CALENDAR →
        </Link>
      </footer>
    </section>
  )
}

import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { CalendarEvent } from "@/lib/connectors/calendar"

interface ScheduleCardProps {
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
  if (!date) return "ALL DAY"
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function countdown(target: Date | null, now: Date): string {
  if (!target) return "TODAY"
  const diffMin = Math.round((target.getTime() - now.getTime()) / 60000)
  if (diffMin <= 0) return "PAST"
  if (diffMin < 60) return `IN ${diffMin}M`
  const hours = Math.floor(diffMin / 60)
  const minutes = diffMin % 60
  if (minutes === 0) return `IN ${hours}H`
  return `IN ${hours}H ${minutes}M`
}

export function ScheduleCard({
  events,
  loading,
  connected,
  error,
}: ScheduleCardProps) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const schedule = [...events]
    .sort((a, b) => {
      const aStart = eventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER
      const bStart = eventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER
      return aStart - bStart
    })
    .slice(0, 5)

  return (
    <section className="glass-card rounded-lg p-4 flex flex-col h-full">
      <header className="flex items-center justify-between mb-4">
        <span className="label-track text-foreground">TODAY'S SCHEDULE</span>
        <span className="label-track text-tertiary">RITUAL</span>
      </header>

      <ul className="space-y-3 flex-1 relative">
        <span className="absolute left-[26px] top-2 bottom-2 w-px bg-border/60" />
        {loading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <li key={index} className="flex items-start gap-3 relative animate-pulse">
              <div className="w-14 shrink-0 h-3 bg-tertiary/20 rounded mt-0.5" />
              <span className="mt-1 w-2 h-2 rounded-full border-2 shrink-0 relative z-10 bg-background border-tertiary/50" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="h-3 w-28 bg-tertiary/20 rounded" />
                <div className="h-2.5 w-20 bg-tertiary/10 rounded" />
              </div>
            </li>
          ))
        ) : !connected ? (
          <li className="text-xs text-tertiary">
            Connect Google Calendar in Ravens to show today's schedule.
          </li>
        ) : error ? (
          <li className="text-xs text-destructive">
            Failed to load calendar: {error.message}
          </li>
        ) : schedule.length === 0 ? (
          <li className="text-xs text-tertiary">
            No calendar events scheduled today.
          </li>
        ) : (
          schedule.map((item) => {
            const start = eventStart(item)
            const cd = countdown(start, now)
            const past = cd === "PAST"
            return (
              <li key={item.id} className="flex items-start gap-3 relative">
                <div className="w-14 shrink-0">
                  <div
                    className={[
                      "font-mono-data text-xs leading-tight",
                      past ? "text-tertiary line-through" : "text-gold",
                    ].join(" ")}
                  >
                    {timeLabel(start)}
                  </div>
                </div>
                <span
                  className={[
                    "mt-1 w-2 h-2 rounded-full border-2 shrink-0 relative z-10",
                    past
                      ? "bg-background border-tertiary"
                      : "bg-background border-gold gold-glow",
                  ].join(" ")}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className={[
                      "text-xs font-semibold truncate",
                      past ? "text-tertiary" : "text-foreground",
                    ].join(" ")}
                  >
                    {item.summary ?? "Untitled event"}
                  </p>
                  <p className="text-[10px] text-tertiary mt-0.5 truncate">
                    {[
                      item.sourceAccountLabel,
                      item.location ||
                        item.organizer?.displayName ||
                        item.organizer?.email ||
                        "Calendar",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span
                  className={[
                    "ml-auto shrink-0 px-2 py-0.5 rounded-full text-[10px] tracking-wider border font-mono-data",
                    past
                      ? "border-tertiary/40 text-tertiary"
                      : "border-frost/40 text-frost",
                  ].join(" ")}
                >
                  {cd}
                </span>
              </li>
            )
          })
        )}
      </ul>

      <footer className="mt-4 pt-3 border-t border-border/60">
        <Link
          to="/calendar"
          className="label-track text-tertiary hover:text-gold transition-colors"
        >
          VIEW FULL SCHEDULE →
        </Link>
      </footer>
    </section>
  )
}

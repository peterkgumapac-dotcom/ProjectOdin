import type { ConnectedAccount } from "@/hooks/useConnectedAccounts"
import type { CalendarEvent } from "@/lib/connectors/calendar"

interface OdinsCounselProps {
  googleAccounts: ConnectedAccount[]
  events: CalendarEvent[]
  eventsLoading: boolean
  eventsError: Error | null
}

interface CounselItem {
  id: string
  text: string
}

function nextEvent(events: CalendarEvent[]): CalendarEvent | null {
  const now = Date.now()
  return (
    [...events]
      .filter((event) => {
        const raw = event.start?.dateTime ?? event.start?.date
        if (!raw) return false
        return new Date(raw).getTime() >= now
      })
      .sort((a, b) => {
        const aTime = new Date(a.start?.dateTime ?? a.start?.date ?? 0).getTime()
        const bTime = new Date(b.start?.dateTime ?? b.start?.date ?? 0).getTime()
        return aTime - bTime
      })[0] ?? null
  )
}

function eventTime(event: CalendarEvent): string {
  const raw = event.start?.dateTime ?? event.start?.date
  if (!raw) return "today"
  return new Date(raw).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

export function OdinsCounsel({
  googleAccounts,
  events,
  eventsLoading,
  eventsError,
}: OdinsCounselProps) {
  const upcoming = nextEvent(events)

  const items: CounselItem[] = []

  if (googleAccounts.length === 0) {
    items.push({
      id: "connect-google",
      text: "Connect Google in Ravens so counsel can use Calendar data and Claude/Codex can brief Gmail.",
    })
  } else {
    items.push({
      id: "gmail-agent-brief",
      text: "Gmail priority is agent-fed: Claude/Codex source briefs decide what needs Peter, not unread counts.",
    })

    if (eventsLoading) {
      items.push({ id: "calendar-loading", text: "Checking today's Google Calendar schedule." })
    } else if (eventsError) {
      items.push({
        id: "calendar-error",
        text: `Calendar needs attention: ${eventsError.message}`,
      })
    } else if (upcoming) {
      items.push({
        id: "next-event",
        text: `Next council: ${upcoming.summary ?? "Untitled event"} at ${eventTime(upcoming)}.`,
      })
    } else {
      items.push({ id: "calendar-open", text: "No remaining Google Calendar events today." })
    }
  }

  return (
    <section className="glass-card rounded-lg p-4 flex flex-col h-full">
      <header className="flex items-center justify-between mb-4 border-l-2 border-gold pl-3">
        <span className="font-display text-sm tracking-[0.25em] text-gold">
          ODIN'S COUNSEL
        </span>
        <span className="label-track text-tertiary">PRIORITY</span>
      </header>

      <ul className="space-y-3 flex-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="border-l border-gold/40 pl-3 hover:border-gold transition-colors"
          >
            <p className="text-xs text-foreground leading-snug">{item.text}</p>
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                className="px-2 py-0.5 text-[10px] tracking-wider uppercase text-tertiary border border-border/80 rounded-full hover:text-gold hover:border-gold/40 transition-colors"
              >
                Address
              </button>
              <button
                type="button"
                className="px-2 py-0.5 text-[10px] tracking-wider uppercase text-tertiary border border-border/80 rounded-full hover:text-frost hover:border-frost/40 transition-colors"
              >
                Defer
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

import { useEffect, useMemo, useState, type CSSProperties } from "react"
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Plus,
  RefreshCw,
} from "lucide-react"
import {
  LightPageHeader,
  LightPageShell,
} from "@/components/dashboard/LightPageChrome"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import {
  createEvent,
  listCalendars,
  rangeEvents,
  type CalendarEvent,
  type CalendarListEntry,
  type CreateCalendarEventInput,
} from "@/lib/connectors/calendar"
import { connectGoogle } from "@/lib/connectors/google"
import { odinRouteUrl } from "@/lib/desktopRoute"
import type { ConnectedAccount } from "@/hooks/useConnectedAccounts"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

type CalendarView = "day" | "week" | "month"

interface CalendarRow {
  account: ConnectedAccount
  events: CalendarEvent[]
  calendars: CalendarListEntry[]
  error: Error | null
  calendarError: Error | null
}

interface EnrichedEvent extends CalendarEvent {
  sourceAccountId: string
  sourceAccountLabel: string
  sourceAccountEmail: string | null
}

interface DayCell {
  date: Date
  inMonth: boolean
}

interface CalendarDraft {
  title: string
  date: string
  startTime: string
  durationMinutes: string
  accountId: string
  location: string
  details: string
}

const DEFAULT_START_HOUR = 7
const DEFAULT_END_HOUR = 21
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const EVENT_PALETTES = [
  { bg: "#fff0e8", border: "#f0b89c", text: "#964215" },
  { bg: "#eef5ff", border: "#bdd4f6", text: "#284e8f" },
  { bg: "#f4ecfb", border: "#d8bce9", text: "#5b3676" },
  { bg: "#eef7e9", border: "#bddaae", text: "#3d6932" },
  { bg: "#fff6df", border: "#eed28b", text: "#8b5c10" },
  { bg: "#eaf7f5", border: "#9ed3cd", text: "#2f6f68" },
]
const CALENDAR_TIME_ZONE = "Asia/Manila"
const CALENDAR_WRITE_SCOPES = new Set([
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
])

function localDate(): string {
  return dateInputValue(new Date())
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function parseDateInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date: Date): Date {
  const out = startOfDay(date)
  out.setHours(23, 59, 59, 999)
  return out
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate())
}

function startOfWeek(date: Date): Date {
  const out = startOfDay(date)
  const mondayOffset = (out.getDay() + 6) % 7
  return addDays(out, -mondayOffset)
}

function endOfWeek(date: Date): Date {
  return endOfDay(addDays(startOfWeek(date), 6))
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date): Date {
  return endOfDay(new Date(date.getFullYear(), date.getMonth() + 1, 0))
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function rangeForView(date: string, view: CalendarView) {
  const current = parseDateInput(date)
  if (view === "day") return { start: startOfDay(current), end: endOfDay(current) }
  if (view === "week") return { start: startOfWeek(current), end: endOfWeek(current) }
  return { start: startOfMonth(current), end: endOfMonth(current) }
}

function eventStart(event: CalendarEvent): Date | null {
  const raw = event.start?.dateTime ?? event.start?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function eventEnd(event: CalendarEvent): Date | null {
  const raw = event.end?.dateTime ?? event.end?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function isAllDay(event: CalendarEvent): boolean {
  return Boolean(event.start?.date && !event.start.dateTime)
}

function eventMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

function timeLabel(event: CalendarEvent): string {
  if (isAllDay(event)) return "All day"
  const start = eventStart(event)
  const end = eventEnd(event)
  if (!start) return "Time not set"
  if (!end) {
    return start.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    })
  }
  return `${start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })} – ${end.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

function paletteFor(event: CalendarEvent) {
  const key =
    event.sourceCalendarId ??
    event.sourceCalendarSummary ??
    event.sourceAccountId ??
    event.summary ??
    "calendar"
  return EVENT_PALETTES[hashString(key) % EVENT_PALETTES.length]
}

function googleCalendarUrl(date: string, email?: string | null): string {
  const [year, month, day] = date.split("-")
  const params = new URLSearchParams()
  if (email) params.set("authuser", email)
  const suffix = params.toString()
  return `https://calendar.google.com/calendar/u/0/r/day/${year}/${month}/${day}${
    suffix ? `?${suffix}` : ""
  }`
}

function googleCreateEventDraftUrl(draft: CalendarDraft, email?: string | null): string {
  const start = localGoogleDateTime(draft.date, draft.startTime)
  const end = localGoogleDateTime(
    draft.date,
    addMinutesToTime(draft.startTime, Number(draft.durationMinutes) || 30)
  )
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: draft.title.trim() || "ODIN block",
    dates: `${start}/${end}`,
    ctz: CALENDAR_TIME_ZONE,
  })
  if (draft.location.trim()) params.set("location", draft.location.trim())
  if (draft.details.trim()) params.set("details", draft.details.trim())
  if (email) params.set("authuser", email)
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

function hasCalendarWriteScope(account: ConnectedAccount | null | undefined): boolean {
  return Boolean(
    account?.scopes?.some((scope) => CALENDAR_WRITE_SCOPES.has(scope))
  )
}

function calendarDateTime(date: string, time: string) {
  return `${date}T${time}:00`
}

function buildCalendarEventInput(draft: CalendarDraft): CreateCalendarEventInput {
  return {
    summary: draft.title.trim() || "ODIN block",
    description: draft.details.trim() || undefined,
    location: draft.location.trim() || undefined,
    start: {
      dateTime: calendarDateTime(draft.date, draft.startTime),
      timeZone: CALENDAR_TIME_ZONE,
    },
    end: {
      dateTime: calendarDateTime(
        draft.date,
        addMinutesToTime(draft.startTime, Number(draft.durationMinutes) || 30)
      ),
      timeZone: CALENDAR_TIME_ZONE,
    },
  }
}

function localGoogleDateTime(date: string, time: string): string {
  const [year, month, day] = date.split("-")
  const [hour = "00", minute = "00"] = time.split(":")
  return `${year}${month}${day}T${hour.padStart(2, "0")}${minute.padStart(2, "0")}00`
}

function addMinutesToTime(time: string, minutes: number): string {
  const [rawHour, rawMinute] = time.split(":").map(Number)
  const hour = Number.isFinite(rawHour) ? rawHour : 0
  const minute = Number.isFinite(rawMinute) ? rawMinute : 0
  const total = Math.min(23 * 60 + 59, Math.max(0, hour * 60 + minute + minutes))
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

function dateLabel(date: string, view: CalendarView): string {
  const current = parseDateInput(date)
  if (view === "day") {
    return current.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })
  }
  if (view === "week") {
    const start = startOfWeek(current)
    const end = endOfWeek(current)
    return `${start.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })} – ${end.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}`
  }
  return `${MONTH_NAMES[current.getMonth()]} ${current.getFullYear()}`
}

function monthCells(date: Date): DayCell[] {
  const monthStart = startOfMonth(date)
  const first = startOfWeek(monthStart)
  const last = endOfWeek(endOfMonth(date))
  const cells: DayCell[] = []
  for (let day = first; day <= last; day = addDays(day, 1)) {
    cells.push({
      date: day,
      inMonth: day.getMonth() === date.getMonth(),
    })
  }
  return cells
}

function miniMonthCells(date: Date): DayCell[] {
  const cells = monthCells(date)
  return cells.length > 35 ? cells.slice(0, 35) : cells
}

function visibleHourRange(events: EnrichedEvent[]) {
  const timedEvents = events
    .filter((event) => !isAllDay(event))
    .map((event) => ({
      start: eventStart(event),
      end: eventEnd(event),
    }))
    .filter((event): event is { start: Date; end: Date | null } => Boolean(event.start))

  if (!timedEvents.length) {
    return { startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR }
  }

  const earliest = Math.min(...timedEvents.map((event) => event.start.getHours()))
  const latest = Math.max(
    ...timedEvents.map((event) => {
      const end = event.end ?? new Date(event.start.getTime() + 60 * 60 * 1000)
      return end.getHours() + (end.getMinutes() > 0 ? 1 : 0)
    })
  )
  return {
    startHour: Math.max(0, Math.min(DEFAULT_START_HOUR, earliest)),
    endHour: Math.min(24, Math.max(DEFAULT_END_HOUR, latest + 1)),
  }
}

function timeRows(startHour: number, endHour: number) {
  return Array.from({ length: endHour - startHour }, (_, index) => startHour + index)
}

function formatHour(hour: number): string {
  const suffix = hour >= 12 ? "PM" : "AM"
  const display = ((hour + 11) % 12) + 1
  return `${display} ${suffix}`
}

function formatTimeOption(time: string): string {
  const [rawHour, rawMinute] = time.split(":").map(Number)
  const hour = Number.isFinite(rawHour) ? rawHour : 0
  const minute = Number.isFinite(rawMinute) ? rawMinute : 0
  const suffix = hour >= 12 ? "PM" : "AM"
  const display = ((hour + 11) % 12) + 1
  return `${display}:${String(minute).padStart(2, "0")} ${suffix}`
}

function timeOptions() {
  const options: string[] = []
  for (let minutes = 5 * 60; minutes <= 23 * 60; minutes += 30) {
    options.push(
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
        minutes % 60
      ).padStart(2, "0")}`
    )
  }
  return options
}

function defaultDraft(date: string, accountId: string): CalendarDraft {
  return {
    title: "ODIN block",
    date,
    startTime: "10:00",
    durationMinutes: "30",
    accountId,
    location: "",
    details: "",
  }
}

function eventsForDay(events: EnrichedEvent[], day: Date): EnrichedEvent[] {
  return events
    .filter((event) => {
      const start = eventStart(event)
      return start ? sameDay(start, day) : false
    })
    .sort((a, b) => {
      const aStart = eventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER
      const bStart = eventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER
      return aStart - bStart
    })
}

function NewEventDialog({
  open,
  draft,
  accounts,
  canWrite,
  busy,
  error,
  onClose,
  onChange,
  onSubmit,
  onReconnect,
}: {
  open: boolean
  draft: CalendarDraft
  accounts: ConnectedAccount[]
  canWrite: boolean
  busy: boolean
  error: string | null
  onClose: () => void
  onChange: (draft: CalendarDraft) => void
  onSubmit: () => void
  onReconnect: () => void
}) {
  if (!open) return null
  const update = (patch: Partial<CalendarDraft>) => onChange({ ...draft, ...patch })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#2a1b11]/25 p-6 backdrop-blur-sm">
      <div className="odin-light-card w-full max-w-xl rounded-3xl bg-[#fffaf1] p-6 shadow-[0_30px_80px_rgba(47,25,12,0.24)]">
        <div className="mb-5 flex items-start justify-between gap-5">
          <div>
            <p className="label-track text-gold">Calendar draft</p>
            <h2 className="mt-1 text-3xl font-extrabold tracking-[-0.04em]">
              New event
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-full bg-[#f4eadc] text-xl font-bold text-[#5e4532]"
            aria-label="Close new event dialog"
          >
            ×
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 md:col-span-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
              Title
            </span>
            <input
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-base font-bold"
              autoFocus
            />
          </label>

          <label className="grid gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
              Account
            </span>
            <select
              value={draft.accountId}
              onChange={(event) => update({ accountId: event.target.value })}
              className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-sm font-bold"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.accountLabel}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
              Date
            </span>
            <input
              type="date"
              value={draft.date}
              onChange={(event) => update({ date: event.target.value })}
              className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-sm font-bold"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
              Start
            </span>
            <select
              value={draft.startTime}
              onChange={(event) => update({ startTime: event.target.value })}
              className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-sm font-bold"
            >
              {timeOptions().map((time) => (
                <option key={time} value={time}>
                  {formatTimeOption(time)}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
              Duration
            </span>
            <select
              value={draft.durationMinutes}
              onChange={(event) => update({ durationMinutes: event.target.value })}
              className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-sm font-bold"
            >
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="45">45 minutes</option>
              <option value="60">1 hour</option>
              <option value="90">1.5 hours</option>
              <option value="120">2 hours</option>
            </select>
          </label>

          <label className="grid gap-2 md:col-span-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
              Location
            </span>
            <input
              value={draft.location}
              onChange={(event) => update({ location: event.target.value })}
              className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-sm"
              placeholder="Optional"
            />
          </label>

          <label className="grid gap-2 md:col-span-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
              Notes
            </span>
            <input
              value={draft.details}
              onChange={(event) => update({ details: event.target.value })}
              className="odin-light-control h-11 rounded-xl border-[#d7c29d] bg-white px-3 text-sm"
              placeholder="Optional"
            />
          </label>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[310px] text-xs font-semibold text-tertiary">
            {canWrite
              ? "Creates directly on the selected Google Calendar."
              : "Reconnect Google Calendar once to let ODIN create events directly."}
          </p>
          <div className="flex flex-wrap gap-2">
            {!canWrite && (
              <button
                type="button"
                onClick={onReconnect}
                className="odin-light-action h-11 px-5 text-sm"
              >
                <RefreshCw size={13} />
                Reconnect
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="odin-light-action h-11 px-5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={busy}
              className="odin-light-action odin-light-action-primary h-11 px-5 text-sm disabled:opacity-50"
            >
              {busy ? <RefreshCw size={13} className="animate-spin" /> : <ExternalLink size={13} />}
              {canWrite ? "Create Event" : "Open Draft"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

function EventBlock({
  event,
  startHour,
  endHour,
}: {
  event: EnrichedEvent
  startHour: number
  endHour: number
}) {
  const start = eventStart(event)
  const end = eventEnd(event)
  const palette = paletteFor(event)
  const hourCount = endHour - startHour
  const dayStart = startHour * 60
  const dayEnd = endHour * 60
  const startMinutes = start ? Math.max(dayStart, eventMinutes(start)) : dayStart
  const endMinutes = end ? Math.min(dayEnd, eventMinutes(end)) : startMinutes + 60
  const top = isAllDay(event)
    ? 0
    : ((startMinutes - dayStart) / (hourCount * 60)) * 100
  const height = isAllDay(event)
    ? 4.6
    : Math.max(3.8, ((Math.max(endMinutes, startMinutes + 30) - startMinutes) / (hourCount * 60)) * 100)
  const style: CSSProperties = {
    top: `${top}%`,
    height: `${height}%`,
    minHeight: 34,
    background: palette.bg,
    borderColor: palette.border,
    color: palette.text,
  }

  const content = (
    <>
      <strong className="block truncate text-[12px] font-extrabold">
        {event.summary ?? "Untitled event"}
      </strong>
      <span className="mt-0.5 block truncate text-[11px] font-medium">
        {timeLabel(event)}
      </span>
    </>
  )

  if (event.htmlLink) {
    return (
      <a
        href={event.htmlLink}
        target="_blank"
        rel="noreferrer"
        className="absolute left-2 right-2 overflow-hidden rounded-lg border px-3 py-2 text-left shadow-[0_8px_18px_rgba(54,28,12,0.05)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_24px_rgba(54,28,12,0.09)]"
        style={style}
      >
        {content}
      </a>
    )
  }

  return (
    <div
      className="absolute left-2 right-2 overflow-hidden rounded-lg border px-3 py-2 text-left shadow-[0_8px_18px_rgba(54,28,12,0.05)]"
      style={style}
    >
      {content}
    </div>
  )
}

function WeekView({
  date,
  events,
  selectedDate,
  onSelectDate,
  startHour,
  endHour,
}: {
  date: Date
  events: EnrichedEvent[]
  selectedDate: string
  onSelectDate: (date: string) => void
  startHour: number
  endHour: number
}) {
  const weekStart = startOfWeek(date)
  const today = new Date()
  const days = DAYS.map((day, index) => ({
    label: day,
    date: addDays(weekStart, index),
  }))

  const height = Math.max(760, (endHour - startHour) * 58)

  return (
    <div
      className="grid min-w-[980px] grid-cols-[68px_repeat(7,minmax(118px,1fr))] grid-rows-[76px_1fr] overflow-hidden"
      style={{ height }}
    >
      <div />
      {days.map(({ label, date: day }) => {
        const active = dateInputValue(day) === selectedDate
        return (
          <button
            type="button"
            key={label}
            onClick={() => onSelectDate(dateInputValue(day))}
            className="border-b border-transparent pt-3 text-center text-xs font-extrabold uppercase text-[#6c5442]"
          >
            {label}
            <span
              className={[
                "mx-auto mt-2 grid h-9 w-9 place-items-center rounded-full text-2xl font-medium normal-case",
                sameDay(day, today) || active
                  ? "bg-[#b6531c] text-[#fffaf1]"
                  : "text-[#2b1d0f]",
              ].join(" ")}
            >
              {day.getDate()}
            </span>
          </button>
        )
      })}
      <TimeColumn startHour={startHour} endHour={endHour} />
      {days.map(({ date: day }) => (
        <DayColumn
          key={dateInputValue(day)}
          date={day}
          events={eventsForDay(events, day)}
          startHour={startHour}
          endHour={endHour}
        />
      ))}
    </div>
  )
}

function DayView({
  date,
  events,
  startHour,
  endHour,
}: {
  date: Date
  events: EnrichedEvent[]
  startHour: number
  endHour: number
}) {
  const height = Math.max(760, (endHour - startHour) * 58)
  return (
    <div
      className="grid min-w-[720px] grid-cols-[78px_1fr] overflow-hidden"
      style={{ height }}
    >
      <TimeColumn startHour={startHour} endHour={endHour} />
      <DayColumn
        date={date}
        events={eventsForDay(events, date)}
        startHour={startHour}
        endHour={endHour}
      />
    </div>
  )
}

function TimeColumn({
  startHour,
  endHour,
}: {
  startHour: number
  endHour: number
}) {
  const hourCount = endHour - startHour
  return (
    <div className="relative border-t border-[#efe2d1]">
      {timeRows(startHour, endHour).map((hour, index) => (
        <div
          key={hour}
          className="absolute right-3 -translate-y-1/2 text-right text-[13px] text-[#7e6550]"
          style={{ top: `${(index / hourCount) * 100}%` }}
        >
          {formatHour(hour)}
        </div>
      ))}
    </div>
  )
}

function DayColumn({
  date,
  events,
  startHour,
  endHour,
}: {
  date: Date
  events: EnrichedEvent[]
  startHour: number
  endHour: number
}) {
  const hourCount = endHour - startHour
  return (
    <div
      className="relative border-l border-t border-[#efe2d1] bg-[linear-gradient(to_bottom,transparent_0,transparent_calc(100%/14-1px),#efe2d1_calc(100%/14-1px),#efe2d1_calc(100%/14))]"
      style={{ backgroundSize: `100% ${100 / hourCount}%` }}
      title={date.toLocaleDateString()}
    >
      {events.map((event) => (
        <EventBlock
          key={`${event.sourceAccountId}:${event.id}`}
          event={event}
          startHour={startHour}
          endHour={endHour}
        />
      ))}
    </div>
  )
}

function MonthView({
  date,
  events,
  selectedDate,
  onSelectDate,
}: {
  date: Date
  events: EnrichedEvent[]
  selectedDate: string
  onSelectDate: (date: string) => void
}) {
  const today = new Date()
  const cells = monthCells(date)
  return (
    <div className="grid min-h-[760px] min-w-[980px] grid-cols-7 overflow-hidden">
      {DAYS.map((day) => (
        <div
          key={day}
          className="border-b border-[#efe2d1] py-4 text-center text-xs font-extrabold uppercase text-[#7a614c]"
        >
          {day}
        </div>
      ))}
      {cells.map((cell) => {
        const dayEvents = eventsForDay(events, cell.date)
        const active = dateInputValue(cell.date) === selectedDate
        return (
          <button
            type="button"
            key={dateInputValue(cell.date)}
            onClick={() => onSelectDate(dateInputValue(cell.date))}
            className="min-h-[122px] border-b border-r border-[#efe2d1] p-3 text-left align-top transition hover:bg-[#fffaf1]"
          >
            <span
              className={[
                "mb-2 grid h-8 w-8 place-items-center rounded-full text-lg font-semibold",
                sameDay(cell.date, today) || active
                  ? "bg-[#b6531c] text-[#fffaf1]"
                  : cell.inMonth
                    ? "text-[#2b1d0f]"
                    : "text-[#b7a18b]",
              ].join(" ")}
            >
              {cell.date.getDate()}
            </span>
            <span className="grid gap-1">
              {dayEvents.slice(0, 3).map((event) => {
                const palette = paletteFor(event)
                return (
                  <span
                    key={`${event.sourceAccountId}:${event.id}`}
                    className="truncate rounded-md border px-2 py-1 text-[11px] font-bold"
                    style={{
                      background: palette.bg,
                      borderColor: palette.border,
                      color: palette.text,
                    }}
                  >
                    {event.summary ?? "Untitled event"}
                  </span>
                )
              })}
              {dayEvents.length > 3 && (
                <span className="text-[11px] font-semibold text-[#8a7058]">
                  +{dayEvents.length - 3} more
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function MiniCalendar({
  date,
  selectedDate,
  onSelectDate,
}: {
  date: Date
  selectedDate: string
  onSelectDate: (date: string) => void
}) {
  const cells = miniMonthCells(date)
  const today = new Date()
  return (
    <div>
      <div className="mb-6 flex items-center justify-between text-xl font-extrabold">
        <span>
          {MONTH_NAMES[date.getMonth()]} {date.getFullYear()}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-3 text-center text-sm">
        {DAYS.map((day) => (
          <span
            key={day}
            className="text-[11px] font-extrabold uppercase text-[#8b7058]"
          >
            {day}
          </span>
        ))}
        {cells.map((cell) => {
          const value = dateInputValue(cell.date)
          const active = value === selectedDate
          return (
            <button
              key={value}
              type="button"
              onClick={() => onSelectDate(value)}
              className={[
                "mx-auto grid h-7 w-7 place-items-center rounded-full text-sm font-medium",
                active || sameDay(cell.date, today)
                  ? "bg-[#b6531c] text-[#fffaf1]"
                  : cell.inMonth
                    ? "text-[#2b1d0f]"
                    : "text-[#b7a18b]",
              ].join(" ")}
            >
              {cell.date.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function CalendarPage() {
  const { google, loading: accountsLoading } = useConnectedAccounts()
  const [selectedDate, setSelectedDate] = useState(localDate)
  const [selectedAccountId, setSelectedAccountId] = useState("all")
  const [view, setView] = useState<CalendarView>("week")
  const [newEventOpen, setNewEventOpen] = useState(false)
  const [eventDraft, setEventDraft] = useState<CalendarDraft>(() =>
    defaultDraft(localDate(), "")
  )
  const [rows, setRows] = useState<CalendarRow[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [reconnectError, setReconnectError] = useState<string | null>(null)
  const [calendarNotice, setCalendarNotice] = useState<string | null>(null)
  const [eventError, setEventError] = useState<string | null>(null)
  const [eventBusy, setEventBusy] = useState(false)

  const scanAccounts = useMemo(
    () =>
      selectedAccountId === "all"
        ? google
        : google.filter((account) => account.id === selectedAccountId),
    [google, selectedAccountId]
  )

  const range = useMemo(() => rangeForView(selectedDate, view), [selectedDate, view])

  useEffect(() => {
    if (
      selectedAccountId !== "all" &&
      !google.some((account) => account.id === selectedAccountId)
    ) {
      setSelectedAccountId("all")
    }
  }, [google, selectedAccountId])

  useEffect(() => {
    const fallbackAccountId =
      selectedAccountId !== "all" && google.some((account) => account.id === selectedAccountId)
        ? selectedAccountId
        : google[0]?.id ?? ""
    setEventDraft((draft) => ({
      ...draft,
      date: draft.date || selectedDate,
      accountId: google.some((account) => account.id === draft.accountId)
        ? draft.accountId
        : fallbackAccountId,
    }))
  }, [google, selectedAccountId, selectedDate])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "calendar")) return
      setRefreshKey((value) => value + 1)
      setCalendarNotice("Live Scan refreshed calendar sources.")
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (scanAccounts.length === 0) {
        setRows([])
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const next = await Promise.all(
          scanAccounts.map(async (account) => {
            const [eventsResult, calendarsResult] = await Promise.all([
              rangeEvents(range.start.toISOString(), range.end.toISOString(), account.id, 120),
              listCalendars(account.id),
            ])
            return {
              account,
              events: eventsResult.data?.items ?? [],
              calendars: calendarsResult.data?.items ?? [],
              error: eventsResult.error,
              calendarError: calendarsResult.error,
            }
          })
        )
        if (cancelled) return
        setRows(next)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [scanAccounts, range.start, range.end, refreshKey])

  const events = rows
    .flatMap((row) =>
      row.events.map<EnrichedEvent>((event) => ({
        ...event,
        sourceAccountLabel: row.account.accountLabel,
        sourceAccountEmail: row.account.accountEmail,
        sourceAccountId: row.account.id,
      }))
    )
    .sort((a, b) => {
      const aStart = eventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER
      const bStart = eventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER
      return aStart - bStart
    })

  const selectedDateObject = parseDateInput(selectedDate)
  const firstAccount = selectedAccountId === "all" ? google[0] : scanAccounts[0]
  const selectedDraftAccount =
    google.find((account) => account.id === eventDraft.accountId) ?? firstAccount
  const selectedDraftAccountCanWrite = hasCalendarWriteScope(selectedDraftAccount)
  const hourRange = visibleHourRange(events)
  const selectedCalendarCount = rows.reduce(
    (total, row) =>
      total +
      row.calendars.filter((calendar) => calendar.selected !== false).length,
    0
  )
  const visibleCalendars = rows.flatMap((row) =>
    row.calendars
      .filter((calendar) => calendar.selected !== false)
      .map((calendar) => ({
        ...calendar,
        accountId: row.account.id,
        accountLabel: row.account.accountLabel,
      }))
  )

  const hasCalendarDiagnostics = rows.some(
    (row) => row.calendars.length > 0 || row.calendarError
  )
  const calendarHydrating = google.length > 0 && loading && rows.length === 0

  const handleReconnectCalendar = async () => {
    setReconnectError(null)
    setEventError(null)
    try {
      await connectGoogle({
        label: "Google Calendar",
        mode: "add",
        redirectTo: odinRouteUrl("/calendar"),
      })
    } catch (err) {
      setReconnectError(
        err instanceof Error ? err.message : "Could not start Google reconnect."
      )
    }
  }

  const shiftDate = (direction: -1 | 1) => {
    const current = parseDateInput(selectedDate)
    const next =
      view === "day"
        ? addDays(current, direction)
        : view === "week"
          ? addDays(current, direction * 7)
          : addMonths(current, direction)
    setSelectedDate(dateInputValue(next))
  }

  const openNewEvent = () => {
    const accountId =
      selectedAccountId !== "all" && google.some((account) => account.id === selectedAccountId)
        ? selectedAccountId
        : google[0]?.id ?? ""
    setEventDraft(defaultDraft(selectedDate, accountId))
    setEventError(null)
    setCalendarNotice(null)
    setNewEventOpen(true)
  }

  const submitNewEvent = async () => {
    const account =
      google.find((item) => item.id === eventDraft.accountId) ?? firstAccount
    if (!account) return

    setEventError(null)
    setCalendarNotice(null)

    if (!hasCalendarWriteScope(account)) {
      const url = googleCreateEventDraftUrl(eventDraft, account.accountEmail)
      window.open(url, "_blank", "noopener,noreferrer")
      setCalendarNotice(
        "Opened a Google Calendar draft. Reconnect Google Calendar once so ODIN can create events directly."
      )
      setNewEventOpen(false)
      return
    }

    setEventBusy(true)
    const result = await createEvent(buildCalendarEventInput(eventDraft), account.id)
    setEventBusy(false)

    if (result.error) {
      const url = googleCreateEventDraftUrl(eventDraft, account.accountEmail)
      window.open(url, "_blank", "noopener,noreferrer")
      setEventError(
        `${result.error.message} I opened a Google draft so you can still add it now.`
      )
      return
    }

    setCalendarNotice("Event created on Google Calendar.")
    setSelectedDate(eventDraft.date)
    setRefreshKey((value) => value + 1)
    setNewEventOpen(false)
  }

  return (
    <LightPageShell>
      <LightPageHeader
        title="Calendar"
        subtitle="Live Google events"
        action={
          firstAccount ? (
            <a
              href={googleCalendarUrl(selectedDate, firstAccount.accountEmail)}
              target="_blank"
              rel="noreferrer"
              className="odin-light-action odin-light-action-primary px-7 py-4 text-lg"
            >
              <ExternalLink size={14} />
              Open Google Calendar
            </a>
          ) : null
        }
      />

      <div className="odin-light-card mb-7 grid grid-cols-1 gap-5 rounded-3xl px-8 py-6 xl:grid-cols-[1fr_280px_1fr_120px_132px_104px]">
        <label className="grid gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
            Account
          </span>
          <select
            value={selectedAccountId}
            onChange={(event) => setSelectedAccountId(event.target.value)}
            className="odin-light-control h-11 w-full px-0 text-xl font-bold"
          >
            <option value="all">All Google accounts</option>
            {google.map((account) => (
              <option key={account.id} value={account.id}>
                {account.accountLabel} · {account.accountEmail}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
            View
          </span>
          <div className="grid h-11 grid-cols-3 rounded-xl border border-[#eadcc6] bg-[#f4eadc] p-1">
            {(["day", "week", "month"] as const).map((item) => (
              <button
                type="button"
                key={item}
                onClick={() => setView(item)}
                className={[
                  "rounded-lg text-sm font-bold capitalize transition",
                  view === item
                    ? "bg-[#fffaf1] text-[#2b1d0f] shadow-sm"
                    : "text-[#7c614b] hover:bg-[#fffaf1]/50",
                ].join(" ")}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        <label className="grid gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-tertiary">
            Date
          </span>
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
            className="odin-light-control h-11 w-full px-0 text-xl font-bold"
          />
        </label>

        <button
          type="button"
          onClick={openNewEvent}
          disabled={!firstAccount}
          className="odin-light-action mt-auto h-11 px-4 text-sm disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus size={14} />
          Event
        </button>

        <button
          type="button"
          onClick={() => {
            setSelectedDate(localDate())
            setRefreshKey((value) => value + 1)
          }}
          disabled={loading}
          className="odin-light-action mt-auto h-11 px-5 text-sm disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          {loading ? "Loading" : "Today"}
        </button>

        <div className="mt-auto flex gap-2">
          <button
            type="button"
            onClick={() => shiftDate(-1)}
            className="odin-light-action h-11 w-11"
            aria-label="Previous date range"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => shiftDate(1)}
            className="odin-light-action h-11 w-11"
            aria-label="Next date range"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {reconnectError && (
        <div className="mb-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {reconnectError}
        </div>
      )}

      {calendarNotice && (
        <div className="mb-4 rounded-2xl border border-[#d8c49f] bg-[#fff8e8] px-4 py-3 text-sm font-semibold text-[#7a5534]">
          {calendarNotice}
        </div>
      )}

      {calendarHydrating && (
        <div className="mb-5 rounded-3xl border border-[#dfcfb1] bg-[#fff9ef]/80 p-5 shadow-[0_12px_34px_rgba(82,47,18,0.08)]">
          <div className="flex items-center gap-3 text-sm font-bold text-[#7a5534]">
            <RefreshCw size={15} className="animate-spin text-[#bd5a18]" />
            Reading Google Calendar...
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <div key={item} className="rounded-2xl border border-[#eadcc6] bg-white/55 p-4">
                <div className="h-3 w-20 rounded-full bg-[#ead9bd]" />
                <div className="mt-4 h-5 w-32 rounded-full bg-[#dfcfb1]" />
                <div className="mt-3 h-3 w-24 rounded-full bg-[#ead9bd]" />
              </div>
            ))}
          </div>
        </div>
      )}

      {accountsLoading ? (
        <div className="odin-light-card rounded-3xl p-8 text-sm text-tertiary">
          Loading connected calendars...
        </div>
      ) : google.length === 0 ? (
        <div className="odin-light-card rounded-3xl p-10 text-center">
          <p className="text-sm text-foreground/60">
            Connect Google in Ravens to show live Calendar events.
          </p>
        </div>
      ) : (
        <section className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="odin-light-card rounded-3xl p-6">
            <MiniCalendar
              date={selectedDateObject}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />

            <div className="mt-8 border-t border-[#eadcc6] pt-7">
              <div className="mb-5 flex items-center justify-between text-lg font-extrabold">
                <span>My calendars</span>
                <CalendarDays size={17} className="text-[#9b815e]" />
              </div>
              <div className="grid gap-4">
                {visibleCalendars.length === 0 && loading ? (
                  <p className="text-xs font-medium text-tertiary">
                    Reading visible calendars...
                  </p>
                ) : visibleCalendars.length === 0 ? (
                  <p className="text-xs font-medium text-tertiary">
                    No visible calendars returned yet.
                  </p>
                ) : (
                  visibleCalendars.slice(0, 8).map((calendar) => {
                    const palette = EVENT_PALETTES[
                      hashString(calendar.id) % EVENT_PALETTES.length
                    ]
                    return (
                      <div
                        key={`${calendar.accountId}:${calendar.id}`}
                        className="grid grid-cols-[22px_1fr_20px] items-center gap-3 text-sm font-bold text-[#4b3628]"
                        title={`${calendar.accountLabel} · ${calendar.id}`}
                      >
                        <span
                          className="grid h-[18px] w-[18px] place-items-center rounded-[5px] text-[11px] text-white"
                          style={{ background: palette.text }}
                        >
                          ✓
                        </span>
                        <span className="truncate">
                          {calendar.summary}
                          {calendar.primary ? " · primary" : ""}
                        </span>
                        <span className="text-[#8b7058]">⋯</span>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </aside>

          <section className="odin-light-card overflow-hidden rounded-3xl p-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="label-track text-gold">
                  {view} schedule
                  <span className="ml-2 text-sm normal-case tracking-normal text-tertiary">
                    · {dateLabel(selectedDate, view)}
                  </span>
                </p>
                <p className="mt-1 text-xs font-medium text-tertiary">
                  {loading
                    ? "Refreshing Google Calendar..."
                    : `${events.length} event${events.length === 1 ? "" : "s"} from ${
                        selectedCalendarCount || "visible"
                      } calendar${selectedCalendarCount === 1 ? "" : "s"}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRefreshKey((value) => value + 1)}
                disabled={loading}
                className="odin-light-action h-10 px-4 text-xs disabled:opacity-50"
              >
                <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
                Live
              </button>
            </div>

            <div className="overflow-auto rounded-2xl">
              {view === "day" ? (
                <DayView
                  date={selectedDateObject}
                  events={events}
                  startHour={hourRange.startHour}
                  endHour={hourRange.endHour}
                />
              ) : view === "week" ? (
                <WeekView
                  date={selectedDateObject}
                  events={events}
                  selectedDate={selectedDate}
                  onSelectDate={setSelectedDate}
                  startHour={hourRange.startHour}
                  endHour={hourRange.endHour}
                />
              ) : (
                <MonthView
                  date={selectedDateObject}
                  events={events}
                  selectedDate={selectedDate}
                  onSelectDate={setSelectedDate}
                />
              )}
            </div>
          </section>
        </section>
      )}

      {google.length > 0 && (
        <div className="mt-10">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="label-track text-gold">
                Calendar Diagnostics
                <span className="ml-2 text-sm normal-case tracking-normal text-tertiary">
                  · live evidence from Google Calendar
                </span>
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Each connected account is checked independently so ODIN can
                distinguish stale data from an actually quiet day.
              </p>
            </div>
            <button
              type="button"
              onClick={handleReconnectCalendar}
              className="odin-light-action px-5 py-3 text-sm"
            >
              <RefreshCw size={13} />
              Reconnect Google Calendar
            </button>
          </div>

          <div className="mt-4 grid gap-3">
            {loading && !hasCalendarDiagnostics ? (
              <p className="text-xs text-tertiary">
                Loading calendar diagnostics...
              </p>
            ) : (
              rows.map((row) => {
                const visible = row.calendars.filter(
                  (calendar) => calendar.selected !== false
                )
                return (
                  <div
                    key={row.account.id}
                    className="odin-light-card rounded-3xl p-6"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {row.account.accountLabel}
                        </p>
                        <p className="text-xs text-tertiary">
                          {row.account.accountEmail}
                        </p>
                      </div>
                      <div className="text-right font-mono-data text-[11px] text-tertiary">
                        <p>
                          {row.events.length} event(s) in {view} range
                        </p>
                        <p>
                          {visible.length} visible / {row.calendars.length}{" "}
                          total calendars
                        </p>
                      </div>
                    </div>

                    {row.error && (
                      <p className="mt-2 rounded border border-warning/25 bg-warning/10 px-2 py-1 text-[11px] text-warning">
                        Events error: {row.error.message}
                      </p>
                    )}
                    {row.calendarError && (
                      <p className="mt-2 rounded border border-warning/25 bg-warning/10 px-2 py-1 text-[11px] text-warning">
                        Calendar list error: {row.calendarError.message}
                      </p>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      <NewEventDialog
        open={newEventOpen}
        draft={eventDraft}
        accounts={google}
        canWrite={selectedDraftAccountCanWrite}
        busy={eventBusy}
        error={eventError}
        onClose={() => setNewEventOpen(false)}
        onChange={setEventDraft}
        onSubmit={submitNewEvent}
        onReconnect={handleReconnectCalendar}
      />
    </LightPageShell>
  )
}

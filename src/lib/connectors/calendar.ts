import { invokeProxy } from "@/lib/connectors/proxy"

const FN = "calendar-proxy"

export interface CalendarEvent {
  id: string
  summary?: string
  description?: string
  location?: string
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  hangoutLink?: string
  htmlLink?: string
  attendees?: Array<{
    email: string
    displayName?: string
    responseStatus?: string
  }>
  organizer?: { email?: string; displayName?: string }
  status?: string
  sourceAccountId?: string
  sourceAccountLabel?: string
  sourceCalendarId?: string
  sourceCalendarSummary?: string
}

export interface CalendarEventsResponse {
  items?: CalendarEvent[]
  nextPageToken?: string
}

export interface CalendarListEntry {
  id: string
  summary: string
  primary?: boolean
  selected?: boolean
  timeZone?: string
}

export interface CalendarListResponse {
  items?: CalendarListEntry[]
}

export interface CalendarEventDateTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

export interface CreateCalendarEventInput {
  calendarId?: string
  summary: string
  description?: string
  location?: string
  start: CalendarEventDateTime
  end: CalendarEventDateTime
}

export function todayEvents(timezone?: string, accountId?: string | null) {
  return invokeProxy<CalendarEventsResponse>(
    FN,
    "today_events",
    { timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone },
    accountId ?? null
  )
}

export function rangeEvents(
  timeMin: string,
  timeMax: string,
  accountId?: string | null,
  maxResults = 25
) {
  return invokeProxy<CalendarEventsResponse>(
    FN,
    "range_events",
    { timeMin, timeMax, maxResults },
    accountId ?? null
  )
}

export function listCalendars(accountId?: string | null) {
  return invokeProxy<CalendarListResponse>(FN, "list_calendars", {}, accountId ?? null)
}

export function createEvent(input: CreateCalendarEventInput, accountId?: string | null) {
  return invokeProxy<CalendarEvent>(FN, "create_event", { ...input }, accountId ?? null)
}

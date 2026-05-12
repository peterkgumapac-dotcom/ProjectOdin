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
}

export interface CalendarEventsResponse {
  items?: CalendarEvent[]
  nextPageToken?: string
}

export interface CalendarListEntry {
  id: string
  summary: string
  primary?: boolean
  timeZone?: string
}

export interface CalendarListResponse {
  items?: CalendarListEntry[]
}

export function todayEvents(timezone?: string) {
  return invokeProxy<CalendarEventsResponse>(FN, "today_events", {
    timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

export function rangeEvents(timeMin: string, timeMax: string) {
  return invokeProxy<CalendarEventsResponse>(FN, "range_events", { timeMin, timeMax })
}

export function listCalendars() {
  return invokeProxy<CalendarListResponse>(FN, "list_calendars")
}

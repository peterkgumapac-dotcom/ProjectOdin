// Edge Function: calendar-proxy
// JWT-required. Routes Google Calendar API actions, scoped to a specific
// connected Google account via optional `account_id` in the body.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { googleFetchJson } from "../_shared/google.ts"

const BASE = "https://www.googleapis.com/calendar/v3"
const DEFAULT_CAL = "primary"

interface RangeParams {
  calendarId?: string
  timeMin: string
  timeMax: string
  maxResults?: number
}

interface TodayParams {
  calendarId?: string
  timezone?: string
}

interface CalendarDateTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

interface CreateEventParams {
  calendarId?: string
  summary?: string
  description?: string
  location?: string
  start?: CalendarDateTime
  end?: CalendarDateTime
}

interface ActionBody {
  action: string
  account_id?: string | null
  params?: Record<string, unknown>
}

class HttpError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function startOfTodayIso(timezone?: string): { min: string; max: string } {
  const now = new Date()
  if (!timezone) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    return { min: start.toISOString(), max: end.toISOString() }
  }
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const localDate = fmt.format(now)
  const offset = timezone === "Asia/Manila" ? "+08:00" : "Z"
  const min = new Date(`${localDate}T00:00:00.000${offset}`).toISOString()
  const max = new Date(`${localDate}T23:59:59.999${offset}`).toISOString()
  return { min, max }
}

async function listEvents(
  userId: string,
  accountId: string | null,
  params: RangeParams
) {
  const calId = params.calendarId ?? DEFAULT_CAL
  const qs = new URLSearchParams({
    timeMin: params.timeMin,
    timeMax: params.timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(params.maxResults ?? 25),
  })
  return googleFetchJson(
    userId,
    `${BASE}/calendars/${encodeURIComponent(calId)}/events?${qs.toString()}`,
    {},
    accountId
  )
}

async function todayEvents(
  userId: string,
  accountId: string | null,
  params: TodayParams
) {
  const { min, max } = startOfTodayIso(params.timezone)
  return listEvents(userId, accountId, {
    calendarId: params.calendarId,
    timeMin: min,
    timeMax: max,
  })
}

async function listCalendars(userId: string, accountId: string | null) {
  return googleFetchJson(userId, `${BASE}/users/me/calendarList`, {}, accountId)
}

function hasDateValue(value: CalendarDateTime | undefined): value is CalendarDateTime {
  return Boolean(value?.date || value?.dateTime)
}

function validateCreateEventParams(params: CreateEventParams) {
  const summary = params.summary?.trim()
  if (!summary) throw new HttpError("Event title is required.", 400)
  if (!hasDateValue(params.start)) {
    throw new HttpError("Event start time is required.", 400)
  }
  if (!hasDateValue(params.end)) {
    throw new HttpError("Event end time is required.", 400)
  }

  return {
    calendarId: params.calendarId?.trim() || DEFAULT_CAL,
    event: {
      summary,
      ...(params.description?.trim()
        ? { description: params.description.trim() }
        : {}),
      ...(params.location?.trim() ? { location: params.location.trim() } : {}),
      start: params.start,
      end: params.end,
    },
  }
}

async function createEvent(
  userId: string,
  accountId: string | null,
  params: CreateEventParams
) {
  const { calendarId, event } = validateCreateEventParams(params)
  return googleFetchJson(
    userId,
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      body: JSON.stringify(event),
    },
    accountId
  )
}

async function listAllVisibleEvents(
  userId: string,
  accountId: string | null,
  params: RangeParams
) {
  const calendars = await listCalendars(userId, accountId) as {
    items?: Array<{ id: string; summary?: string; selected?: boolean; primary?: boolean }>
  }
  const visible = (calendars.items ?? [])
    .filter((calendar) => calendar.selected !== false)
    .slice(0, 10)

  const results = await Promise.all(
    visible.map(async (calendar) => {
      try {
        const data = await listEvents(userId, accountId, {
          ...params,
          calendarId: calendar.id,
          maxResults: Math.min(params.maxResults ?? 25, 20),
        }) as { items?: unknown[] }
        return (data.items ?? []).map((event) => ({
          ...(event as Record<string, unknown>),
          sourceCalendarId: calendar.id,
          sourceCalendarSummary: calendar.summary,
        }))
      } catch (err) {
        console.error(
          "[calendar-proxy] visible calendar failed",
          calendar.id,
          err instanceof Error ? err.message : err
        )
        return []
      }
    })
  )

  const items = results
    .flat()
    .sort((a, b) => {
      const aStart = ((a.start as { dateTime?: string; date?: string } | undefined)?.dateTime ??
        (a.start as { dateTime?: string; date?: string } | undefined)?.date ??
        "") as string
      const bStart = ((b.start as { dateTime?: string; date?: string } | undefined)?.dateTime ??
        (b.start as { dateTime?: string; date?: string } | undefined)?.date ??
        "") as string
      return aStart.localeCompare(bStart)
    })
    .slice(0, params.maxResults ?? 25)

  return {
    kind: "calendar#events",
    summary: "All visible calendars",
    items,
    calendarsScanned: visible.length,
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  const userId = await getCallerUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)

  let body: ActionBody
  try {
    body = (await req.json()) as ActionBody
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }
  const action = body.action
  const accountId = body.account_id ?? null
  const params = body.params ?? {}

  try {
    switch (action) {
      case "today_events":
        return jsonResponse({
          data: await todayEvents(userId, accountId, params as TodayParams),
        })
      case "range_events":
        return jsonResponse({
          data: (params as RangeParams).calendarId
            ? await listEvents(userId, accountId, params as RangeParams)
            : await listAllVisibleEvents(userId, accountId, params as RangeParams),
        })
      case "list_calendars":
        return jsonResponse({ data: await listCalendars(userId, accountId) })
      case "create_event":
        return jsonResponse({
          data: await createEvent(userId, accountId, params as CreateEventParams),
        })
      case "update_event":
      case "delete_event":
      case "respond_to_invite":
        return jsonResponse(
          {
            error:
              "Write action requires the calendar (read+write) scope. Expand the Google consent screen + reconnect Google.",
          },
          403
        )
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    const status =
      err instanceof HttpError
        ? err.status
        : /Google API 403|insufficient authentication scopes|insufficientPermissions/i.test(
              message
            )
          ? 403
          : 502
    console.error("[calendar-proxy]", message)
    return jsonResponse(
      {
        error:
          status === 403
            ? "Calendar write access is not granted yet. Reconnect Google Calendar once, then try again."
            : message,
      },
      status
    )
  }
})

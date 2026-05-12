// Edge Function: calendar-proxy
// JWT-required. Routes Google Calendar API actions.
// v1 ships read scope only — write actions return 403 until consent expands.

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

interface ActionBody {
  action: string
  params?: Record<string, unknown>
}

function startOfTodayIso(timezone?: string): { min: string; max: string } {
  // Use UTC start/end of the day if no timezone supplied; rely on the user's
  // device timezone otherwise (passed through from the browser).
  const now = new Date()
  if (!timezone) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    return { min: start.toISOString(), max: end.toISOString() }
  }
  // Naive approach: compute now's local date string in the tz, then build ISO bounds.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const localDate = fmt.format(now)
  const min = new Date(`${localDate}T00:00:00`).toISOString()
  const max = new Date(`${localDate}T23:59:59.999`).toISOString()
  return { min, max }
}

async function listEvents(userId: string, params: RangeParams) {
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
    `${BASE}/calendars/${encodeURIComponent(calId)}/events?${qs.toString()}`
  )
}

async function todayEvents(userId: string, params: TodayParams) {
  const { min, max } = startOfTodayIso(params.timezone)
  return listEvents(userId, {
    calendarId: params.calendarId,
    timeMin: min,
    timeMax: max,
  })
}

async function listCalendars(userId: string) {
  return googleFetchJson(userId, `${BASE}/users/me/calendarList`)
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
  const params = body.params ?? {}

  try {
    switch (action) {
      case "today_events":
        return jsonResponse({ data: await todayEvents(userId, params as TodayParams) })
      case "range_events":
        return jsonResponse({ data: await listEvents(userId, params as RangeParams) })
      case "list_calendars":
        return jsonResponse({ data: await listCalendars(userId) })
      case "create_event":
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
    console.error("[calendar-proxy]", message)
    return jsonResponse({ error: message }, 502)
  }
})

import { supabase } from "@/lib/supabaseClient"
import { odinRouteUrl } from "@/lib/desktopRoute"
import { invokeProxy } from "@/lib/connectors/proxy"

export const WITHINGS_PROVIDER = "withings"

interface OAuthStartResponse {
  data?: { url: string; state: string }
  error?: string
}

export interface StartWithingsOptions {
  label?: string
  redirectTo?: string
}

export interface WithingsHealthSummary {
  ok: boolean
  error?: string
  needsReconnect?: boolean
  warnings?: string[]
  endpoints?: Array<{
    name: "activity" | "sleep" | "body" | "workouts"
    status: "ok" | "error"
    message?: string
  }>
  connected: boolean
  accountId?: string
  accountLabel?: string
  sleep: {
    status: "connected" | "empty" | "error"
    durationMinutes: number | null
    inBedMinutes: number | null
    wakeups: number | null
    date: string | null
  }
  steps: {
    status: "connected" | "empty" | "error"
    count: number | null
    distanceMeters: number | null
    date: string | null
  }
  calories: {
    status: "connected" | "empty" | "error"
    active: number | null
    total: number | null
    date: string | null
  }
  heartRate: {
    status: "connected" | "empty" | "error"
    bpm: number | null
    minBpm: number | null
    maxBpm: number | null
    measuredAt: string | null
  }
  body?: {
    status: "connected" | "empty" | "error"
    weightKg: WithingsMetricPoint
    heightM: WithingsMetricPoint
    bmi: WithingsMetricPoint
    fatRatioPct: WithingsMetricPoint
    fatMassKg: WithingsMetricPoint
    fatFreeMassKg: WithingsMetricPoint
    muscleMassKg: WithingsMetricPoint
    hydrationKg: WithingsMetricPoint
    boneMassKg: WithingsMetricPoint
    pulseWaveVelocity: WithingsMetricPoint
    bloodPressure: {
      status: "connected" | "empty" | "error"
      systolic: number | null
      diastolic: number | null
      measuredAt: string | null
    }
    spo2: WithingsMetricPoint
    bodyTemperatureC: WithingsMetricPoint
    skinTemperatureC: WithingsMetricPoint
    glucoseMgDl: WithingsMetricPoint
  }
  workouts?: {
    status: "connected" | "empty" | "error"
    recentCount: number
    latest: null | {
      category: number | null
      startedAt: string | null
      durationMinutes: number | null
      calories: number | null
      steps: number | null
      distanceMeters: number | null
      averageHeartRate: number | null
    }
  }
  daily?: WithingsDailyHealthPoint[]
  weekly?: WithingsWeeklyStats
  plan?: {
    status: "ready" | "needs_data"
    focus: string
    summary: string
    actionItems: string[]
    dataUsed: string[]
    caution: string
  }
}

export interface WithingsDailyHealthPoint {
  date: string
  steps: number | null
  distanceMeters: number | null
  activeCalories: number | null
  totalCalories: number | null
  sleepMinutes: number | null
  inBedMinutes: number | null
  wakeups: number | null
  averageHeartRate: number | null
  workoutCount: number
  workoutMinutes: number | null
  workoutCalories: number | null
}

export interface WithingsWeeklyStats {
  days: number
  stepsTotal: number | null
  stepsAverage: number | null
  sleepAverageMinutes: number | null
  sleepNights: number
  activeCaloriesTotal: number | null
  totalCaloriesAverage: number | null
  workoutCount: number
  workoutMinutes: number | null
  workoutCalories: number | null
}

export interface WithingsMetricPoint {
  status: "connected" | "empty" | "error"
  value: number | null
  unit: string
  measuredAt: string | null
}

export async function startWithingsConnect(
  opts: StartWithingsOptions = {}
): Promise<string> {
  const body: Record<string, unknown> = {}
  if (opts.redirectTo) body.redirect_to = opts.redirectTo
  if (opts.label) body.label = opts.label

  const { data, error } = await supabase.functions.invoke<OAuthStartResponse>(
    "oauth-start-withings",
    { body }
  )
  if (error) throw new Error(error.message)
  if (data?.error) throw new Error(data.error)
  if (!data?.data?.url) {
    throw new Error("oauth-start-withings returned no URL")
  }
  return data.data.url
}

export async function connectWithings(
  opts: StartWithingsOptions = {}
): Promise<void> {
  const here = odinRouteUrl("/dashboard")
  const url = await startWithingsConnect({
    redirectTo: here,
    label: "Withings",
    ...opts,
  })
  window.location.assign(url)
}

export async function disconnectWithings(
  userId: string,
  accountId?: string
): Promise<void> {
  let query = supabase.from("connected_accounts").delete().eq("user_id", userId)
  if (accountId) {
    query = query.eq("id", accountId)
  } else {
    query = query.eq("provider", WITHINGS_PROVIDER)
  }
  const { error } = await query
  if (error) throw new Error(error.message)
}

export async function getWithingsHealthSummary(accountId?: string | null) {
  return invokeProxy<WithingsHealthSummary>(
    "withings-proxy",
    "summary",
    {},
    accountId
  )
}

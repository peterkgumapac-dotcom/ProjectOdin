// Edge Function: withings-proxy
// JWT-required. Pulls Withings health data through the stored OAuth token.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { getProviderTokens } from "../_shared/connected_accounts.ts"
import { withingsPostJson } from "../_shared/withings.ts"

interface ActionBody {
  action: string
  account_id?: string | null
  params?: Record<string, unknown>
}

interface ActivityBody {
  activities?: Array<{
    date?: string
    steps?: number
    distance?: number
    calories?: number
    totalcalories?: number
    elevation?: number
    hr_average?: number
    hr_min?: number
    hr_max?: number
  }>
}

interface SleepBody {
  series?: Array<Record<string, unknown>>
}

interface MeasureGroupsBody {
  measuregrps?: Array<{
    date?: number
    measures?: Array<{ type?: number; value?: number; unit?: number }>
  }>
}

interface WorkoutsBody {
  series?: Array<Record<string, unknown>>
}

interface DailyHealthPoint {
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

interface EndpointStatus {
  name: "activity" | "sleep" | "body" | "workouts"
  status: "ok" | "error"
  message?: string
}

interface MetricPoint {
  status: "connected" | "empty" | "error"
  value: number | null
  unit: string
  measuredAt: string | null
}

function ymd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function dateFromYmd(value: string): Date {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function numericField(
  item: Record<string, unknown>,
  data: Record<string, unknown>,
  key: string
): number | null {
  return numberOrNull(data[key]) ?? numberOrNull(item[key])
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return a + b
}

function measureValue(measure: { value?: number; unit?: number }): number | null {
  if (typeof measure.value !== "number" || typeof measure.unit !== "number") {
    return null
  }
  return measure.value * Math.pow(10, measure.unit)
}

function endpointStatus<T>(
  name: EndpointStatus["name"],
  result: PromiseSettledResult<T>
): EndpointStatus {
  if (result.status === "fulfilled") return { name, status: "ok" }
  const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
  return { name, status: "error", message: message.slice(0, 260) }
}

async function settleEndpoint<T>(
  read: () => Promise<T>
): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await read() }
  } catch (reason) {
    return { status: "rejected", reason }
  }
}

function isReconnectRequired(message: string) {
  return /invalid refresh_token|refresh_token is available|token expired|invalid_token/i.test(message)
}

function latestActivity(
  body: ActivityBody,
  hasData: (item: NonNullable<ActivityBody["activities"]>[number]) => boolean
) {
  return [...(body.activities ?? [])]
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .find(hasData)
}

function latestSleepEntry(
  body: SleepBody,
  hasData: (entry: Record<string, unknown>, data: Record<string, unknown>) => boolean
) {
  return [...(body.series ?? [])]
    .sort((a, b) => {
      const aDate = typeof a.date === "string" ? a.date : ""
      const bDate = typeof b.date === "string" ? b.date : ""
      return bDate.localeCompare(aDate)
    })
    .find((entry) => hasData(entry, recordOrEmpty(entry.data)))
}

async function summary(userId: string, accountId: string | null) {
  const tokens = await getProviderTokens(userId, "withings", accountId)
  if (!tokens) {
    return {
      ok: true,
      connected: false,
      sleep: emptySleep(),
      steps: emptySteps(),
      calories: emptyCalories(),
      heartRate: emptyHeartRate(),
    }
  }

  const now = new Date()
  const today = startOfDay(now)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sleepStart = new Date(today)
  sleepStart.setDate(today.getDate() - 14)
  const activityStart = new Date(today)
  activityStart.setDate(today.getDate() - 14)
  const measureStart = new Date(today)
  measureStart.setDate(today.getDate() - 180)
  const workoutStart = new Date(today)
  workoutStart.setDate(today.getDate() - 30)

  const activityResult = await settleEndpoint(() =>
    withingsPostJson<ActivityBody>(
        userId,
        "/v2/measure",
        {
          action: "getactivity",
          startdateymd: ymd(activityStart),
          enddateymd: ymd(today),
          data_fields:
            "steps,distance,elevation,calories,totalcalories,hr_average,hr_min,hr_max",
        },
        tokens.id
      )
  )
  const sleepResult = await settleEndpoint(() =>
    withingsPostJson<SleepBody>(
        userId,
        "/v2/sleep",
        {
          action: "getsummary",
          startdateymd: ymd(sleepStart),
          enddateymd: ymd(today),
          data_fields:
            "total_sleep_time,durationtosleep,wakeupcount,lightsleepduration,deepsleepduration,remsleepduration,durationinbed,total_timeinbed,sleep_score,hr_average,hr_min,hr_max",
        },
        tokens.id
      )
  )
  const bodyMeasureResult = await settleEndpoint(() =>
    withingsPostJson<MeasureGroupsBody>(
        userId,
        "/measure",
        {
          action: "getmeas",
          meastypes: "1,4,5,6,8,9,10,11,54,71,73,76,77,88,91,119",
          category: 1,
          startdate: Math.floor(measureStart.getTime() / 1000),
          enddate: Math.floor(now.getTime() / 1000),
        },
        tokens.id
      )
  )
  const workoutsResult = await settleEndpoint(() =>
    withingsPostJson<WorkoutsBody>(
        userId,
        "/v2/measure",
        {
          action: "getworkouts",
          lastupdate: Math.floor(workoutStart.getTime() / 1000),
          data_fields:
            "calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation",
        },
        tokens.id
      )
  )
  const endpoints = [
    endpointStatus("activity", activityResult),
    endpointStatus("sleep", sleepResult),
    endpointStatus("body", bodyMeasureResult),
    endpointStatus("workouts", workoutsResult),
  ]
  const failed = endpoints.filter((endpoint) => endpoint.status === "error")
  const reconnectRequired = failed.some((endpoint) =>
    isReconnectRequired(endpoint.message ?? "")
  )

  const daily =
    activityResult.status === "fulfilled" || sleepResult.status === "fulfilled" || workoutsResult.status === "fulfilled"
      ? parseDailyHistory({
          start: activityStart,
          end: today,
          activity: activityResult.status === "fulfilled" ? activityResult.value : { activities: [] },
          sleep: sleepResult.status === "fulfilled" ? sleepResult.value : { series: [] },
          workouts: workoutsResult.status === "fulfilled" ? workoutsResult.value : { series: [] },
        })
      : []

  return {
    ok: failed.length < endpoints.length,
    error:
      reconnectRequired
        ? "Withings authorization expired. Reconnect Withings to restore sleep, steps, calories, and heart data."
        : failed.length === endpoints.length
          ? failed.map((endpoint) => endpoint.message).filter(Boolean).join(" | ")
          : undefined,
    needsReconnect: reconnectRequired,
    warnings: failed.map((endpoint) => `${endpoint.name}: ${endpoint.message}`),
    connected: true,
    accountId: tokens.id,
    accountLabel: tokens.account_label ?? "Withings",
    endpoints,
    sleep:
      sleepResult.status === "fulfilled"
        ? parseSleep(sleepResult.value, ymd(yesterday))
        : { ...emptySleep(), status: "error" as const },
    steps:
      activityResult.status === "fulfilled"
        ? parseActivity(activityResult.value, ymd(today))
        : { ...emptySteps(), status: "error" as const },
    calories:
      activityResult.status === "fulfilled"
        ? parseCalories(activityResult.value, ymd(today))
        : { ...emptyCalories(), status: "error" as const },
    heartRate:
      parseHeartRate(
        activityResult.status === "fulfilled" ? activityResult.value : { activities: [] },
        sleepResult.status === "fulfilled" ? sleepResult.value : null,
        bodyMeasureResult.status === "fulfilled" ? bodyMeasureResult.value : null
      ),
    body:
      bodyMeasureResult.status === "fulfilled"
        ? parseBodyMetrics(bodyMeasureResult.value)
        : emptyBodyMetrics("error"),
    workouts:
      workoutsResult.status === "fulfilled"
        ? parseWorkouts(workoutsResult.value)
        : emptyWorkouts("error"),
    daily,
    weekly: buildWeeklyStats(daily),
    plan: buildHealthPlan({
      sleep:
        sleepResult.status === "fulfilled"
          ? parseSleep(sleepResult.value, ymd(yesterday))
          : { ...emptySleep(), status: "error" as const },
      steps:
        activityResult.status === "fulfilled"
          ? parseActivity(activityResult.value, ymd(today))
          : { ...emptySteps(), status: "error" as const },
      calories:
        activityResult.status === "fulfilled"
          ? parseCalories(activityResult.value, ymd(today))
          : { ...emptyCalories(), status: "error" as const },
      heartRate: parseHeartRate(
        activityResult.status === "fulfilled" ? activityResult.value : { activities: [] },
        sleepResult.status === "fulfilled" ? sleepResult.value : null,
        bodyMeasureResult.status === "fulfilled" ? bodyMeasureResult.value : null
      ),
      body:
        bodyMeasureResult.status === "fulfilled"
          ? parseBodyMetrics(bodyMeasureResult.value)
          : emptyBodyMetrics("error"),
      workouts:
        workoutsResult.status === "fulfilled"
          ? parseWorkouts(workoutsResult.value)
          : emptyWorkouts("error"),
    }),
  }
}

function emptySleep() {
  return {
    status: "empty" as const,
    durationMinutes: null,
    inBedMinutes: null,
    wakeups: null,
    date: null,
  }
}

function emptySteps() {
  return {
    status: "empty" as const,
    count: null,
    distanceMeters: null,
    calories: null,
    date: null,
  }
}

function emptyCalories() {
  return {
    status: "empty" as const,
    active: null,
    total: null,
    date: null,
  }
}

function emptyHeartRate() {
  return {
    status: "empty" as const,
    bpm: null,
    minBpm: null,
    maxBpm: null,
    measuredAt: null,
  }
}

function emptyMetric(unit: string, status: MetricPoint["status"] = "empty"): MetricPoint {
  return {
    status,
    value: null,
    unit,
    measuredAt: null,
  }
}

function emptyBodyMetrics(status: MetricPoint["status"] = "empty") {
  return {
    status,
    weightKg: emptyMetric("kg", status),
    heightM: emptyMetric("m", status),
    bmi: emptyMetric("kg/m2", status),
    fatRatioPct: emptyMetric("%", status),
    fatMassKg: emptyMetric("kg", status),
    fatFreeMassKg: emptyMetric("kg", status),
    muscleMassKg: emptyMetric("kg", status),
    hydrationKg: emptyMetric("kg", status),
    boneMassKg: emptyMetric("kg", status),
    pulseWaveVelocity: emptyMetric("m/s", status),
    bloodPressure: {
      status,
      systolic: null as number | null,
      diastolic: null as number | null,
      measuredAt: null as string | null,
    },
    spo2: emptyMetric("%", status),
    bodyTemperatureC: emptyMetric("C", status),
    skinTemperatureC: emptyMetric("C", status),
    glucoseMgDl: emptyMetric("mg/dL", status),
  }
}

function emptyWorkouts(status: "connected" | "empty" | "error" = "empty") {
  return {
    status,
    recentCount: 0,
    latest: null as null | {
      category: number | null
      startedAt: string | null
      durationMinutes: number | null
      calories: number | null
      steps: number | null
      distanceMeters: number | null
      averageHeartRate: number | null
    },
  }
}

function emptyDailyPoint(date: string): DailyHealthPoint {
  return {
    date,
    steps: null,
    distanceMeters: null,
    activeCalories: null,
    totalCalories: null,
    sleepMinutes: null,
    inBedMinutes: null,
    wakeups: null,
    averageHeartRate: null,
    workoutCount: 0,
    workoutMinutes: null,
    workoutCalories: null,
  }
}

function ensureDailyPoint(
  map: Map<string, DailyHealthPoint>,
  date: string
): DailyHealthPoint {
  const existing = map.get(date)
  if (existing) return existing
  const next = emptyDailyPoint(date)
  map.set(date, next)
  return next
}

function parseDailyHistory(args: {
  start: Date
  end: Date
  activity: ActivityBody
  sleep: SleepBody
  workouts: WorkoutsBody
}): DailyHealthPoint[] {
  const map = new Map<string, DailyHealthPoint>()
  for (
    let cursor = new Date(args.start);
    cursor.getTime() <= args.end.getTime();
    cursor.setDate(cursor.getDate() + 1)
  ) {
    ensureDailyPoint(map, ymd(cursor))
  }

  for (const item of args.activity.activities ?? []) {
    if (!item.date) continue
    const point = ensureDailyPoint(map, item.date)
    point.steps = numberOrNull(item.steps)
    point.distanceMeters = numberOrNull(item.distance)
    point.activeCalories = numberOrNull(item.calories)
    point.totalCalories = numberOrNull(item.totalcalories)
    point.averageHeartRate = numberOrNull(item.hr_average)
  }

  for (const item of args.sleep.series ?? []) {
    if (typeof item.date !== "string") continue
    const point = ensureDailyPoint(map, item.date)
    const data = recordOrEmpty(item.data)
    const totalSleep =
      (numericField(item, data, "lightsleepduration") ?? 0) +
      (numericField(item, data, "deepsleepduration") ?? 0) +
      (numericField(item, data, "remsleepduration") ?? 0)
    const durationSeconds =
      totalSleep > 0
        ? totalSleep
        : numericField(item, data, "total_sleep_time") ??
          numericField(item, data, "asleepduration")
    const inBedSeconds =
      numericField(item, data, "durationinbed") ??
      numericField(item, data, "total_timeinbed")
    point.sleepMinutes = durationSeconds === null ? null : Math.round(durationSeconds / 60)
    point.inBedMinutes = inBedSeconds === null ? null : Math.round(inBedSeconds / 60)
    point.wakeups = numericField(item, data, "wakeupcount")
    point.averageHeartRate = point.averageHeartRate ?? numericField(item, data, "hr_average")
  }

  for (const item of args.workouts.series ?? []) {
    const start = numberOrNull(item.startdate) ?? numberOrNull(item.date)
    if (start === null) continue
    const date = ymd(startOfDay(new Date(start * 1000)))
    const point = ensureDailyPoint(map, date)
    const data = recordOrEmpty(item.data)
    const end = numberOrNull(item.enddate)
    const durationMinutes =
      start !== null && end !== null && end > start
        ? Math.round((end - start) / 60)
        : numberOrNull(data.duration)
    const calories =
      numericField(item, data, "calories") ??
      numericField(item, data, "manual_calories")
    point.workoutCount += 1
    point.workoutMinutes = addNullable(point.workoutMinutes, durationMinutes)
    point.workoutCalories = addNullable(point.workoutCalories, calories)
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function average(values: Array<number | null>): number | null {
  const clean = values.filter((value): value is number => typeof value === "number")
  if (clean.length === 0) return null
  return Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length)
}

function sumNullable(values: Array<number | null>): number | null {
  const clean = values.filter((value): value is number => typeof value === "number")
  if (clean.length === 0) return null
  return Math.round(clean.reduce((sum, value) => sum + value, 0))
}

function buildWeeklyStats(daily: DailyHealthPoint[]) {
  const end = startOfDay(new Date())
  const start = new Date(end)
  start.setDate(end.getDate() - 6)
  const week = daily.filter((point) => {
    const date = dateFromYmd(point.date)
    return date.getTime() >= start.getTime() && date.getTime() <= end.getTime()
  })
  const workoutMinutes = sumNullable(week.map((point) => point.workoutMinutes))
  const workoutCalories = sumNullable(week.map((point) => point.workoutCalories))
  return {
    days: week.length,
    stepsTotal: sumNullable(week.map((point) => point.steps)),
    stepsAverage: average(week.map((point) => point.steps)),
    sleepAverageMinutes: average(week.map((point) => point.sleepMinutes)),
    sleepNights: week.filter((point) => typeof point.sleepMinutes === "number").length,
    activeCaloriesTotal: sumNullable(week.map((point) => point.activeCalories)),
    totalCaloriesAverage: average(week.map((point) => point.totalCalories)),
    workoutCount: week.reduce((sum, point) => sum + point.workoutCount, 0),
    workoutMinutes,
    workoutCalories,
  }
}

function parseActivity(body: ActivityBody, date: string) {
  const item = latestActivity(
    body,
    (entry) =>
      numberOrNull(entry.steps) !== null ||
      numberOrNull(entry.distance) !== null
  )
  if (!item) return emptySteps()
  return {
    status: "connected" as const,
    count: numberOrNull(item.steps),
    distanceMeters: numberOrNull(item.distance),
    date: item.date ?? date,
  }
}

function parseCalories(body: ActivityBody, date: string) {
  const item = latestActivity(
    body,
    (entry) =>
      numberOrNull(entry.calories) !== null ||
      numberOrNull(entry.totalcalories) !== null
  )
  if (!item) return emptyCalories()
  const active = numberOrNull(item.calories)
  const total = numberOrNull(item.totalcalories)
  if (active === null && total === null) return emptyCalories()
  return {
    status: "connected" as const,
    active,
    total,
    date: item.date ?? date,
  }
}

function metricFromLatest(
  body: MeasureGroupsBody,
  type: number,
  unit: string
): MetricPoint {
  const latest = latestMeasure(body, type)
  if (!latest) return emptyMetric(unit)
  return {
    status: "connected",
    value: latest.value,
    unit,
    measuredAt: latest.date ? new Date(latest.date * 1000).toISOString() : null,
  }
}

function parseBodyMetrics(body: MeasureGroupsBody) {
  const metrics = emptyBodyMetrics()
  const weightKg = metricFromLatest(body, 1, "kg")
  const heightM = metricFromLatest(body, 4, "m")
  const hasBodyData = [
    weightKg,
    heightM,
    metricFromLatest(body, 6, "%"),
    metricFromLatest(body, 76, "kg"),
  ].some((metric) => metric.value !== null)
  const bmiValue =
    weightKg.value !== null && heightM.value !== null && heightM.value > 0
      ? weightKg.value / (heightM.value * heightM.value)
      : null
  const systolic = metricFromLatest(body, 10, "mmHg")
  const diastolic = metricFromLatest(body, 9, "mmHg")
  return {
    ...metrics,
    status: hasBodyData ? "connected" as const : "empty" as const,
    weightKg,
    heightM,
    bmi: bmiValue === null
      ? emptyMetric("kg/m2")
      : {
          status: "connected" as const,
          value: Number(bmiValue.toFixed(1)),
          unit: "kg/m2",
          measuredAt: weightKg.measuredAt ?? heightM.measuredAt,
        },
    fatRatioPct: metricFromLatest(body, 6, "%"),
    fatMassKg: metricFromLatest(body, 8, "kg"),
    fatFreeMassKg: metricFromLatest(body, 5, "kg"),
    muscleMassKg: metricFromLatest(body, 76, "kg"),
    hydrationKg: metricFromLatest(body, 77, "kg"),
    boneMassKg: metricFromLatest(body, 88, "kg"),
    pulseWaveVelocity: metricFromLatest(body, 91, "m/s"),
    bloodPressure: {
      status: systolic.value !== null || diastolic.value !== null ? "connected" as const : "empty" as const,
      systolic: systolic.value === null ? null : Math.round(systolic.value),
      diastolic: diastolic.value === null ? null : Math.round(diastolic.value),
      measuredAt: systolic.measuredAt ?? diastolic.measuredAt,
    },
    spo2: metricFromLatest(body, 54, "%"),
    bodyTemperatureC: metricFromLatest(body, 71, "C"),
    skinTemperatureC: metricFromLatest(body, 73, "C"),
    glucoseMgDl: metricFromLatest(body, 119, "mg/dL"),
  }
}

function parseWorkouts(body: WorkoutsBody) {
  const series = [...(body.series ?? [])].sort((a, b) => {
    const aDate = numberOrNull(a.startdate) ?? numberOrNull(a.date) ?? 0
    const bDate = numberOrNull(b.startdate) ?? numberOrNull(b.date) ?? 0
    return bDate - aDate
  })
  const latest = series[0]
  if (!latest) return emptyWorkouts()
  const data = recordOrEmpty(latest.data)
  const start = numberOrNull(latest.startdate) ?? numberOrNull(latest.date)
  const end = numberOrNull(latest.enddate)
  const durationMinutes =
    start !== null && end !== null && end > start
      ? Math.round((end - start) / 60)
      : numberOrNull(data.duration)
  return {
    status: "connected" as const,
    recentCount: series.length,
    latest: {
      category: numberOrNull(latest.category),
      startedAt: start === null ? null : new Date(start * 1000).toISOString(),
      durationMinutes,
      calories:
        numericField(latest, data, "calories") ??
        numericField(latest, data, "manual_calories"),
      steps: numericField(latest, data, "steps"),
      distanceMeters:
        numericField(latest, data, "distance") ??
        numericField(latest, data, "manual_distance"),
      averageHeartRate: numericField(latest, data, "hr_average"),
    },
  }
}

function parseSleep(body: SleepBody, fallbackDate: string) {
  const item = latestSleepEntry(
    body,
    (entry, data) => {
      const total =
        (numericField(entry, data, "lightsleepduration") ?? 0) +
        (numericField(entry, data, "deepsleepduration") ?? 0) +
        (numericField(entry, data, "remsleepduration") ?? 0)
      return (
        total > 0 ||
        numericField(entry, data, "total_sleep_time") !== null ||
        numericField(entry, data, "asleepduration") !== null
      )
    }
  )
  if (!item) return emptySleep()
  const data = recordOrEmpty(item.data)
  const totalSleep =
    (numericField(item, data, "lightsleepduration") ?? 0) +
    (numericField(item, data, "deepsleepduration") ?? 0) +
    (numericField(item, data, "remsleepduration") ?? 0)
  const durationSeconds =
    totalSleep > 0
      ? totalSleep
      : numericField(item, data, "total_sleep_time") ??
        numericField(item, data, "asleepduration")
  const inBedSeconds =
    numericField(item, data, "durationinbed") ??
    numericField(item, data, "total_timeinbed")
  return {
    status: "connected" as const,
    durationMinutes:
      durationSeconds === null ? null : Math.round(durationSeconds / 60),
    inBedMinutes: inBedSeconds === null ? null : Math.round(inBedSeconds / 60),
    wakeups: numericField(item, data, "wakeupcount"),
    date: typeof item.date === "string" ? item.date : fallbackDate,
  }
}

function parseHeartRate(
  activityBody: ActivityBody,
  sleepBody: SleepBody | null,
  measureBody: MeasureGroupsBody | null
) {
  const activity = latestActivity(
    activityBody,
    (entry) => numberOrNull(entry.hr_average) !== null
  )
  const avg = numberOrNull(activity?.hr_average)
  if (avg !== null) {
    return {
      status: "connected" as const,
      bpm: Math.round(avg),
      minBpm: numberOrNull(activity?.hr_min),
      maxBpm: numberOrNull(activity?.hr_max),
      measuredAt: activity?.date ?? null,
    }
  }

  const sleep = sleepBody
    ? latestSleepEntry(
        sleepBody,
        (entry, data) => numericField(entry, data, "hr_average") !== null
      )
    : null
  const sleepData = recordOrEmpty(sleep?.data)
  const sleepAvg = sleep ? numericField(sleep, sleepData, "hr_average") : null
  if (sleepAvg !== null) {
    return {
      status: "connected" as const,
      bpm: Math.round(sleepAvg),
      minBpm: sleep ? numericField(sleep, sleepData, "hr_min") : null,
      maxBpm: sleep ? numericField(sleep, sleepData, "hr_max") : null,
      measuredAt: typeof sleep?.date === "string" ? sleep.date : null,
    }
  }

  if (!measureBody) return emptyHeartRate()
  const latest = latestMeasure(measureBody, 11)
  if (!latest) return emptyHeartRate()
  return {
    status: "connected" as const,
    bpm: Math.round(latest.value),
    minBpm: null,
    maxBpm: null,
    measuredAt: latest.date ? new Date(latest.date * 1000).toISOString() : null,
  }
}

function latestMeasure(body: MeasureGroupsBody, type: number) {
  const groups = [...(body.measuregrps ?? [])].sort(
    (a, b) => (b.date ?? 0) - (a.date ?? 0)
  )
  for (const group of groups) {
    const measure = group.measures?.find((entry) => entry.type === type)
    if (!measure) continue
    const value = measureValue(measure)
    if (value === null) continue
    return {
      date: group.date ?? null,
      value,
    }
  }
  return null
}

function buildHealthPlan(summary: {
  sleep: { durationMinutes: number | null }
  steps: { count: number | null }
  calories: { active: number | null; total: number | null }
  heartRate: { bpm: number | null }
  body: ReturnType<typeof emptyBodyMetrics>
  workouts: ReturnType<typeof emptyWorkouts>
}) {
  const actions: string[] = []
  const dataUsed: string[] = []
  const sleepMinutes = summary.sleep.durationMinutes
  const steps = summary.steps.count
  const heart = summary.heartRate.bpm
  const bmi = summary.body.bmi.value
  const weight = summary.body.weightKg.value
  const bodyFat = summary.body.fatRatioPct.value

  if (typeof sleepMinutes === "number") dataUsed.push("sleep")
  if (typeof steps === "number") dataUsed.push("steps")
  if (typeof heart === "number") dataUsed.push("heart rate")
  if (typeof weight === "number") dataUsed.push("weight")
  if (typeof bmi === "number") dataUsed.push("BMI")
  if (typeof bodyFat === "number") dataUsed.push("body fat")
  if (summary.workouts.recentCount > 0) dataUsed.push("workouts")

  let focus = "Baseline"
  if (typeof sleepMinutes === "number" && sleepMinutes < 360) {
    focus = "Recovery"
    actions.push("Keep training light today; choose a 20-minute walk and protect sleep tonight.")
  }
  if (typeof steps === "number" && steps < 4000) {
    if (focus === "Baseline") focus = "Movement"
    actions.push("Get one easy walk before the next work block and aim for 7,000 total steps.")
  }
  if (typeof bmi === "number") {
    if (bmi >= 25) {
      if (focus === "Baseline") focus = "Body composition"
      actions.push("Anchor the day around protein, fiber, and a simple calorie deficit; avoid crash dieting.")
    } else if (bmi < 18.5) {
      if (focus === "Baseline") focus = "Fuel"
      actions.push("Prioritize a full meal window and strength work before pushing cardio volume.")
    } else {
      actions.push("Maintain weight range with steady strength training and daily movement.")
    }
  } else if (typeof weight === "number") {
    actions.push("Log height once so ODIN can calculate BMI and make the plan less generic.")
  }
  if (summary.workouts.recentCount === 0) {
    actions.push("Add two short strength sessions this week so ODIN can coach consistency from actual workouts.")
  }
  if (typeof heart === "number" && heart >= 95) {
    focus = focus === "Baseline" ? "Readiness" : focus
    actions.unshift("If that pulse is resting, downshift first: breathe, hydrate, and avoid max-effort training.")
  }

  const summaryText =
    focus === "Recovery"
      ? "Recovery is the limiter today; movement should support energy, not drain it."
      : focus === "Movement"
        ? "Movement is the cleanest lever today; keep it easy and repeatable."
      : focus === "Body composition"
        ? "Body composition work should be boring, steady, and measurable."
      : "ODIN has enough Withings context for daily coaching once weight, height, sleep, movement, and workouts are populated."

  return {
    status: dataUsed.length > 0 ? "ready" as const : "needs_data" as const,
    focus,
    summary: summaryText,
    actionItems: [...new Set(actions)].slice(0, 3),
    dataUsed,
    caution:
      "Fitness coaching only; not medical diagnosis. Chest pain, fainting, severe shortness of breath, or abnormal readings should go to a clinician.",
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  const userId = await getCallerUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)

  let body: ActionBody
  try {
    body = (await req.json()) as ActionBody
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }

  try {
    switch (body.action) {
      case "summary":
        return jsonResponse({
          data: await summary(userId, body.account_id ?? null),
        })
      default:
        return jsonResponse({ error: `Unknown action: ${body.action}` }, 400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    const needsReconnect = isReconnectRequired(message)
    console.error("[withings-proxy]", message)
    return jsonResponse({
      data: {
        ok: false,
        error: needsReconnect
          ? "Withings authorization expired. Reconnect Withings to restore sleep, steps, calories, and heart data."
          : message,
        needsReconnect,
        connected: true,
        sleep: { ...emptySleep(), status: "error" },
        steps: { ...emptySteps(), status: "error" },
        calories: { ...emptyCalories(), status: "error" },
        heartRate: { ...emptyHeartRate(), status: "error" },
        body: emptyBodyMetrics("error"),
        workouts: emptyWorkouts("error"),
        plan: buildHealthPlan({
          sleep: { ...emptySleep(), status: "error" },
          steps: { ...emptySteps(), status: "error" },
          calories: { ...emptyCalories(), status: "error" },
          heartRate: { ...emptyHeartRate(), status: "error" },
          body: emptyBodyMetrics("error"),
          workouts: emptyWorkouts("error"),
        }),
      },
    })
  }
})

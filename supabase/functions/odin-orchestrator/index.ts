// Edge Function: odin-orchestrator
// ODIN-native command router. Read-only tools, draft-only actions.
//
// Phase 1 implementation notes:
// 1. App requests use OdinCommandRequest/OdinCommandResponse below and are authenticated by Supabase JWT.
// 2. ElevenLabs webhook requests are detected by a `messages` array; they use a backend secret path because ElevenLabs cannot provide Peter's browser JWT.
// 3. Server data access uses the service-role Supabase client from _shared/supabase_admin.ts; browser RLS remains enabled for table access.
// 4. There are no health_latest/calendar_next views in this repo, so live Withings/Calendar context is injected from the existing connector scans.
// 5. ANTHROPIC_API_KEY is already the intelligence-layer secret; Claude failures fall back to ODIN's pre-existing deterministic response.
// 6. ElevenLabs retry behavior is external; this function returns clean JSON/SSE envelopes instead of raw backend errors.

// @ts-expect-error Deno std specifier.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { CORS_HEADERS, corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getAdminClient, getCallerUserId } from "../_shared/supabase_admin.ts"
import { googleFetchJson } from "../_shared/google.ts"
import { listProviderAccounts, type AccountSummary } from "../_shared/connected_accounts.ts"
import { withingsPostJson } from "../_shared/withings.ts"
import {
  defaultOdinTone,
  type OdinTone,
} from "../_shared/odin_persona.ts"
import { buildOdinPersona } from "./lib/personaBuilder.ts"
import { askClaude, CLAUDE_MEMORY_FALLBACK } from "./lib/claudeClient.ts"
import { logEpisodic } from "./lib/memoryWriter.ts"
import {
  buildCachedResponsibilityContext,
  getSourceFreshness,
  logLearningEvent,
  mergeLearningSummaries,
  pendingSummaryFromSignals,
  runConversationLearning,
  upsertPendingItemsFromSignals,
  upsertScanSnapshot,
  type OdinLearningSummary,
  type OdinPendingSummary,
  type OdinResponsibilitySource,
  type OdinScanSource,
  type OdinSourceFreshness,
} from "../_shared/odin_learning.ts"

type Source = "text" | "voice"
type Mode = "chat" | "brief" | "slack" | "gmail" | "calendar" | "health" | "weather" | "browser" | "combined" | "research"
type SignalSource = "slack" | "gmail" | "calendar" | "health" | "weather" | "browser" | "manual" | "memory" | "research" | "system"
type SignalCategory = "urgent" | "today" | "waiting" | "follow_up" | "routine" | "quiet"
type Business = "Stay Minty" | "Dinbnb" | "Personal"
type ExternalBriefBusiness = "dinbnb" | "stayminty"
type ExternalBriefSource = "dinbnb_automation" | "stayminty_automation"
type ExternalBriefMode = "external_brief" | "agent_ingest"
type ExternalBriefAgent = "claude" | "codex" | "runner" | "manual" | "unknown"
type ExternalBriefItemSource = "slack" | "gmail" | "drive"

interface OdinCommandRequest {
  query: string
  source: Source
  timezone: "Asia/Manila"
  mode?: Mode
  tone?: OdinTone
  conversationId?: string
  turnId?: string
  visiblePage?: string
  recentContext?: string
  conversationHistory?: string
  useFreshScan?: boolean
  scanSources?: OdinScanSource[]
  scanWindowDays?: number
  weatherLocation?: WeatherLocationInput
  skipSynthesis?: boolean
}

interface WeatherLocationInput {
  lat?: number
  lon?: number
  label?: string
  source?: "default" | "browser" | "manual"
}

interface OperationsSignal {
  id: string
  source: SignalSource
  category: SignalCategory
  title: string
  summary: string
  evidence?: string
  nextAction?: string
  suggestedReply?: string
  sourceUrl?: string
  dueAt?: string
  person?: string
  business?: Business
  status: "open" | "handled" | "deferred" | "waiting"
  urgency?: "critical" | "high" | "medium" | "low"
}

interface OdinCommandResponse {
  spokenText: string
  displayText: string
  signals: OperationsSignal[]
  sourceLinks: Array<{ label: string; url: string; source: string }>
  drafts: Array<{ target: string; text: string; sourceUrl?: string }>
  warnings: string[]
  toolRuns: Array<{ tool: string; status: "ok" | "partial" | "failed" }>
  suggestions: string[]
  sourceFreshness?: OdinSourceFreshness
  learningSummary?: OdinLearningSummary
  pendingSummary?: OdinPendingSummary
  conversationState?: {
    activeTopic?: string
    lastSourceScan?: string
    unresolvedQuestion?: string | null
  }
}

interface SourceScanResult {
  context: string
  signals: OperationsSignal[]
  sourceLinks: OdinCommandResponse["sourceLinks"]
  drafts?: OdinCommandResponse["drafts"]
  warnings: string[]
  status: "ok" | "partial" | "failed"
  fromCache?: boolean
}

interface CachedScanSnapshotRow {
  source: OdinScanSource
  status: "ok" | "partial" | "failed"
  summary: string
  payload: Record<string, unknown> | null
  signal_count: number
  warnings: string[] | null
  scanned_at: string
}

interface ExternalBriefRequest {
  mode?: ExternalBriefMode
  agent?: unknown
  source_agent?: unknown
  business?: unknown
  summary?: unknown
  report?: unknown
  report_markdown?: unknown
  polished_report?: unknown
  urgency_score?: unknown
  action_items?: unknown
  items?: unknown
  sources?: unknown
  timestamp?: unknown
  test?: unknown
  replace_pending?: unknown
}

interface NormalizedExternalBriefItem {
  id: string | null
  title: string
  summary: string
  person: string | null
  urgency: "critical" | "high" | "medium" | "low"
  bucket: "needs_peter" | "waiting_on_others" | "today" | "done_recently"
  status: "open" | "handled" | "deferred" | "waiting"
  nextAction: string | null
  suggestedReply: string | null
  sourceType: ExternalBriefItemSource
  sourceUrl: string | null
  evidenceLabel: string | null
  dueAt: string | null
}

interface NormalizedExternalBrief {
  mode: ExternalBriefMode
  agent: ExternalBriefAgent
  sourceAgent: string
  business: ExternalBriefBusiness
  summary: string
  report: string | null
  urgencyScore: number
  actionItems: string[]
  items: NormalizedExternalBriefItem[]
  sources: Array<{ label: string; type: ExternalBriefItemSource; url: string }>
  timestamp: string | null
  test: boolean
  replacePending: boolean
}

interface ExternalBusinessBriefRow {
  title: string
  content: string
  source: ExternalBriefSource
  context_json: Record<string, unknown> | null
  created_at: string
}

interface HealthProfileRow {
  focus: string
  target_weight_kg: number | null
  daily_steps: number
  sleep_hours: number
  strength_days: number
  protein_grams: number | null
  diet_style: string
  notes: string | null
  context_summaries: unknown
  active_plan: unknown
  active_plan_selected_at: string | null
  updated_at: string
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>
}

interface GmailMessage {
  id: string
  threadId: string
  snippet?: string
  payload?: { headers?: Array<{ name: string; value: string }> }
  internalDate?: string
  labelIds?: string[]
}

interface GmailThread {
  id: string
  messages?: GmailMessage[]
}

interface GmailOpenThread {
  account: AccountSummary
  threadId: string
  sender: string
  senderKey: string
  subject: string
  preview: string
  lastMessageAt: Date
  hoursSinceLastMessage: number
  hasQuestion: boolean
  hasActionWord: boolean
  urgencyScore: number
  messageCount: number
}

interface CalendarEvent {
  id: string
  summary?: string
  description?: string
  location?: string
  htmlLink?: string
  hangoutLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>
  organizer?: { email?: string; displayName?: string }
  sourceCalendarId?: string
  sourceCalendarSummary?: string
}

interface CalendarListEntry {
  id: string
  summary?: string
  primary?: boolean
  selected?: boolean
}

interface WithingsActivityBody {
  activities?: Array<{
    date?: string
    steps?: number
    distance?: number
    calories?: number
    totalcalories?: number
    hr_average?: number
    hr_min?: number
    hr_max?: number
  }>
}

interface WithingsSleepBody {
  series?: Array<Record<string, unknown>>
}

interface WithingsMeasureGroupsBody {
  measuregrps?: Array<{
    date?: number
    measures?: Array<{ type?: number; value?: number; unit?: number }>
  }>
}

interface WithingsWorkoutsBody {
  series?: Array<Record<string, unknown>>
}

interface OpenMeteoCurrent {
  temperature_2m?: number
  weather_code?: number
}

interface OpenMeteoResponse {
  current?: OpenMeteoCurrent
}

interface SlackIntelItem {
  urgency: "critical" | "high" | "medium" | "low"
  workspace: string
  channel: string
  sent_at: string
  summary: string
  action: string
  evidence?: string
  reply?: string
  person?: string
  why_now?: string
  permalink?: string
}

interface SlackIntelResult {
  items: SlackIntelItem[]
  workspacesScanned: number
  channelsScanned: number
  messagesScanned: number
  warnings: string[]
  scannedAt: string | null
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
const PETER_USER_ID = "3e44b0c2-0fde-4279-90b3-1491320ff3e4"
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"
const CALENDAR_WRITE_SCOPES = new Set([
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
])
const SCAN_SOURCES: OdinScanSource[] = ["gmail", "slack", "calendar", "health", "weather", "browser"]
const SOURCE_CACHE_TTL_MS: Partial<Record<OdinScanSource, number>> = {
  weather: 6 * 60 * 60 * 1000,
  health: 2 * 60 * 60 * 1000,
  calendar: 8 * 60 * 60 * 1000,
}
const EMPTY_LEARNING_SUMMARY: OdinLearningSummary = {
  memoriesUpdated: 0,
  rulesUpdated: 0,
  pendingUpdated: 0,
  eventsLogged: 0,
}
const EMPTY_PENDING_SUMMARY: OdinPendingSummary = {
  needs_peter: 0,
  waiting_on_others: 0,
  today: 0,
  done_recently: 0,
}
const EMPTY_SOURCE_FRESHNESS: OdinSourceFreshness = Object.fromEntries(
  SCAN_SOURCES.map((source) => [
    source,
    {
      source,
      status: "missing",
      lastSuccessfulScanAt: null,
      lastScanAt: null,
      signalCount: 0,
      summary: "No Claude/Codex source brief has been stored yet.",
      warnings: [],
    },
  ])
) as OdinSourceFreshness

function scanCacheLabel(source: OdinScanSource): string {
  if (source === "health") return "Withings"
  return source.charAt(0).toUpperCase() + source.slice(1)
}

function isFreshScanSnapshot(row: CachedScanSnapshotRow, source: OdinScanSource): boolean {
  const ttl = SOURCE_CACHE_TTL_MS[source]
  if (!ttl) return false
  const scannedAt = new Date(row.scanned_at).getTime()
  if (!Number.isFinite(scannedAt)) return false
  return Date.now() - scannedAt <= ttl
}

function cachedSourceArray<T>(payload: Record<string, unknown>, key: string): T[] {
  const value = payload[key]
  return Array.isArray(value) ? value as T[] : []
}

function cachedWeatherLocationMatches(
  payload: Record<string, unknown>,
  input?: WeatherLocationInput
): boolean {
  const cached = recordOrEmpty(payload.weatherLocation)
  const expected = weatherLocation(input)
  const lat = numberOrNull(cached.lat)
  const lon = numberOrNull(cached.lon)
  if (lat === null || lon === null) return false
  return Math.abs(lat - expected.lat) < 0.01 && Math.abs(lon - expected.lon) < 0.01
}

async function loadCachedSourceScan(
  userId: string,
  source: OdinScanSource,
  options: { weatherLocation?: WeatherLocationInput } = {}
): Promise<SourceScanResult | null> {
  const { data, error } = await getAdminClient()
    .from("odin_scan_snapshots")
    .select("source,status,summary,payload,signal_count,warnings,scanned_at")
    .eq("user_id", userId)
    .eq("source", source)
    .maybeSingle()

  if (error || !data) {
    if (error) console.warn(`[odin-orchestrator] ${source} cache lookup failed`, error.message)
    return null
  }

  const row = data as CachedScanSnapshotRow
  if (!isFreshScanSnapshot(row, source)) return null
  const payload = recordOrEmpty(row.payload)
  if (source === "weather" && !cachedWeatherLocationMatches(payload, options.weatherLocation)) return null
  const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(row.scanned_at).getTime()) / 60000))
  return {
    context: `${scanCacheLabel(source)} cached scan reused from ${row.scanned_at} (${ageMinutes}m old). ${row.summary}`,
    signals: cachedSourceArray<OperationsSignal>(payload, "signals"),
    sourceLinks: cachedSourceArray<OdinCommandResponse["sourceLinks"][number]>(payload, "links"),
    drafts: cachedSourceArray<OdinCommandResponse["drafts"][number]>(payload, "drafts"),
    warnings: row.warnings ?? [],
    status: row.status,
    fromCache: true,
  }
}

async function loadCachedSourceScans(
  userId: string,
  sources: OdinScanSource[],
  options: { weatherLocation?: WeatherLocationInput } = {}
): Promise<Partial<Record<OdinScanSource, SourceScanResult>>> {
  const entries = await Promise.all(
    sources.map(async (source) => [source, await loadCachedSourceScan(userId, source, options)] as const)
  )
  return Object.fromEntries(entries.filter(([, result]) => Boolean(result))) as Partial<
    Record<OdinScanSource, SourceScanResult>
  >
}

function isCachedResult(result: { fromCache?: boolean } | null | undefined): boolean {
  return result?.fromCache === true
}

// @ts-expect-error Deno global
const supabaseUrl = Deno.env.get("SUPABASE_URL")
// @ts-expect-error Deno global
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")

function manilaDate(daysOffset = 0): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const date = new Date()
  date.setDate(date.getDate() + daysOffset)
  return formatter.format(date)
}

function manilaBoundaryIso(date: string, boundary: "start" | "end"): string {
  const time = boundary === "start" ? "00:00:00.000" : "23:59:59.999"
  return new Date(`${date}T${time}+08:00`).toISOString()
}

function ymd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function healthFocusLabel(value: string | null | undefined): string {
  if (value === "strength") return "Strength"
  if (value === "recovery") return "Recovery"
  if (value === "busy") return "Busy day"
  return "Fat loss"
}

function dietStyleLabel(value: string | null | undefined): string {
  if (value === "lower_carb") return "Lower carb"
  if (value === "plant_forward") return "Plant-forward"
  if (value === "balanced") return "Balanced"
  return "High protein"
}

function normalizeHealthPlanItems(value: unknown): Array<{ label: string; title: string; detail: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const record = recordOrEmpty(item)
      const label = stringOrNull(record.label)
      const title = stringOrNull(record.title)
      const detail = stringOrNull(record.detail)
      if (!label || !title || !detail) return null
      return { label, title, detail }
    })
    .filter((item): item is { label: string; title: string; detail: string } => Boolean(item))
    .slice(0, 3)
}

function normalizeHealthPlanEvidence(value: unknown): Array<{
  label: string
  value: string
  interpretation: string
  status: string
}> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const record = recordOrEmpty(item)
      const label = stringOrNull(record.label)
      const metricValue = stringOrNull(record.value)
      const interpretation = stringOrNull(record.interpretation)
      const status = stringOrNull(record.status) ?? "info"
      if (!label || !metricValue || !interpretation) return null
      return {
        label,
        value: metricValue,
        interpretation: short(interpretation, 220),
        status,
      }
    })
    .filter((item): item is { label: string; value: string; interpretation: string; status: string } => Boolean(item))
    .slice(0, 5)
}

function normalizeHealthContextSummaries(value: unknown): Array<{
  name: string
  uploadedAt: string | null
  summary: string
  signals: string[]
}> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const record = recordOrEmpty(item)
      const name = stringOrNull(record.name)
      const summary = stringOrNull(record.summary)
      if (!name || !summary) return null
      const signals = Array.isArray(record.signals)
        ? record.signals.filter((signal): signal is string => typeof signal === "string")
        : []
      return {
        name,
        uploadedAt: stringOrNull(record.uploadedAt),
        summary: short(summary, 220),
        signals: signals.slice(0, 6),
      }
    })
    .filter((item): item is { name: string; uploadedAt: string | null; summary: string; signals: string[] } => Boolean(item))
    .slice(0, 5)
}

function healthProfileSummary(row: HealthProfileRow): {
  context: string
  signalSummary: string
  nextAction: string
} {
  const activePlan = recordOrEmpty(row.active_plan)
  const exercise = normalizeHealthPlanItems(activePlan.exercise)
  const diet = normalizeHealthPlanItems(activePlan.diet)
  const recovery = normalizeHealthPlanItems(activePlan.recovery)
  const evidence = normalizeHealthPlanEvidence(activePlan.evidence)
  const contexts = normalizeHealthContextSummaries(row.context_summaries)
  const readiness = numberOrNull(activePlan.readiness)
  const mode = stringOrNull(activePlan.mode)
  const headline = stringOrNull(activePlan.headline)
  const decision = stringOrNull(activePlan.decision)
  const notes = stringOrNull(row.notes)
  const goals = [
    `focus ${healthFocusLabel(row.focus)}`,
    row.target_weight_kg !== null ? `target ${row.target_weight_kg} kg` : null,
    `${row.daily_steps.toLocaleString()} steps/day`,
    `${row.sleep_hours}h sleep`,
    `${row.strength_days} strength days/week`,
    row.protein_grams !== null ? `${row.protein_grams}g protein` : "protein auto",
    `diet ${dietStyleLabel(row.diet_style)}`,
  ].filter(Boolean)
  const oneExercise = exercise[0]
  const oneDiet = diet[0]
  const oneRecovery = recovery[0]
  const nextAction =
    oneExercise?.title ??
    oneDiet?.title ??
    oneRecovery?.title ??
    "Set one exercise, diet, and recovery action in the Health page."
  const planParts = [
    mode ? `active plan ${mode}` : "no active plan selected",
    readiness !== null ? `readiness ${readiness}/100` : null,
    headline,
    decision ? `decision ${decision}` : null,
    oneExercise ? `exercise ${oneExercise.title}: ${oneExercise.detail}` : null,
    oneDiet ? `diet ${oneDiet.title}: ${oneDiet.detail}` : null,
    oneRecovery ? `recovery ${oneRecovery.title}: ${oneRecovery.detail}` : null,
    evidence.length
      ? `evidence ${evidence.map((item) => `${item.label} ${item.value}: ${item.interpretation}`).join(" | ")}`
      : null,
  ].filter(Boolean)
  const context = {
    source: "health_profiles",
    goals,
    activePlan: planParts,
    planEvidence: evidence,
    selectedAt: row.active_plan_selected_at,
    notes: notes ? short(notes, 500) : null,
    fileSignals: contexts.map((item) => ({
      name: item.name,
      summary: item.summary,
      signals: item.signals,
      uploadedAt: item.uploadedAt,
    })),
    updatedAt: row.updated_at,
  }
  const signalSummary = short(
    [
      goals.join(", "),
      planParts.join(". "),
      contexts.length ? `file context: ${contexts.map((item) => item.summary).join(" | ")}` : null,
    ].filter(Boolean).join(". "),
    720
  )

  return {
    context: `Saved ODIN health profile. Use this as Peter's durable health goal/plan context; it stores summaries and signals only, never raw uploaded file bodies: ${JSON.stringify(context)}`,
    signalSummary,
    nextAction,
  }
}

function measureValue(measure: { value?: number; unit?: number }): number | null {
  if (typeof measure.value !== "number" || typeof measure.unit !== "number") return null
  return measure.value * Math.pow(10, measure.unit)
}

function healthPlanningRequested(query: string): boolean {
  const lower = query.toLowerCase()
  return (
    /\b(schedule|plan|shape|block|calendar|slot|fit in|place|put)\b/.test(lower) &&
    /\b(health|fitness|workout|walk|mobility|recovery|fat.?loss|strength|sleep|wind.?down|withings|steps|caffeine)\b/.test(lower)
  ) || /\b(schedule_health_plan|health plan|recovery day|fat.?loss day|strength day|minimum viable health|protect sleep)\b/.test(lower)
}

function healthPlanConfirmationRequested(query: string): boolean {
  const lower = query.toLowerCase()
  const confirmed =
    /\b(yes|confirm|approved|approve|go ahead|do it)\b/.test(lower) ||
    /\b(schedule them|write them|add them|put them|create them)\b/.test(lower)
  const priorHealthPlan =
    /\b(recovery walk|mobility|wind.?down|health plan|calendar blocks|shall i write|withings)\b/.test(lower)
  return confirmed && priorHealthPlan
}

function hasCalendarWriteScope(account: AccountSummary | null | undefined): boolean {
  return Boolean(account?.scopes?.some((scope) => CALENDAR_WRITE_SCOPES.has(scope)))
}

function modeFromQuery(query: string, mode?: Mode): Mode {
  if (mode) return mode
  const lower = query.toLowerCase()
  if (/\b(research|investigate|analyze|analyse|process|summari[sz]e|compare|strategy|think through|break down)\b/.test(lower)) {
    return "research"
  }
  const mentionsSlack = /\b(slack|dm|dms|channel|workspace|council)\b/.test(lower)
  const mentionsGmail = /\b(gmail|email|emails|inbox|mail)\b/.test(lower)
  const mentionsCalendar = /\b(calendar|schedule|meeting|agenda|event|events)\b/.test(lower)
  const mentionsHealth = /\b(vital|vitals|health|withings|heart|pulse|bpm|steps|calories|sleep|resting|watch)\b/.test(lower)
  const mentionsWeather = /\b(weather|forecast|temperature|rain|raining|storm|hot|cold|humidity|outside|umbrella)\b/.test(lower)
  const mentionsBrowser =
    /\b(browser|browse|web browser|computer-use|computer use|visible page|external browser)\b/.test(lower) ||
    /https?:\/\/\S+/i.test(query)
  if (healthPlanningRequested(query)) return "health"
  if (/\b(wake up odin|good morning|morning brief|start my day)\b/.test(lower)) {
    return "brief"
  }
  const count = [mentionsSlack, mentionsGmail, mentionsCalendar, mentionsHealth, mentionsWeather, mentionsBrowser].filter(Boolean).length
  if (count > 1) return "combined"
  if (mentionsSlack) return "slack"
  if (mentionsGmail) return "gmail"
  if (mentionsCalendar) return "calendar"
  if (mentionsHealth) return "health"
  if (mentionsWeather) return "weather"
  if (mentionsBrowser) return "browser"
  if (/\b(brief|scan|what needs|attention|priority|priorities|today|now|daily|my day|operations|ops|anything urgent|what matters)\b/.test(lower)) {
    return "brief"
  }
  return "chat"
}

function weatherSummary(code: number | null): string {
  if (code === null) return "weather condition unavailable"
  if (code === 0) return "clear"
  if ([1, 2, 3].includes(code)) return "partly cloudy"
  if ([45, 48].includes(code)) return "foggy"
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzly"
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rainy"
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snowy"
  if ([95, 96, 99].includes(code)) return "stormy"
  return "mixed"
}

function rangeFromQuery(query: string): { label: string; timeMin: string; timeMax: string } {
  const lower = query.toLowerCase()
  if (lower.includes("tomorrow")) {
    const date = manilaDate(1)
    return {
      label: "tomorrow",
      timeMin: manilaBoundaryIso(date, "start"),
      timeMax: manilaBoundaryIso(date, "end"),
    }
  }
  if (/\bweek\b|next\s+7\s+days?/.test(lower)) {
    return {
      label: "next 7 days",
      timeMin: manilaBoundaryIso(manilaDate(0), "start"),
      timeMax: manilaBoundaryIso(manilaDate(6), "end"),
    }
  }
  return {
    label: "today / next 48 hours across Laguna, Nashville, and Norway",
    timeMin: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  }
}

function calendarTimeForPeter(value?: { dateTime?: string; date?: string }): string | null {
  const raw = value?.dateTime ?? value?.date
  if (!raw) return null
  if (value?.date && !value.dateTime) return `${value.date} all day`
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return `${date.toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} Manila`
}

function addMinutesToClock(time: string, minutes: number): string {
  const [rawHour, rawMinute] = time.split(":").map(Number)
  const hour = Number.isFinite(rawHour) ? rawHour : 0
  const minute = Number.isFinite(rawMinute) ? rawMinute : 0
  const total = Math.min(23 * 60 + 59, Math.max(0, hour * 60 + minute + minutes))
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

function manilaDateTime(date: string, time: string): string {
  return `${date}T${time}:00`
}

function slackDates(query: string): { dateFrom: string; dateTo: string } {
  const match = query.toLowerCase().match(/(?:past|last)\s+(\d+)\s+days?/)
  const days = match ? Math.min(14, Math.max(1, Number(match[1]))) : 3
  return { dateFrom: manilaDate(-days), dateTo: manilaDate(0) }
}

function header(message: GmailMessage, name: string): string {
  return (
    message.payload?.headers?.find(
      (item) => item.name.toLowerCase() === name.toLowerCase()
    )?.value ?? ""
  )
}

function gmailMessageText(message: GmailMessage): string {
  return `${header(message, "Subject")} ${message.snippet ?? ""}`.replace(/\s+/g, " ").trim()
}

function senderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return (match?.[1] ?? from).trim().toLowerCase()
}

function isOperationalEmailSignal(message: GmailMessage): boolean {
  const text = `${header(message, "From")} ${gmailMessageText(message)}`
  const noisyPromo =
    /\b(sale|discount|coupon|deal|promo|promotion|newsletter|unsubscribe|stock up|up to \d+% off|essentials)\b/i.test(
      text
    )
  const operational =
    /\b(owner|vendor|guest|booking|payment|invoice|urgent|approval|deposit|signature|refund|claim|maintenance|reservation|alert|error|failed|failure|jotform|zap|unit availability|vrbo unit|airbnb reservation|vrbo reservation)\b/i.test(
      text
    )
  return operational && !noisyPromo
}

function isKnownLowPriorityEmail(message: GmailMessage): boolean {
  const text = `${header(message, "From")} ${gmailMessageText(message)}`
  const requiresAttention =
    /\b(action required|requires action|verify now|unauthori[sz]ed|payment failed|failed payment|overdue|past due|due today|approve|approval needed|signature required|reply required|respond by|security incident)\b/i.test(
      text
    )
  if (
    !requiresAttention &&
    /\b(tonik bank|time deposit update|new time deposit|changes are coming|rate update|interest rate update|update in town)\b/i.test(
      text
    )
  ) {
    return true
  }
  return /\b(hubstaff|linkedin|li jobs|lina recommendations|jobstreet|job alert|workos|developer success|sso best practices|newsletter|digest|marketing|no-reply|noreply|notification|receipt|security alert|verification code|new sign.?in|sign.?in|login)\b/i.test(text)
}

function sender(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return (match?.[1] ?? from).replace(/^['"]|['"]$/g, "").trim() || "Unknown"
}

function messageDate(message: GmailMessage): Date {
  const internal = Number(message.internalDate ?? 0)
  if (Number.isFinite(internal) && internal > 0) return new Date(internal)
  const date = new Date(header(message, "Date"))
  return Number.isNaN(date.getTime()) ? new Date(0) : date
}

function hoursAgo(date: Date): number {
  if (!date.getTime()) return 999
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 36_000) / 10)
}

function hasQuestion(text: string): boolean {
  return /\?|\b(can you|could you|should we|do we|are we|who is|what is|when can|please confirm|pls confirm)\b/i.test(text)
}

function hasActionWord(text: string): boolean {
  return /\b(need|needs|needed|pls|please|send|confirm|review|decision|approve|approval|signature|deposit|reply|respond|follow up|due|deadline|blocked|waiting|urgent|asap|today|tomorrow)\b/i.test(text)
}

function messageFromAccount(message: GmailMessage, account: AccountSummary): boolean {
  const email = account.account_email?.toLowerCase()
  if (!email) return false
  return senderEmail(header(message, "From")) === email
}

function threadReplyFromMeAfterLatestInbound(
  messages: GmailMessage[],
  account: AccountSummary
): boolean {
  const sorted = [...messages].sort((a, b) => messageDate(a).getTime() - messageDate(b).getTime())
  const latestInboundIndex = sorted.reduce(
    (latest, message, index) => (messageFromAccount(message, account) ? latest : index),
    -1
  )
  if (latestInboundIndex < 0) return true
  return sorted.slice(latestInboundIndex + 1).some((message) => messageFromAccount(message, account))
}

function gmailUrgencyScore(thread: Omit<GmailOpenThread, "urgencyScore">): number {
  const text = `${thread.sender} ${thread.subject} ${thread.preview}`
  const staleScore =
    thread.hoursSinceLastMessage >= 48 ? 45 :
    thread.hoursSinceLastMessage >= 36 ? 35 :
    thread.hoursSinceLastMessage >= 24 ? 26 :
    thread.hoursSinceLastMessage >= 12 ? 14 :
    Math.max(0, thread.hoursSinceLastMessage / 2)
  const senderScore = /\b(meredith|reveen|kelli|owner|ceo|accounting|vendor)\b/i.test(text) ? 18 : 0
  const actionScore = thread.hasActionWord ? 22 : 0
  const questionScore = thread.hasQuestion ? 16 : 0
  const opsScore = isOperationalEmailSignal({
    id: thread.threadId,
    threadId: thread.threadId,
    snippet: thread.preview,
    payload: { headers: [
      { name: "From", value: thread.sender },
      { name: "Subject", value: thread.subject },
    ] },
  }) ? 10 : 0
  return staleScore + senderScore + actionScore + questionScore + opsScore
}

function openThreadFromGmailThread(
  account: AccountSummary,
  thread: GmailThread
): GmailOpenThread | null {
  const messages = (thread.messages ?? []).filter(Boolean)
  if (!messages.length) return null
  const sorted = [...messages].sort((a, b) => messageDate(a).getTime() - messageDate(b).getTime())
  const latest = sorted[sorted.length - 1]
  if (!latest || messageFromAccount(latest, account)) return null
  if (threadReplyFromMeAfterLatestInbound(sorted, account)) return null

  const from = header(latest, "From")
  const subject = header(latest, "Subject") || "(no subject)"
  const preview = short(latest.snippet ?? subject, 160)
  const text = `${subject} ${preview}`
  const question = hasQuestion(text)
  const action = hasActionWord(text)
  if (isKnownLowPriorityEmail(latest)) return null
  if (!question && !action) return null
  if (!isOperationalEmailSignal(latest)) return null

  const lastMessageAt = messageDate(latest)
  const base = {
    account,
    threadId: thread.id || latest.threadId,
    sender: sender(from),
    senderKey: senderEmail(from) || sender(from).toLowerCase(),
    subject,
    preview,
    lastMessageAt,
    hoursSinceLastMessage: hoursAgo(lastMessageAt),
    hasQuestion: question,
    hasActionWord: action,
    messageCount: sorted.length,
  }
  return {
    ...base,
    urgencyScore: gmailUrgencyScore(base),
  }
}

function short(value: string, max = 220): string {
  const cleaned = value.replace(/\s+/g, " ").trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

function shortMultiline(value: string, max = 6000): string {
  const cleaned = value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

function isSlackAuthFailure(message: string): boolean {
  return /\b(401|invalid_auth|not_authed|account_inactive|token_revoked|unauthorized)\b/i.test(
    message
  )
}

function normalizeSlackWarning(message: string): string {
  if (!isSlackAuthFailure(message)) return message
  return "Slack reconnect required: at least one connected workspace token is invalid or expired. Reconnect Slack in Connections, then run Scan again."
}

function pendingTotal(summary: OdinPendingSummary): number {
  return summary.needs_peter + summary.waiting_on_others + summary.today + summary.done_recently
}

function conciseManualScanSpokenText(
  response: OdinCommandResponse,
  pendingSummary: OdinPendingSummary
): string {
  const missingAgentBrief = response.warnings.find((warning) =>
    /No fresh (?:[a-z/ ]+ )?agent(?: source)? brief/i.test(warning)
  )
  if (missingAgentBrief) {
    return `${missingAgentBrief} Showing the last-known queue only.`
  }

  const score = (signal: OperationsSignal) => {
    const text = `${signal.urgency ?? ""} ${signal.title} ${signal.summary} ${signal.evidence ?? ""} ${signal.nextAction ?? ""} ${signal.person ?? ""}`.toLowerCase()
    return (
      (signal.urgency === "critical" || /\b(critical|written warning|termination|legal|safety|lockout|fire|flood)\b/.test(text) ? 400 : 0) +
      (signal.category === "urgent" ? 300 : signal.category === "today" ? 180 : signal.category === "waiting" ? 120 : 60) +
      (/\b(meredith|owner|guest|damage|broken|approval|blocked)\b/.test(text) ? 40 : 0) +
      (signal.nextAction ? 10 : 0)
    )
  }
  const actionable = response.signals
    .filter(
      (signal) =>
        signal.status !== "handled" &&
        signal.status !== "deferred" &&
        signal.category !== "routine" &&
        signal.category !== "quiet"
    )
    .sort((a, b) => score(b) - score(a))
  const top = actionable[0]
  const total = pendingTotal(pendingSummary) || actionable.length
  if (!top) return "Scan checked. I do not see anything urgent in the fresh evidence."

  const counts = [
    pendingSummary.needs_peter ? `${pendingSummary.needs_peter} need you` : "",
    pendingSummary.today ? `${pendingSummary.today} time-bound` : "",
    pendingSummary.waiting_on_others ? `${pendingSummary.waiting_on_others} waiting elsewhere` : "",
  ].filter(Boolean)
  const label = top.person ? `${top.person}` : top.title
  const nextAction = top.nextAction ?? top.summary
  const countText = counts.length ? counts.join(", ") : `${total} open`
  return `Scan checked. ${total} open item${total === 1 ? "" : "s"}: ${countText}. Top priority: ${label}. Next move: ${short(nextAction, 170)}`
}

function isMorningBriefQuery(query: string, mode: Mode): boolean {
  return (
    mode === "brief" &&
    /\b(wake up odin|good morning|morning brief|start my day)\b/i.test(query)
  )
}

function isExternalBriefBody(body: unknown): body is ExternalBriefRequest {
  return Boolean(
    body &&
      typeof body === "object" &&
      ((body as { mode?: unknown }).mode === "external_brief" ||
        (body as { mode?: unknown }).mode === "agent_ingest")
  )
}

function automationSourceForBusiness(business: ExternalBriefBusiness): ExternalBriefSource {
  return `${business}_automation` as ExternalBriefSource
}

function externalBriefBusinessLabel(business: ExternalBriefBusiness): Business {
  return business === "stayminty" ? "Stay Minty" : "Dinbnb"
}

function normalizeExternalBriefAgent(value: unknown, business: ExternalBriefBusiness): ExternalBriefAgent {
  if (value === "claude" || value === "codex" || value === "runner" || value === "manual") return value
  return business === "stayminty" ? "claude" : business === "dinbnb" ? "codex" : "unknown"
}

function externalBriefSourceAgent(agent: ExternalBriefAgent, business: ExternalBriefBusiness): string {
  const safeAgent = agent === "unknown" ? "external" : agent
  return `${safeAgent}_${business}`
}

function externalKeyText(value: string | null | undefined, max = 90): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "item"
}

function normalizeExternalBriefSources(value: unknown): NormalizedExternalBrief["sources"] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, 10)
    .map((item) => {
      if (!item || typeof item !== "object") return null
      const record = item as Record<string, unknown>
      const label = typeof record.label === "string" ? short(record.label, 80) : ""
      const type =
        record.type === "slack" || record.type === "gmail" || record.type === "drive"
          ? record.type
          : null
      const url = typeof record.url === "string" && /^https?:\/\//i.test(record.url)
        ? short(record.url, 500)
        : null
      if (!label || !type || !url) return null
      return { label, type, url }
    })
    .filter((item): item is { label: string; type: "slack" | "gmail" | "drive"; url: string } => Boolean(item))
}

function normalizeExternalActionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === "string" ? short(item, 180) : ""))
    .filter(Boolean)
}

function stringFromRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) return value.replace(/\s+/g, " ").trim()
  }
  return null
}

function numberFromRecord(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

function normalizedExternalSourceType(value: unknown): ExternalBriefItemSource | null {
  if (value === "slack" || value === "gmail" || value === "drive") return value
  if (typeof value !== "string") return null
  const lower = value.toLowerCase()
  if (lower.includes("slack")) return "slack"
  if (lower.includes("gmail") || lower.includes("email") || lower.includes("mail")) return "gmail"
  if (lower.includes("drive") || lower.includes("doc")) return "drive"
  return null
}

function urgencyFromExternalItem(record: Record<string, unknown>, fallbackScore: number): NormalizedExternalBriefItem["urgency"] {
  const raw = stringFromRecord(record, ["urgency", "priority", "severity"])?.toLowerCase()
  if (raw === "critical" || raw === "high" || raw === "medium" || raw === "low") return raw
  if (raw && /\b(critical|urgent|payroll|legal|blocked|owner|guest escalation)\b/.test(raw)) return "critical"
  if (raw && /\b(high|today|time[- ]sensitive)\b/.test(raw)) return "high"
  const score = numberFromRecord(record, ["urgency_score", "urgencyScore", "score", "priority_score"]) ?? fallbackScore
  if (score >= 8) return "critical"
  if (score >= 6) return "high"
  if (score >= 3) return "medium"
  return "low"
}

function bucketFromExternalItem(
  record: Record<string, unknown>,
  urgency: NormalizedExternalBriefItem["urgency"]
): NormalizedExternalBriefItem["bucket"] {
  const raw = stringFromRecord(record, ["bucket", "state", "queue"])?.toLowerCase()
  if (raw === "needs_peter" || raw === "waiting_on_others" || raw === "today" || raw === "done_recently") return raw
  if (raw && /\b(done|handled|closed|resolved)\b/.test(raw)) return "done_recently"
  if (raw && /\b(waiting|blocked by|awaiting|others)\b/.test(raw)) return "waiting_on_others"
  if (raw && /\b(today|now|due)\b/.test(raw)) return "today"
  if (urgency === "critical" || urgency === "high") return "needs_peter"
  return "today"
}

function statusFromExternalItem(record: Record<string, unknown>): NormalizedExternalBriefItem["status"] {
  const raw = stringFromRecord(record, ["status", "state"])?.toLowerCase()
  if (raw === "open" || raw === "handled" || raw === "deferred" || raw === "waiting") return raw
  if (raw && /\b(done|handled|closed|resolved)\b/.test(raw)) return "handled"
  if (raw && /\b(defer|later|snooze)\b/.test(raw)) return "deferred"
  if (raw && /\b(waiting|awaiting|blocked)\b/.test(raw)) return "waiting"
  return "open"
}

function externalSourceForItem(
  record: Record<string, unknown>,
  fallbackSources: NormalizedExternalBrief["sources"]
): Pick<NormalizedExternalBriefItem, "sourceType" | "sourceUrl" | "evidenceLabel"> {
  const sourceRecord = record.source && typeof record.source === "object"
    ? record.source as Record<string, unknown>
    : record
  const fallback = fallbackSources[0]
  const sourceType =
    normalizedExternalSourceType(record.source) ??
    normalizedExternalSourceType(sourceRecord.type) ??
    normalizedExternalSourceType(record.source_type) ??
    normalizedExternalSourceType(record.sourceType) ??
    fallback?.type ??
    "slack"
  const rawUrl =
    stringFromRecord(sourceRecord, ["url", "sourceUrl", "source_url", "evidence_url"]) ??
    stringFromRecord(record, ["url", "sourceUrl", "source_url", "evidence_url"]) ??
    fallback?.url ??
    null
  const sourceUrl = rawUrl && /^https?:\/\//i.test(rawUrl) ? short(rawUrl, 500) : null
  const evidenceLabel =
    stringFromRecord(sourceRecord, ["label", "evidence_label", "title"]) ??
    stringFromRecord(record, ["evidence_label", "evidenceLabel", "channel", "thread", "label"]) ??
    fallback?.label ??
    sourceType
  return {
    sourceType,
    sourceUrl,
    evidenceLabel: evidenceLabel ? short(evidenceLabel, 160) : null,
  }
}

function normalizeExternalBriefItems(
  value: unknown,
  actionItems: string[],
  fallbackSources: NormalizedExternalBrief["sources"],
  fallbackScore: number,
  summary: string,
  report: string | null = null
): NormalizedExternalBriefItem[] {
  const rawItems = Array.isArray(value) ? value.slice(0, 30) : []
  const items = rawItems
    .map((item, index) => {
      const record = typeof item === "string"
        ? { title: item, summary: item, next_action: item, id: `action-${index}` }
        : recordOrEmpty(item)
      const source = externalSourceForItem(record, fallbackSources)
      const urgency = urgencyFromExternalItem(record, fallbackScore)
      const title =
        stringFromRecord(record, ["title", "topic", "subject", "name"]) ??
        stringFromRecord(record, ["person", "sender"]) ??
        actionItems[index] ??
        summary
      const itemSummary =
        stringFromRecord(record, ["summary", "description", "evidence", "context", "snippet"]) ??
        actionItems[index] ??
        summary
      return {
        id: stringFromRecord(record, ["id", "source_item_id", "thread_id", "message_id"]),
        title: short(title, 220),
        summary: short(itemSummary, 900),
        person: stringFromRecord(record, ["person", "sender", "from", "owner", "assignee"]),
        urgency,
        bucket: bucketFromExternalItem(record, urgency),
        status: statusFromExternalItem(record),
        nextAction: stringFromRecord(record, ["next_action", "nextAction", "action", "recommendation"]),
        suggestedReply: stringFromRecord(record, ["suggested_reply", "suggestedReply", "draft", "draft_reply"]),
        ...source,
        dueAt: stringFromRecord(record, ["due_at", "dueAt", "deadline"]),
      }
    })
    .filter((item) => item.title && item.summary)

  const reportItems = normalizeExternalBriefItemsFromReport(
    report,
    fallbackSources,
    fallbackScore,
    summary
  )
  if (reportItems.length > items.length) return reportItems
  if (items.length > 0) return items
  if (reportItems.length > 0) return reportItems

  if (actionItems.length > 0) {
    return actionItems.slice(0, 10).map((action, index) => {
      const source = fallbackSources[index] ?? fallbackSources[0]
      const urgency = fallbackScore >= 8 ? "critical" : fallbackScore >= 6 ? "high" : "medium"
      return {
        id: `action-${index}`,
        title: short(action, 220),
        summary: short(summary, 900),
        person: null,
        urgency,
        bucket: urgency === "critical" || urgency === "high" ? "needs_peter" : "today",
        status: "open",
        nextAction: short(action, 500),
        suggestedReply: null,
        sourceType: source?.type ?? "slack",
        sourceUrl: source?.url ?? null,
        evidenceLabel: source?.label ?? null,
        dueAt: null,
      }
    })
  }

  if (fallbackScore > 0 && summary) {
    const source = fallbackSources[0]
    const urgency = fallbackScore >= 8 ? "critical" : fallbackScore >= 6 ? "high" : "medium"
    return [{
      id: "summary",
      title: short(summary, 160),
      summary: short(summary, 900),
      person: null,
      urgency,
      bucket: urgency === "critical" || urgency === "high" ? "needs_peter" : "today",
      status: "open",
      nextAction: short(summary, 500),
      suggestedReply: null,
      sourceType: source?.type ?? "slack",
      sourceUrl: source?.url ?? null,
      evidenceLabel: source?.label ?? null,
      dueAt: null,
    }]
  }

  return []
}

function reportLineText(value: string): string {
  return value
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$1")
    .replace(/mailto:/gi, "")
    .replace(/[`*_>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function reportItemSourceType(
  text: string,
  fallbackSources: NormalizedExternalBrief["sources"]
): ExternalBriefItemSource {
  if (/\b(gmail|email|inbox|draft|mailto|invoice|meredith)\b/i.test(text)) return "gmail"
  if (/\b(slack|dm|channel|mention|thread)\b/i.test(text)) return "slack"
  if (/\b(drive|doc|sheet|loom|file|attachment)\b/i.test(text)) return "drive"
  return fallbackSources[0]?.type ?? "slack"
}

function reportItemUrgency(text: string, fallbackScore: number): NormalizedExternalBriefItem["urgency"] {
  if (/\b(send now|day 4|still pending|immediately|critical|red|overdue|1-star|one-star|action required)\b/i.test(text)) {
    return "critical"
  }
  if (/\b(warning|urgent|follow up|approval|invoice|blocked|waiting|today|asap)\b/i.test(text)) return "high"
  if (fallbackScore >= 8) return "critical"
  if (fallbackScore >= 6) return "high"
  if (fallbackScore > 0) return "medium"
  return "low"
}

function normalizeReportTitle(value: string): string {
  return reportLineText(value)
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim()
}

function normalizeExternalBriefItemsFromReport(
  report: string | null,
  fallbackSources: NormalizedExternalBrief["sources"],
  fallbackScore: number,
  summary: string
): NormalizedExternalBriefItem[] {
  if (!report) return []
  const lines = report
    .split(/\r?\n/)
    .map((line) => reportLineText(line))
    .filter(Boolean)
  if (!lines.length) return []

  const topStart = lines.findIndex((line) => /\btop priorities today\b/i.test(line))
  const sourceLines = topStart >= 0 ? lines.slice(topStart + 1) : lines
  const candidates: string[] = []
  for (const line of sourceLines) {
    if (candidates.length >= 10) break
    if (
      topStart >= 0 &&
      candidates.length > 0 &&
      /^[A-Z][A-Z0-9 &/-]{6,}$/.test(line) &&
      !/SEND NOW|REVIEW|FOLLOW|ADDRESS/i.test(line)
    ) {
      break
    }
    const numbered = line.match(/^\s*(?:\d+[.)]\s*|[-*]\s+)(.+)$/)
    if (!numbered) continue
    const title = normalizeReportTitle(numbered[1])
    if (!/[A-Za-z]/.test(title)) continue
    if (/\b(subject|status|existing drafts|sent using)\b/i.test(title)) continue
    candidates.push(title)
  }

  if (!candidates.length) return []

  return candidates.slice(0, 10).map((title, index) => {
    const urgency = reportItemUrgency(title, fallbackScore)
    const sourceType = reportItemSourceType(title, fallbackSources)
    const fallback = fallbackSources.find((source) => source.type === sourceType) ?? fallbackSources[0]
    return {
      id: `report-priority-${index + 1}`,
      title: short(title, 220),
      summary: short(title, 900) || short(summary, 900),
      person: title.match(/\b(Meredith|Reveen|Eric|Adrian|Jessica|Kelli|Shiela|Chancey|Reynolds)\b/i)?.[0] ?? null,
      urgency,
      bucket: urgency === "critical" || urgency === "high" ? "needs_peter" : "today",
      status: "open",
      nextAction: short(title, 500),
      suggestedReply: null,
      sourceType,
      sourceUrl: fallback?.url ?? null,
      evidenceLabel: fallback?.label ?? "polished source report",
      dueAt: null,
    }
  })
}

function validateExternalBrief(body: ExternalBriefRequest): {
  data?: NormalizedExternalBrief
  error?: string
} {
  const mode = body.mode === "agent_ingest" ? "agent_ingest" : "external_brief"
  if (body.business !== "dinbnb" && body.business !== "stayminty") {
    return { error: "business must be dinbnb or stayminty" }
  }
  if (typeof body.summary !== "string" || body.summary.trim().length === 0) {
    return { error: "summary is required" }
  }
  const summary = body.summary.replace(/\s+/g, " ").trim()
  if (summary.length > 500) return { error: "summary must be 500 characters or fewer" }
  let urgencyScore: number
  if (body.urgency_score === undefined || body.urgency_score === null) {
    urgencyScore = Array.isArray(body.items) || Array.isArray(body.action_items) ? 5 : 0
  } else if (
    typeof body.urgency_score !== "number" ||
    !Number.isFinite(body.urgency_score) ||
    !Number.isInteger(body.urgency_score) ||
    body.urgency_score < 0 ||
    body.urgency_score > 10
  ) {
    return { error: "urgency_score must be an integer from 0 to 10" }
  } else {
    urgencyScore = body.urgency_score
  }
  if (body.action_items !== undefined && !Array.isArray(body.action_items)) {
    return { error: "action_items must be an array of strings" }
  }
  if (Array.isArray(body.action_items) && !body.action_items.every((item) => typeof item === "string")) {
    return { error: "action_items must be an array of strings" }
  }
  const actionItems = normalizeExternalActionItems(body.action_items)
  if ((body.action_items as unknown[] | undefined)?.length && (body.action_items as unknown[]).length > 10) {
    return { error: "action_items must contain at most 10 items" }
  }
  const timestamp = typeof body.timestamp === "string" && body.timestamp.trim()
    ? body.timestamp.trim()
    : null
  const report =
    typeof body.report_markdown === "string" && body.report_markdown.trim()
      ? shortMultiline(body.report_markdown.trim(), 6000)
      : typeof body.polished_report === "string" && body.polished_report.trim()
        ? shortMultiline(body.polished_report.trim(), 6000)
        : typeof body.report === "string" && body.report.trim()
          ? shortMultiline(body.report.trim(), 6000)
          : null
  const agent = normalizeExternalBriefAgent(body.agent ?? body.source_agent, body.business)
  const sources = normalizeExternalBriefSources(body.sources)
  const items = normalizeExternalBriefItems(body.items, actionItems, sources, urgencyScore, summary, report)
  return {
    data: {
      mode,
      agent,
      sourceAgent: externalBriefSourceAgent(agent, body.business),
      business: body.business,
      summary,
      report,
      urgencyScore,
      actionItems,
      items,
      sources,
      timestamp,
      test: body.test === true,
      replacePending: body.replace_pending !== false,
    },
  }
}

function scanWindowDaysFromRequest(body: OdinCommandRequest, query: string): number {
  if (typeof body.scanWindowDays === "number" && Number.isFinite(body.scanWindowDays)) {
    return Math.max(1, Math.min(30, Math.round(body.scanWindowDays)))
  }
  const match = query.toLowerCase().match(/(?:past|last)\s+(\d+)\s+days?/)
  if (match?.[1]) return Math.max(1, Math.min(30, Number(match[1])))
  if (/\b(deep|all emails|a lot of emails|many emails|pull a lot|last 30|30 days|full inbox)\b/i.test(query)) {
    return 30
  }
  return 7
}

function explicitScanRequested(body: OdinCommandRequest, query: string, mode: Mode): boolean {
  if (body.useFreshScan === true) return true
  if (Array.isArray(body.scanSources) && body.scanSources.length > 0) return true
  if (/\b(refresh|rescan|manual scan|scan now|refresh odin scan|update odin scan|pull latest|fresh scan)\b/i.test(query)) {
    return true
  }
  if (
    (mode === "gmail" || mode === "slack" || mode === "calendar" || mode === "combined") &&
    /\b(check|update|latest|read|pull|all emails|inbox)\b/i.test(query)
  ) {
    return true
  }
  return mode !== "brief" && /\b(scan|check live|read latest)\b/i.test(query)
}

function requestedScanSources(body: OdinCommandRequest, query: string, mode: Mode): Set<OdinScanSource> {
  const requested = new Set<OdinScanSource>()
  for (const source of body.scanSources ?? []) {
    if (SCAN_SOURCES.includes(source)) requested.add(source)
  }
  const lower = query.toLowerCase()
  if (requested.size > 0) return requested
  if (healthPlanningRequested(query)) {
    requested.add("health")
    requested.add("calendar")
  }
  if (mode === "gmail" || /\b(gmail|email|emails|inbox|mail)\b/.test(lower)) requested.add("gmail")
  if (mode === "slack" || /\b(slack|dm|dms|channel|workspace|council)\b/.test(lower)) requested.add("slack")
  if (mode === "calendar" || /\b(calendar|schedule|meeting|agenda|event|events)\b/.test(lower)) requested.add("calendar")
  if (mode === "health" || /\b(vital|vitals|health|withings|heart|pulse|bpm|steps|calories|sleep|resting|watch)\b/.test(lower)) {
    requested.add("health")
  }
  if (mode === "weather" || /\b(weather|temperature|forecast|laguna|manila)\b/.test(lower)) requested.add("weather")
  if (mode === "browser" || /\b(browser|browse|visible page|web context|external browser)\b/.test(lower)) requested.add("browser")
  if (mode === "combined" || (mode === "brief" && requested.size === 0)) {
    requested.add("gmail")
    requested.add("slack")
    requested.add("calendar")
    requested.add("health")
    requested.add("weather")
  }
  return requested
}

function responsibilitySignals(signals: OperationsSignal[]) {
  return signals.filter((signal) => signal.source !== "system" && signal.source !== "weather") as Array<OperationsSignal & {
    source: Exclude<SignalSource, "system" | "weather">
  }>
}

function responseWithResponsibilityMeta(
  response: OdinCommandResponse,
  meta: {
    sourceFreshness?: OdinSourceFreshness
    learningSummary?: OdinLearningSummary
    pendingSummary?: OdinPendingSummary
  }
): OdinCommandResponse {
  return {
    ...response,
    sourceFreshness: meta.sourceFreshness ?? response.sourceFreshness ?? EMPTY_SOURCE_FRESHNESS,
    learningSummary: meta.learningSummary ?? response.learningSummary ?? EMPTY_LEARNING_SUMMARY,
    pendingSummary: meta.pendingSummary ?? response.pendingSummary ?? EMPTY_PENDING_SUMMARY,
  }
}

function morningUrgency(signal?: OperationsSignal | null): string {
  if (!signal) return "quiet"
  if (signal.category === "urgent") return "urgent"
  if (signal.category === "waiting") return "waiting on Peter"
  if (signal.category === "today") return "today"
  if (signal.category === "follow_up") return "follow-up"
  return "low"
}

function primaryMorningSignal(signals: OperationsSignal[]): OperationsSignal | null {
  const rank: Record<SignalCategory, number> = {
    urgent: 0,
    waiting: 1,
    today: 2,
    follow_up: 3,
    routine: 4,
    quiet: 5,
  }

  return (
    [...signals]
      .filter((signal) => signal.source !== "system")
      .sort((a, b) => rank[a.category] - rank[b.category])[0] ??
    signals[0] ??
    null
  )
}

function morningBriefSpokenText(signals: OperationsSignal[]): string {
  const signal = primaryMorningSignal(signals)
  if (!signal) {
    return "Good morning, Peter. The board is quiet for now, which is either progress or a well-dressed ambush."
  }

  const nextAction = signal.nextAction ?? signal.summary
  const issue =
    morningUrgency(signal) === "urgent"
      ? "This is the one I would not let age politely."
      : morningUrgency(signal) === "waiting on Peter"
        ? "It appears to be waiting on your call."
        : morningUrgency(signal) === "today"
          ? "It belongs in today's lane."
          : "It is the cleanest next item."
  return short(
    `Good morning, Peter. ${signals.length > 1 ? `${signals.length} items are on the board, but one needs the chair.` : "One item needs the chair."} ${signal.title}: ${nextAction}. ${issue}`,
    280
  )
}

function extractUrls(text: string): string[] {
  return Array.from(
    new Set(text.match(/https?:\/\/[^\s)]+/g)?.map((url) => url.replace(/[.,;]+$/, "")) ?? [])
  ).slice(0, 3)
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function businessFromText(text: string): Business {
  const lower = text.toLowerCase()
  if (
    lower.includes("dinbnb") ||
    lower.includes("lev") ||
    lower.includes("oslo") ||
    lower.includes("bergen") ||
    lower.includes("guesty") ||
    lower.includes("hostaway") ||
    lower.includes("pricelabs") ||
    lower.includes("kg-") ||
    /\b(emil|jonas|kasper|nameda|diana|king emmanuel|rob|gerson|jane)\b/i.test(text) ||
    lower.includes("get team") ||
    lower.includes("apartment hotel")
  ) {
    return "Dinbnb"
  }
  if (
    lower.includes("stay minty") ||
    lower.includes("stayminty") ||
    lower.includes("smoky") ||
    lower.includes("smokies") ||
    lower.includes("nashville") ||
    lower.includes("glamp") ||
    lower.includes("dunn's creek") ||
    lower.includes("dunns creek") ||
    lower.includes("stellara") ||
    lower.includes("evermere") ||
    lower.includes("cabin")
    || /\b(meredith|kelli|reveen|jessica|eric|andy|sean|brandi|shiela|skie)\b/i.test(text)
  ) {
    return "Stay Minty"
  }
  return "Personal"
}

function signalCategory(text: string): SignalCategory {
  const lower = text.toLowerCase()
  if (/critical|urgent|warning|blocked|cannot|can't|approval|deposit|signature|safety|payroll|escalat/.test(lower)) {
    return "urgent"
  }
  if (/today|tomorrow|guest|check.?in|meeting|last minute|calendar/.test(lower)) {
    return "today"
  }
  if (/waiting|billable|work order|vendor|owner|follow/.test(lower)) {
    return "waiting"
  }
  return "follow_up"
}

function externalBriefUrgency(row: ExternalBusinessBriefRow): number {
  const raw = row.context_json?.urgency_score
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(0, Math.min(10, Math.round(raw)))
    : 0
}

function externalBriefActionItems(row: ExternalBusinessBriefRow): string[] {
  const raw = row.context_json?.action_items
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (typeof item === "string" ? short(item, 180) : ""))
    .filter(Boolean)
    .slice(0, 3)
}

function externalBriefSources(row: ExternalBusinessBriefRow): NormalizedExternalBrief["sources"] {
  return normalizeExternalBriefSources(row.context_json?.sources)
}

function businessFromExternalSource(source: ExternalBriefSource): ExternalBriefBusiness {
  return source === "stayminty_automation" ? "stayminty" : "dinbnb"
}

async function loadExternalBusinessBriefContext(userId: string): Promise<{
  context: string
  signals: OperationsSignal[]
  sourceLinks: OdinCommandResponse["sourceLinks"]
  warnings: string[]
  status: "ok" | "partial" | "failed"
  count: number
}> {
  const sources: ExternalBriefSource[] = ["stayminty_automation", "dinbnb_automation"]
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await getAdminClient()
    .from("odin_memories")
    .select("title,content,source,context_json,created_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .in("source", sources)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(10)

  if (error) {
    return {
      context: `External automation briefs unavailable: ${error.message}`,
      signals: [],
      sourceLinks: [],
      warnings: [`External automation briefs unavailable: ${error.message}`],
      status: "failed",
      count: 0,
    }
  }

  const latestBySource: Partial<Record<ExternalBriefSource, ExternalBusinessBriefRow>> = {}
  for (const row of data ?? []) {
    if (!sources.includes(row.source as ExternalBriefSource)) continue
    const source = row.source as ExternalBriefSource
    if (!latestBySource[source]) {
      latestBySource[source] = {
        title: row.title,
        content: row.content,
        source,
        context_json: recordOrEmpty(row.context_json),
        created_at: row.created_at,
      }
    }
  }

  const rows = sources
    .map((source) => latestBySource[source])
    .filter((row): row is ExternalBusinessBriefRow => Boolean(row))
  if (!rows.length) {
    return {
      context:
        "External automation briefs: no Stay Minty or Dinbnb automation brief found in odin_memories in the last 24 hours. Fall back to cached responsibility or live scans.",
      signals: [],
      sourceLinks: [],
      warnings: [],
      status: "partial",
      count: 0,
    }
  }

  const present = new Set(rows.map((row) => row.source))
  const missing = sources.filter((source) => !present.has(source))
  const signals: OperationsSignal[] = rows.map((row) => {
    const business = businessFromExternalSource(row.source)
    const label = externalBriefBusinessLabel(business)
    const urgency = externalBriefUrgency(row)
    const actionItems = externalBriefActionItems(row)
    return {
      id: `external-${row.source}-${row.created_at}`,
      source: "memory",
      category: urgency >= 7 ? "urgent" : urgency > 0 ? "waiting" : "quiet",
      title: `${label} automation brief`,
      summary: row.content,
      evidence: `${row.source} at ${row.created_at}`,
      nextAction:
        actionItems[0] ??
        (urgency > 0 ? `Handle the top ${label} escalation.` : `${label} is quiet; no owner action surfaced.`),
      business: label,
      status: "open",
    }
  })

  for (const source of missing) {
    const business = businessFromExternalSource(source)
    const label = externalBriefBusinessLabel(business)
    signals.push({
      id: `external-${source}-missing`,
      source: "memory",
      category: "quiet",
      title: `${label} is quiet`,
      summary: `No ${label} automation escalation brief arrived in the last 24 hours.`,
      nextAction: `No Peter action surfaced by the ${label} automation.`,
      business: label,
      status: "open",
    })
  }

  const sourceLinks = rows.flatMap((row) =>
    externalBriefSources(row)
      .filter((source) => Boolean(source.url))
      .slice(0, 3)
      .map((source) => ({
        label: `${externalBriefBusinessLabel(businessFromExternalSource(row.source))} ${source.label}`,
        url: source.url as string,
        source: source.type,
      }))
  )

  const briefPayload = rows.map((row) => ({
    business: externalBriefBusinessLabel(businessFromExternalSource(row.source)),
    source: row.source,
    summary: row.content,
    urgency_score: externalBriefUrgency(row),
    action_items: externalBriefActionItems(row),
    sources: externalBriefSources(row),
    created_at: row.created_at,
  }))

  return {
    context: `External automation briefs from odin_memories, last 24h. Treat these as the primary morning-brief source when present. If both businesses are present, synthesize one answer and prioritize by urgency_score, then revenue at risk, owner waiting, team overdue. If one business is missing, mention that business as quiet in one sentence. Maximum 3 sentences and exactly one suggested action.\n${JSON.stringify(briefPayload)}`,
    signals,
    sourceLinks,
    warnings: [],
    status: missing.length ? "partial" : "ok",
    count: rows.length,
  }
}

async function scanSlack(req: Request, query: string, userId: string): Promise<{
  context: string
  signals: OperationsSignal[]
  sourceLinks: OdinCommandResponse["sourceLinks"]
  drafts: OdinCommandResponse["drafts"]
  warnings: string[]
  status: "ok" | "partial" | "failed"
}> {
  if (!supabaseUrl) {
    return {
      context: "Slack scan unavailable: SUPABASE_URL is not configured.",
      signals: [],
      sourceLinks: [],
      drafts: [],
      warnings: ["Slack scan unavailable: SUPABASE_URL is not configured."],
      status: "failed",
    }
  }

  try {
    const internalSecret = odinInternalFunctionSecret()
    const res = await fetch(`${supabaseUrl}/functions/v1/slack-intel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: req.headers.get("authorization") ?? "",
        ...(internalSecret ? { "x-odin-internal-secret": internalSecret } : {}),
        "x-odin-user-id": userId,
        ...(supabaseAnonKey ? { apikey: supabaseAnonKey } : {}),
      },
      body: JSON.stringify(slackDates(query)),
    })
    const json = (await res.json()) as { data?: SlackIntelResult; error?: string }
    if (!res.ok || json.error || !json.data) {
      throw new Error(json.error ?? `Slack HTTP ${res.status}`)
    }
    const result = json.data
    const topItems = result.items.slice(0, 12)
    const signals = topItems.map((item, index) => ({
      id: `slack-${item.workspace}-${item.channel}-${item.sent_at}-${index}`.toLowerCase(),
      source: "slack" as const,
      category: item.urgency === "critical" || item.urgency === "high" ? "urgent" as const : signalCategory(`${item.summary} ${item.action}`),
      title: item.person ? `${item.person} needs attention` : item.channel,
      summary: item.summary,
      evidence: item.evidence,
      nextAction: item.action,
      suggestedReply: item.reply,
      sourceUrl: item.permalink,
      person: item.person,
      business: businessFromText(`${item.workspace} ${item.channel} ${item.summary}`),
      status: "open" as const,
    }))
    const warnings = Array.from(
      new Set(
        (result.warnings ?? [])
          .filter(
            (warning) =>
              !/Claude returned no qualifying DOO items|AI refinement timed out/i.test(warning)
          )
          .map(normalizeSlackWarning)
      )
    )
    return {
      context: `Slack scan: ${result.workspacesScanned} workspaces, ${result.channelsScanned} channels, ${result.messagesScanned} messages. Items: ${JSON.stringify(topItems)}`,
      signals,
      sourceLinks: topItems
        .filter((item) => Boolean(item.permalink))
        .slice(0, 10)
        .map((item) => ({
          label: item.person ? `${item.person} in ${item.workspace}` : `${item.channel} in ${item.workspace}`,
          url: item.permalink as string,
          source: "slack",
        })),
      drafts: topItems
        .filter((item) => Boolean(item.reply))
        .slice(0, 5)
        .map((item) => ({
          target: item.person ?? item.channel,
          text: item.reply as string,
          sourceUrl: item.permalink,
        })),
      warnings,
      status: warnings.length ? "partial" : "ok",
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Slack scan failed"
    const message = normalizeSlackWarning(rawMessage)
    return {
      context: `Slack scan failed: ${message}`,
      signals: [],
      sourceLinks: [],
      drafts: [],
      warnings: [message],
      status: "failed",
    }
  }
}

async function scanGmail(userId: string, accounts: AccountSummary[], query = "", windowDaysOverride?: number): Promise<{
  context: string
  signals: OperationsSignal[]
  sourceLinks: OdinCommandResponse["sourceLinks"]
  warnings: string[]
  status: "ok" | "partial" | "failed"
}> {
  if (accounts.length === 0) {
    return {
      context: "Gmail is not connected.",
      signals: [],
      sourceLinks: [],
      warnings: ["Gmail is not connected."],
      status: "partial",
    }
  }

  const warnings: string[] = []
  const openThreads: GmailOpenThread[] = []
  const lower = query.toLowerCase()
  const deepScan = /\b(deep|all emails|a lot of emails|many emails|pull a lot|last 30|30 days|full inbox)\b/.test(lower)
  const windowDays = windowDaysOverride ?? (deepScan ? 30 : 7)
  const maxResults = deepScan ? 24 : 12

  await Promise.all(
    accounts.slice(0, 3).map(async (account) => {
      try {
        const qs = new URLSearchParams({
          q: `in:inbox newer_than:${windowDays}d`,
          maxResults: String(maxResults),
        })
        const list = await googleFetchJson<GmailListResponse>(
          userId,
          `${GMAIL_BASE}/messages?${qs.toString()}`,
          {},
          account.id
        )
        const threadIds = [...new Set((list.messages ?? []).slice(0, maxResults).map((msg) => msg.threadId))]
        const fetched = await Promise.all(
          threadIds.map((threadId) => {
            const meta = new URLSearchParams({ format: "metadata" })
            meta.append("metadataHeaders", "From")
            meta.append("metadataHeaders", "Subject")
            meta.append("metadataHeaders", "Date")
            return googleFetchJson<GmailThread>(
              userId,
              `${GMAIL_BASE}/threads/${threadId}?${meta.toString()}`,
              {},
              account.id
            )
          })
        )
        fetched.forEach((thread) => {
          const open = openThreadFromGmailThread(account, thread)
          if (open) openThreads.push(open)
        })
      } catch (err) {
        warnings.push(`${account.account_label ?? account.account_email ?? "Gmail"}: ${err instanceof Error ? err.message : "scan failed"}`)
      }
    })
  )

  const bySender = new Map<string, GmailOpenThread[]>()
  openThreads.forEach((thread) => {
    const list = bySender.get(thread.senderKey) ?? []
    list.push(thread)
    bySender.set(thread.senderKey, list)
  })
  const senderBriefs = [...bySender.values()]
    .map((threads) => {
      const sorted = threads.sort((a, b) => b.urgencyScore - a.urgencyScore)
      return {
        sender: sorted[0].sender,
        openThreadCount: sorted.length,
        hottestThread: sorted[0],
      }
    })
    .sort((a, b) => b.hottestThread.urgencyScore - a.hottestThread.urgencyScore)
    .slice(0, deepScan ? 8 : 5)

  const signals = senderBriefs.slice(0, 5)
    .map(({ sender: senderName, openThreadCount, hottestThread }) => {
      const text = [
        senderName,
        hottestThread.subject,
        hottestThread.preview,
        hottestThread.account.account_label,
        hottestThread.account.account_email,
      ]
        .filter(Boolean)
        .join(" ")
      const plural = openThreadCount === 1 ? "thread" : "threads"
      return {
        id: `gmail-${hottestThread.account.id}-${hottestThread.threadId}`,
        source: "gmail" as const,
        category: hottestThread.urgencyScore >= 70 ? "urgent" as const : signalCategory(text),
        title: `${senderName}: ${openThreadCount} open Gmail ${plural}`,
        summary: `Hottest: ${hottestThread.subject}. ${short(hottestThread.preview, 120)}`,
        evidence: `${hottestThread.hoursSinceLastMessage}h since last message · question=${hottestThread.hasQuestion} · action=${hottestThread.hasActionWord}`,
        nextAction: `Reply to ${senderName}'s "${hottestThread.subject}" thread first if Gmail is the current bottleneck.`,
        sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${hottestThread.threadId}`,
        person: senderName,
        business: businessFromText(text),
        status: "open" as const,
      }
    })

  return {
    context: `Gmail sender/thread scan: ${openThreads.length} open unanswered operational threads from the last ${windowDays} days${deepScan ? " (expanded email request)" : ""}. Threads already answered by Peter, FYI-only low-priority mail, promos, login-only mail, and newsletters are suppressed. Summarize what each sender needs. Prioritize by urgency using time decay and action words. Reference known ODIN memory patterns when useful. Suggest ONE non-obvious move. Max 3 sentences. Sender briefs: ${JSON.stringify(
      senderBriefs.map(({ sender, openThreadCount, hottestThread }) => ({
        sender,
        openThreadCount,
        hottest: {
          subject: hottestThread.subject,
          preview: short(hottestThread.preview, 100),
          hoursSinceLastMessage: hottestThread.hoursSinceLastMessage,
          hasQuestion: hottestThread.hasQuestion,
          hasActionWord: hottestThread.hasActionWord,
          account: hottestThread.account.account_label ?? hottestThread.account.account_email,
        },
      }))
    )}`,
    signals,
    sourceLinks: senderBriefs.slice(0, 6).map(({ hottestThread }) => ({
      label: hottestThread.subject || "Gmail thread",
      url: `https://mail.google.com/mail/u/0/#inbox/${hottestThread.threadId}`,
      source: "gmail",
    })),
    warnings,
    status: warnings.length ? "partial" : "ok",
  }
}

async function scanCalendar(userId: string, accounts: AccountSummary[], query: string): Promise<{
  context: string
  signals: OperationsSignal[]
  sourceLinks: OdinCommandResponse["sourceLinks"]
  warnings: string[]
  status: "ok" | "partial" | "failed"
}> {
  if (accounts.length === 0) {
    return {
      context: "Google Calendar is not connected.",
      signals: [],
      sourceLinks: [],
      warnings: ["Google Calendar is not connected."],
      status: "partial",
    }
  }

  const range = rangeFromQuery(query)
  const warnings: string[] = []
  const events: Array<{ account: AccountSummary; event: CalendarEvent }> = []

  await Promise.all(
    accounts.slice(0, 3).map(async (account) => {
      try {
        const qs = new URLSearchParams({
          timeMin: range.timeMin,
          timeMax: range.timeMax,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "12",
        })
        const calendars = await googleFetchJson<{ items?: CalendarListEntry[] }>(
          userId,
          `${CALENDAR_BASE}/users/me/calendarList`,
          {},
          account.id
        )
        const visibleCalendars = (calendars.items ?? [])
          .filter((calendar) => calendar.selected !== false)
          .slice(0, 10)
        const calendarsToScan = visibleCalendars.length
          ? visibleCalendars
          : [{ id: "primary", summary: "Primary", primary: true, selected: true }]

        const eventResults = await Promise.all(
          calendarsToScan.map(async (calendar) => {
            try {
              const data = await googleFetchJson<{ items?: CalendarEvent[] }>(
                userId,
                `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendar.id)}/events?${qs.toString()}`,
                {},
                account.id
              )
              return (data.items ?? []).map((event) => ({
                ...event,
                sourceCalendarId: calendar.id,
                sourceCalendarSummary: calendar.summary,
              }))
            } catch (err) {
              warnings.push(
                `${account.account_label ?? account.account_email ?? "Calendar"} / ${calendar.summary ?? calendar.id}: ${
                  err instanceof Error ? err.message : "scan failed"
                }`
              )
              return []
            }
          })
        )
        eventResults.flat().forEach((event) => events.push({ account, event }))
      } catch (err) {
        warnings.push(`${account.account_label ?? account.account_email ?? "Calendar"}: ${err instanceof Error ? err.message : "scan failed"}`)
      }
    })
  )

  const sorted = events
    .sort((a, b) => {
      const av = a.event.start?.dateTime ?? a.event.start?.date ?? ""
      const bv = b.event.start?.dateTime ?? b.event.start?.date ?? ""
      return av.localeCompare(bv)
    })
    .slice(0, 12)

  const signals = sorted.slice(0, 5).map(({ account, event }) => ({
    id: `calendar-${account.id}-${event.id}`,
    source: "calendar" as const,
    category: "today" as const,
    title: event.summary ?? "(no title)",
    summary: [
      calendarTimeForPeter(event.start) ?? "time not set",
      event.location,
      account.account_label ?? account.account_email,
    ]
      .filter(Boolean)
      .join(" · "),
    evidence: event.organizer?.email,
    nextAction: event.hangoutLink ? "Open the meeting link or prepare before start time." : "Review schedule and prepare before start time.",
    sourceUrl: event.htmlLink ?? event.hangoutLink,
    dueAt: event.start?.dateTime ?? event.start?.date,
    business: businessFromText(`${event.summary ?? ""} ${event.location ?? ""}`),
    status: "open" as const,
  }))

  return {
    context: `Calendar scan: ${range.label}. Events: ${JSON.stringify(
      sorted.map(({ account, event }) => ({
        account: account.account_label ?? account.account_email,
        title: event.summary,
        start: event.start,
        peterTime: calendarTimeForPeter(event.start),
        location: event.location,
        calendar: event.sourceCalendarSummary,
        htmlLink: event.htmlLink,
      }))
    )}`,
    signals,
    sourceLinks: sorted
      .filter(({ event }) => Boolean(event.htmlLink || event.hangoutLink))
      .slice(0, 6)
      .map(({ event }) => ({
        label: event.summary ?? "Calendar event",
        url: (event.htmlLink ?? event.hangoutLink) as string,
        source: "calendar",
      })),
    warnings,
    status: warnings.length ? "partial" : "ok",
  }
}

function defaultHealthPlanBlocks() {
  const date = manilaDate(0)
  return [
    {
      title: "Recovery Walk",
      startTime: "09:00",
      durationMinutes: 20,
      description: "Easy Zone 1/2 walk. Recovery-first because Withings sleep and heart-rate context are limiting today.",
    },
    {
      title: "Mobility Reset",
      startTime: "14:00",
      durationMinutes: 10,
      description: "Light mobility, hips/hamstrings/upper back. Keep it easy.",
    },
    {
      title: "Wind-down / Sleep Protection",
      startTime: "22:30",
      durationMinutes: 45,
      description: "No hard work, no caffeine, low light, notifications down. Protect sleep after a short night.",
    },
  ].map((block) => ({
    ...block,
    date,
    endTime: addMinutesToClock(block.startTime, block.durationMinutes),
  }))
}

async function writeHealthPlanEvents(
  userId: string,
  accounts: AccountSummary[]
): Promise<OdinCommandResponse> {
  const account = accounts.find(hasCalendarWriteScope)
  if (!account) {
    return responseWithResponsibilityMeta({
      spokenText:
        "I can schedule the health plan after Google Calendar is reconnected with write access. Right now all connected Google accounts are still read-only.",
      displayText:
        "I can schedule the health plan after Google Calendar is reconnected with write access. Right now all connected Google accounts are still read-only. Open Calendar, reconnect Google Calendar once, then confirm again.",
      signals: [],
      sourceLinks: [],
      drafts: [],
      warnings: ["Google Calendar write scope is not granted yet."],
      toolRuns: [{ tool: "calendar_write", status: "partial" }],
      suggestions: ["Reconnect Google Calendar.", "Schedule my health plan."],
    }, {
      sourceFreshness: EMPTY_SOURCE_FRESHNESS,
      learningSummary: EMPTY_LEARNING_SUMMARY,
      pendingSummary: EMPTY_PENDING_SUMMARY,
    })
  }

  const blocks = defaultHealthPlanBlocks()
  const created: CalendarEvent[] = []
  const warnings: string[] = []
  for (const block of blocks) {
    try {
      const event = await googleFetchJson<CalendarEvent>(
        userId,
        `${CALENDAR_BASE}/calendars/primary/events`,
        {
          method: "POST",
          body: JSON.stringify({
            summary: block.title,
            description: block.description,
            start: {
              dateTime: manilaDateTime(block.date, block.startTime),
              timeZone: "Asia/Manila",
            },
            end: {
              dateTime: manilaDateTime(block.date, block.endTime),
              timeZone: "Asia/Manila",
            },
          }),
        },
        account.id
      )
      created.push(event)
    } catch (err) {
      warnings.push(`${block.title}: ${err instanceof Error ? err.message : "create failed"}`)
    }
  }

  const blockText = blocks
    .map((block) => `${block.title} at ${block.startTime} Manila`)
    .join(", ")
  const displayText = created.length
    ? `Scheduled ${created.length} health block${created.length === 1 ? "" : "s"} on ${account.account_label ?? account.account_email ?? "Google Calendar"}: ${blockText}.`
    : "I tried to schedule the health plan, but Google Calendar rejected every event."

  return responseWithResponsibilityMeta({
    spokenText: displayText,
    displayText,
    signals: created.map((event, index) => ({
      id: `health-plan-${event.id ?? index}`,
      source: "calendar" as const,
      category: "today" as const,
      title: event.summary ?? blocks[index]?.title ?? "Health block",
      summary: calendarTimeForPeter(event.start) ?? blocks[index]?.startTime ?? "Scheduled",
      nextAction: "Keep this block light and recovery-focused.",
      sourceUrl: event.htmlLink,
      business: "Personal" as const,
      status: "open" as const,
    })),
    sourceLinks: created
      .filter((event) => Boolean(event.htmlLink))
      .map((event) => ({
        label: event.summary ?? "Health block",
        url: event.htmlLink as string,
        source: "calendar",
      })),
    drafts: [],
    warnings,
    toolRuns: [{ tool: "calendar_write", status: warnings.length ? "partial" : "ok" }],
    suggestions: ["Show today's calendar.", "How ready am I today?"],
  }, {
    sourceFreshness: EMPTY_SOURCE_FRESHNESS,
    learningSummary: EMPTY_LEARNING_SUMMARY,
    pendingSummary: EMPTY_PENDING_SUMMARY,
  })
}

function weatherLocation(input?: WeatherLocationInput): Required<WeatherLocationInput> {
  const lat = typeof input?.lat === "number" && Number.isFinite(input.lat) ? input.lat : 14.1709
  const lon = typeof input?.lon === "number" && Number.isFinite(input.lon) ? input.lon : 121.2437
  const label = typeof input?.label === "string" && input.label.trim() ? short(input.label, 48) : "Laguna, PH"
  const source =
    input?.source === "browser" || input?.source === "manual" || input?.source === "default"
      ? input.source
      : "default"
  return { lat, lon, label, source }
}

async function scanWeather(locationInput?: WeatherLocationInput): Promise<{
  context: string
  signals: OperationsSignal[]
  sourceLinks: OdinCommandResponse["sourceLinks"]
  warnings: string[]
  status: "ok" | "partial" | "failed"
}> {
  const location = weatherLocation(locationInput)
  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    current: "temperature_2m,weather_code",
    timezone: "auto",
  })
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)
    const data = (await res.json()) as OpenMeteoResponse
    const temperature = numberOrNull(data.current?.temperature_2m)
    const code = numberOrNull(data.current?.weather_code)
    const summary = `${temperature ?? "unknown"}°C and ${weatherSummary(code)} in ${location.label}`

    return {
      context: `Weather scan: ${summary}. Location source: ${location.source}. Coordinates rounded: ${location.lat.toFixed(3)}, ${location.lon.toFixed(3)}.`,
      signals: [
        {
          id: `weather-${location.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${manilaDate(0)}`,
          source: "weather",
          category: "today",
          title: `${location.label} weather`,
          summary,
          evidence: "Open-Meteo",
          nextAction:
            temperature !== null && temperature >= 32
              ? "Expect a warm day; leave buffer for travel and outdoor errands."
              : "Use this as context for today's schedule.",
          business: "Personal",
          status: "open",
        },
      ],
      sourceLinks: [{ label: `Open-Meteo ${location.label} forecast`, url, source: "weather" }],
      warnings: [],
      status: "ok",
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "weather scan failed"
    return {
      context: `Weather scan failed: ${message}`,
      signals: [],
      sourceLinks: [],
      warnings: [message],
      status: "partial",
    }
  }
}

function parseWithingsSleep(body: WithingsSleepBody) {
  const item = [...(body.series ?? [])]
    .sort((a, b) => {
      const aDate = typeof a.date === "string" ? a.date : ""
      const bDate = typeof b.date === "string" ? b.date : ""
      return bDate.localeCompare(aDate)
    })
    .find((entry) => {
      const data = recordOrEmpty(entry.data)
      const total =
        (numericField(entry, data, "lightsleepduration") ?? 0) +
        (numericField(entry, data, "deepsleepduration") ?? 0) +
        (numericField(entry, data, "remsleepduration") ?? 0)
      return (
        total > 0 ||
        numericField(entry, data, "total_sleep_time") !== null ||
        numericField(entry, data, "asleepduration") !== null
      )
    })
  if (!item) return { minutes: null as number | null, date: null as string | null }
  const data = recordOrEmpty(item.data)
  const stageTotal =
    (numericField(item, data, "lightsleepduration") ?? 0) +
    (numericField(item, data, "deepsleepduration") ?? 0) +
    (numericField(item, data, "remsleepduration") ?? 0)
  const seconds =
    stageTotal > 0
      ? stageTotal
      : numericField(item, data, "total_sleep_time") ??
        numericField(item, data, "asleepduration")
  return {
    minutes: seconds === null ? null : Math.round(seconds / 60),
    date: typeof item.date === "string" ? item.date : null,
  }
}

function latestWithingsMeasure(body: WithingsMeasureGroupsBody, type: number) {
  const groups = [...(body.measuregrps ?? [])].sort(
    (a, b) => (b.date ?? 0) - (a.date ?? 0)
  )
  for (const group of groups) {
    const measure = group.measures?.find((entry) => entry.type === type)
    if (!measure) continue
    const value = measureValue(measure)
    if (value === null) continue
    return { date: group.date ?? null, value }
  }
  return null
}

function parseWithingsWorkouts(body: WithingsWorkoutsBody) {
  const series = [...(body.series ?? [])].sort((a, b) => {
    const aDate = numberOrNull(a.startdate) ?? numberOrNull(a.date) ?? 0
    const bDate = numberOrNull(b.startdate) ?? numberOrNull(b.date) ?? 0
    return bDate - aDate
  })
  const latest = series[0]
  if (!latest) {
    return {
      recentCount: 0,
      latest: null as null | {
        startedAt: string | null
        durationMinutes: number | null
        calories: number | null
        steps: number | null
        distanceMeters: number | null
        averageHeartRate: number | null
      },
    }
  }
  const data = recordOrEmpty(latest.data)
  const start = numberOrNull(latest.startdate) ?? numberOrNull(latest.date)
  const end = numberOrNull(latest.enddate)
  const rawDuration = numericField(latest, data, "duration")
  const durationMinutes =
    start !== null && end !== null && end > start
      ? Math.round((end - start) / 60)
      : rawDuration === null
        ? null
        : Math.round(rawDuration / 60)

  return {
    recentCount: series.length,
    latest: {
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

function withingsHealthCoachAction({
  sleepMinutes,
  steps,
  heart,
  bmi,
  workoutCount,
}: {
  sleepMinutes: number | null
  steps: number | null
  heart: number | null
  bmi: number | null
  workoutCount: number | null
}) {
  if (typeof heart === "number" && heart >= 95) {
    return "If that pulse is resting, downshift first: breathe, hydrate, and avoid max-effort training."
  }
  if (typeof sleepMinutes === "number" && sleepMinutes < 360) {
    return "Recovery is the limiter today; keep training light, take one easy walk, and protect sleep tonight."
  }
  if (typeof steps === "number" && steps < 4000) {
    return "Movement is the cleanest lever today; get one easy walk before the next work block and aim for 7,000 steps."
  }
  if (typeof bmi === "number" && bmi >= 25) {
    return "Body composition is the main trend to manage: protein, fiber, steady steps, and no crash dieting."
  }
  if (workoutCount === 0) {
    return "Training consistency is the missing signal; add two short strength sessions this week."
  }
  return "Keep the plan boring and repeatable: walk daily, lift twice this week, and keep bedtime protected."
}

async function loadHealthProfileScan(userId: string): Promise<SourceScanResult> {
  const { data, error } = await getAdminClient()
    .from("health_profiles")
    .select(
      "focus,target_weight_kg,daily_steps,sleep_hours,strength_days,protein_grams,diet_style,notes,context_summaries,active_plan,active_plan_selected_at,updated_at"
    )
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    const message = `Saved health profile unavailable: ${error.message}`
    return {
      context: message,
      signals: [],
      sourceLinks: [],
      warnings: [message],
      status: "partial",
    }
  }

  if (!data) {
    return {
      context: "Saved ODIN health profile: no saved goals or selected plan yet. Fall back to Withings-only coaching.",
      signals: [],
      sourceLinks: [],
      warnings: [],
      status: "partial",
    }
  }

  const row = data as HealthProfileRow
  const profile = healthProfileSummary(row)
  return {
    context: profile.context,
    signals: [
      {
        id: `health-profile-${userId}`,
        source: "health",
        category: "routine",
        title: "Saved ODIN health plan",
        summary: profile.signalSummary,
        evidence: "health_profiles",
        nextAction: profile.nextAction,
        business: "Personal",
        status: "open",
      },
    ],
    sourceLinks: [],
    warnings: [],
    status: "ok",
  }
}

async function scanHealth(userId: string, accounts: AccountSummary[]): Promise<{
  context: string
  signals: OperationsSignal[]
  sourceLinks: OdinCommandResponse["sourceLinks"]
  warnings: string[]
  status: "ok" | "partial" | "failed"
}> {
  const account = accounts[0]
  if (!account) {
    return {
      context: "Withings health is not connected.",
      signals: [],
      sourceLinks: [],
      warnings: ["Withings health is not connected."],
      status: "partial",
    }
  }

  const now = new Date()
  const today = startOfDay(now)
  const sleepStart = new Date(today)
  sleepStart.setDate(today.getDate() - 14)
  const measureStart = new Date(today)
  measureStart.setDate(today.getDate() - 180)
  const workoutStart = new Date(today)
  workoutStart.setDate(today.getDate() - 30)
  const warnings: string[] = []

  const [activityResult, sleepResult, bodyMeasureResult, workoutsResult] = await Promise.allSettled([
    withingsPostJson<WithingsActivityBody>(
      userId,
      "/v2/measure",
      {
        action: "getactivity",
        startdateymd: ymd(today),
        enddateymd: ymd(today),
        data_fields:
          "steps,distance,calories,totalcalories,hr_average,hr_min,hr_max",
      },
      account.id
    ),
    withingsPostJson<WithingsSleepBody>(
      userId,
      "/v2/sleep",
      {
        action: "getsummary",
        startdateymd: ymd(sleepStart),
        enddateymd: ymd(today),
        data_fields:
          "total_sleep_time,durationtosleep,wakeupcount,lightsleepduration,deepsleepduration,remsleepduration,durationinbed,sleep_score",
      },
      account.id
    ),
    withingsPostJson<WithingsMeasureGroupsBody>(
      userId,
      "/measure",
      {
        action: "getmeas",
        meastypes: "1,4,5,6,8,9,10,11,54,71,73,76,77,88,91,119",
        category: 1,
        startdate: Math.floor(measureStart.getTime() / 1000),
        enddate: Math.floor(now.getTime() / 1000),
      },
      account.id
    ),
    withingsPostJson<WithingsWorkoutsBody>(
      userId,
      "/v2/measure",
      {
        action: "getworkouts",
        lastupdate: Math.floor(workoutStart.getTime() / 1000),
        data_fields:
          "calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation",
      },
      account.id
    ),
  ])

  if (activityResult.status === "rejected") {
    warnings.push(`Withings activity: ${activityResult.reason instanceof Error ? activityResult.reason.message : "scan failed"}`)
  }
  if (sleepResult.status === "rejected") {
    warnings.push(`Withings sleep: ${sleepResult.reason instanceof Error ? sleepResult.reason.message : "scan failed"}`)
  }
  if (bodyMeasureResult.status === "rejected") {
    warnings.push(`Withings body metrics: ${bodyMeasureResult.reason instanceof Error ? bodyMeasureResult.reason.message : "scan failed"}`)
  }
  if (workoutsResult.status === "rejected") {
    warnings.push(`Withings workouts: ${workoutsResult.reason instanceof Error ? workoutsResult.reason.message : "scan failed"}`)
  }

  const activity = activityResult.status === "fulfilled" ? activityResult.value.activities?.[0] : undefined
  const latestHeart =
    numberOrNull(activity?.hr_average) ??
    (bodyMeasureResult.status === "fulfilled"
      ? latestWithingsMeasure(bodyMeasureResult.value, 11)?.value ?? null
      : null)
  const weightKg =
    bodyMeasureResult.status === "fulfilled"
      ? latestWithingsMeasure(bodyMeasureResult.value, 1)?.value ?? null
      : null
  const heightM =
    bodyMeasureResult.status === "fulfilled"
      ? latestWithingsMeasure(bodyMeasureResult.value, 4)?.value ?? null
      : null
  const bmi =
    weightKg !== null && heightM !== null && heightM > 0
      ? Number((weightKg / (heightM * heightM)).toFixed(1))
      : null
  const sleep = sleepResult.status === "fulfilled"
    ? parseWithingsSleep(sleepResult.value)
    : { minutes: null, date: null }
  const steps = numberOrNull(activity?.steps)
  const calories = numberOrNull(activity?.totalcalories) ?? numberOrNull(activity?.calories)
  const workouts =
    workoutsResult.status === "fulfilled"
      ? parseWithingsWorkouts(workoutsResult.value)
      : { recentCount: 0, latest: null }
  const workoutSummary =
    workouts.recentCount > 0
      ? `workouts ${workouts.recentCount} in 30d${
          workouts.latest?.durationMinutes
            ? `, latest ${workouts.latest.durationMinutes}m`
            : ""
        }`
      : "no workouts in last 30d"

  const summaryParts = [
    latestHeart === null ? "heart rate unavailable" : `heart ${Math.round(latestHeart)} bpm`,
    steps === null ? "steps unavailable" : `${steps.toLocaleString()} steps`,
    calories === null ? "calories unavailable" : `${Math.round(calories).toLocaleString()} calories`,
    weightKg === null ? "weight unavailable" : `weight ${Number(weightKg.toFixed(1))} kg`,
    bmi === null ? "BMI unavailable" : `BMI ${bmi}`,
    workoutSummary,
    sleep.minutes === null
      ? "sleep unavailable from Withings"
      : `sleep ${Math.floor(sleep.minutes / 60)}h ${sleep.minutes % 60}m`,
  ]
  if (latestHeart === null && steps === null && calories === null && sleep.minutes === null && weightKg === null && workouts.recentCount === 0) {
    warnings.push("Withings returned no usable activity, heart, sleep, body, workout, or calorie data in this scan window.")
  }
  const coachAction = withingsHealthCoachAction({
    sleepMinutes: sleep.minutes,
    steps,
    heart: latestHeart === null ? null : Math.round(latestHeart),
    bmi,
    workoutCount: workouts.recentCount,
  })

  const sourceLinks = [
    {
      label: account.account_label ?? "Withings",
      url: "https://healthmate.withings.com/",
      source: "health",
    },
  ]

  return {
	    context: `Withings health scan for ${account.account_label ?? "Withings"}: ${summaryParts.join(", ")}. Coach action: ${coachAction}. Raw availability: ${JSON.stringify({
	      account: account.account_label ?? account.account_email,
	      date: ymd(today),
	      heartBpm: latestHeart === null ? null : Math.round(latestHeart),
	      steps,
	      calories,
	      weightKg,
	      heightM,
	      bmi,
	      workouts,
	      sleepMinutes: sleep.minutes,
	      sleepDate: sleep.date,
	      warnings,
    })}`,
    signals: [
      {
        id: `health-${account.id}-${ymd(today)}`,
        source: "health",
        category: "routine",
        title: "Vitals from Withings",
	        summary: summaryParts.join(" · "),
	        evidence: account.account_label ?? "Withings",
	        nextAction: coachAction,
        sourceUrl: "https://healthmate.withings.com/",
        business: "Personal",
        status: "open",
      },
    ],
    sourceLinks,
    warnings,
    status: warnings.length ? "partial" : "ok",
  }
}

async function latestBrowserContext(userId: string): Promise<string> {
  const { data, error } = await getAdminClient()
    .from("agent_jobs")
    .select("type,status,result,error,completed_at,updated_at")
    .eq("user_id", userId)
    .in("type", [
      "slack_browser_scan",
      "gmail_browser_scan",
      "combined_doo_scan",
      "browser_open",
      "browser_observe",
      "browser_agent_task",
    ])
    .in("status", ["completed", "login_required", "awaiting_confirmation"])
    .order("updated_at", { ascending: false })
    .limit(2)

  if (error || !data?.length) return "Browser worker: no recent browser evidence."
  return `Browser worker recent jobs: ${JSON.stringify(data)}`
}

async function loadOdinMemoryContext(userId: string): Promise<string> {
  const { data, error } = await getAdminClient()
    .from("odin_memories")
    .select("kind,title,content,source,confidence,updated_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(24)

  if (error || !data?.length) {
    return "ODIN memory: no active manual memories found."
  }

  return `ODIN memory. Use this only as durable preference/business context; do not treat it as fresh Slack/Gmail evidence: ${JSON.stringify(data)}`
}

async function recentConversationContext(
  userId: string,
  conversationId?: string
): Promise<string> {
  if (!conversationId) return "Conversation continuity: no prior conversation id supplied."

  const { data, error } = await getAdminClient()
    .from("odin_conversation_events")
    .select("role,mode,content,created_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(8)

  if (error || !data?.length) {
    return "Conversation continuity: no stored prior turns for this session."
  }

  return `Recent ODIN conversation turns, newest first: ${JSON.stringify(data.reverse())}`
}

async function recordConversationEvent(args: {
  userId: string
  conversationId?: string
  turnId?: string
  source: Source | "system" | "tool"
  role: "user" | "assistant" | "tool" | "system"
  mode?: Mode
  content: string
  payload?: Record<string, unknown>
}) {
  await getAdminClient()
    .from("odin_conversation_events")
    .insert({
      user_id: args.userId,
      conversation_id: args.conversationId ?? null,
      turn_id: args.turnId ?? null,
      source: args.source,
      role: args.role,
      mode: args.mode ?? null,
      content: args.content,
      payload: args.payload ?? {},
    })
    .throwOnError()
}

function suggestionsForMode(mode: Mode): string[] {
  if (mode === "calendar") return ["What should I prepare for?", "Show tomorrow.", "Open Calendar."]
  if (mode === "gmail") return ["Draft replies.", "Only owner/vendor emails.", "Scan the last 7 days."]
  if (mode === "slack") return ["Show direct links.", "Only DMs.", "What should I answer first?"]
  if (mode === "health") return ["Schedule my health plan.", "How ready am I today?", "Show sleep only."]
  if (mode === "weather") return ["Use exact location.", "Refresh weather.", "Open Time & Weather."]
  if (mode === "browser") return ["Open Browser.", "Observe this page.", "Propose browser actions."]
  if (mode === "research") return ["Summarize the decision.", "Give me pros and cons.", "What is the next move?"]
  if (mode === "chat") return ["What can you do?", "Give me a morning brief.", "Scan urgent Gmail."]
  return ["What should I do first?", "Open source links.", "Draft the replies."]
}

function conversationStateFor(args: {
  mode: Mode
  query: string
  toolRuns: OdinCommandResponse["toolRuns"]
  signals: OperationsSignal[]
}): OdinCommandResponse["conversationState"] {
  const scanned = args.toolRuns
    .filter((tool) => tool.status === "ok" || tool.status === "partial")
    .map((tool) => tool.tool)
    .join(", ")
  return {
    activeTopic: args.mode === "chat" ? "conversation" : args.mode,
    lastSourceScan: scanned || undefined,
    unresolvedQuestion: args.signals.length
      ? args.signals[0].nextAction ?? args.signals[0].title
      : null,
  }
}

async function buildResearchContext(query: string): Promise<{
  context: string
  sourceLinks: OdinCommandResponse["sourceLinks"]
  warnings: string[]
  status: "ok" | "partial" | "failed"
}> {
  const urls = extractUrls(query)
  const sourceLinks: OdinCommandResponse["sourceLinks"] = []
  const warnings: string[] = []
  const evidence: string[] = [
    `Peter profile: Peter Karl Gumapac runs Stay Minty glamping/cabins and Dinbnb short-term-rental operations. ODIN should answer like a private operations analyst: practical, concise, and tuned for guest experience, owners, vendors, team follow-up, schedule, and personal execution.`,
    `Research/process request: ${query}`,
  ]

  await Promise.all(
    urls.map(async (url) => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 8000)
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "user-agent": "ODIN by GUMAPAC research assistant",
            accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
          },
        })
        clearTimeout(timeout)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const contentType = res.headers.get("content-type") ?? ""
        const raw = await res.text()
        const text = contentType.includes("html") ? htmlToText(raw) : raw.replace(/\s+/g, " ").trim()
        evidence.push(`Fetched source ${url}: ${short(text, 5000)}`)
        sourceLinks.push({ label: new URL(url).hostname, url, source: "research" })
      } catch (err) {
        warnings.push(`${url}: ${err instanceof Error ? err.message : "fetch failed"}`)
      }
    })
  )

  return {
    context: evidence.join("\n\n"),
    sourceLinks,
    warnings,
    status: warnings.length && sourceLinks.length === 0 ? "partial" : "ok",
  }
}

function fallbackResponse(parts: {
  query: string
  mode: Mode
  tone: OdinTone
  signals: OperationsSignal[]
  links: OdinCommandResponse["sourceLinks"]
  drafts: OdinCommandResponse["drafts"]
  warnings: string[]
  toolRuns: OdinCommandResponse["toolRuns"]
}): OdinCommandResponse {
  const top = parts.signals.slice(0, 3)
  const isWakeBrief = isMorningBriefQuery(parts.query, parts.mode)
  if (isWakeBrief) {
    const primary = primaryMorningSignal(parts.signals)
    return {
      spokenText: morningBriefSpokenText(parts.signals),
      displayText: [
        "Morning brief",
        "",
        `Topic: ${primary?.title ?? "No surfaced priority"}`,
        `Urgency: ${morningUrgency(primary)}`,
        `Next action: ${primary?.nextAction ?? primary?.summary ?? "Stay available; no immediate action is surfaced."}`,
        "",
        "Supporting signals stay on screen; voice should not read every source.",
      ].join("\n"),
      signals: primary ? [primary, ...parts.signals.filter((signal) => signal.id !== primary.id).slice(0, 2)] : [],
      sourceLinks: parts.links,
      drafts: parts.drafts.slice(0, 1),
      warnings: parts.warnings.slice(0, 2),
      toolRuns: parts.toolRuns,
      suggestions: [
        "Show details.",
        "What should I do first?",
      ],
      conversationState: conversationStateFor({
        mode: parts.mode,
        query: parts.query,
        toolRuns: parts.toolRuns,
        signals: parts.signals,
      }),
    }
  }
  if (parts.mode === "health") {
    const profile = parts.signals.find((signal) => signal.title === "Saved ODIN health plan")
    const vitals = parts.signals.find((signal) => signal.title === "Vitals from Withings")
    const healthSignals = [profile, vitals].filter((signal): signal is OperationsSignal => Boolean(signal))
    if (profile) {
      return {
        spokenText: short(
          `Health overview, Peter. ${profile.summary}. ${vitals ? `Current Withings: ${vitals.summary}.` : ""} Next move: ${profile.nextAction ?? "keep the plan simple today."}`,
          650
        ),
        displayText: [
          "Health overview",
          "",
          profile.summary,
          vitals ? `Current Withings: ${vitals.summary}` : null,
          "",
          `Next: ${profile.nextAction ?? "Use the saved Health plan as the coaching baseline."}`,
          "Fitness coaching only; symptoms or abnormal readings still go to a clinician.",
        ].filter(Boolean).join("\n"),
        signals: healthSignals,
        sourceLinks: parts.links,
        drafts: parts.drafts,
        warnings: parts.warnings,
        toolRuns: parts.toolRuns,
        suggestions: ["Schedule my health plan.", "How ready am I today?", "Update health goals."],
        conversationState: conversationStateFor({
          mode: parts.mode,
          query: parts.query,
          toolRuns: parts.toolRuns,
          signals: healthSignals,
        }),
      }
    }
    const fallbackVitals = vitals ?? parts.signals.find((signal) => signal.source === "health")
    if (fallbackVitals) {
      return {
        spokenText: `Here are your Withings vitals, Peter. ${fallbackVitals.summary}. ${fallbackVitals.nextAction ?? "Use this as a readiness snapshot, not a diagnosis."}`,
        displayText: [
          "Withings vitals",
          "",
          fallbackVitals.summary,
          "",
          `What it means: ${fallbackVitals.nextAction ?? "Use this as a readiness snapshot for today."}`,
          "ODIN is reading sleep, movement, heart, weight, height, BMI, and workouts from Withings. Empty body-composition metrics stay hidden until Withings provides them.",
        ].join("\n"),
        signals: [fallbackVitals],
        sourceLinks: parts.links,
        drafts: parts.drafts,
        warnings: parts.warnings,
        toolRuns: parts.toolRuns,
        suggestions: ["How ready am I today?", "Show sleep only.", "What should I do first?"],
        conversationState: conversationStateFor({
          mode: parts.mode,
          query: parts.query,
          toolRuns: parts.toolRuns,
          signals: [fallbackVitals],
        }),
      }
    }
  }
  if (parts.mode === "weather") {
    const weather = parts.signals.find((signal) => signal.source === "weather")
    if (weather) {
      return {
        spokenText: `Weather check, Peter. ${weather.summary}. ${weather.nextAction ?? "Use that to pace the day."}`,
        displayText: [
          "Weather",
          "",
          weather.summary,
          "",
          `Next: ${weather.nextAction ?? "Use this to pace outdoor movement, travel, and errands."}`,
        ].join("\n"),
        signals: [weather],
        sourceLinks: parts.links,
        drafts: parts.drafts,
        warnings: parts.warnings,
        toolRuns: parts.toolRuns,
        suggestions: suggestionsForMode("weather"),
        conversationState: conversationStateFor({
          mode: parts.mode,
          query: parts.query,
          toolRuns: parts.toolRuns,
          signals: [weather],
        }),
      }
    }
  }
  if (parts.mode === "chat") {
    return {
      spokenText:
        parts.tone === "witty"
          ? "I am here, Peter. Regrettably alert."
          : "I am here, Peter.",
      displayText:
        "I am here. Ask me naturally, or ask me to scan Slack, Gmail, Calendar, research something, or brief your day.",
      signals: [],
      sourceLinks: parts.links,
      drafts: parts.drafts,
      warnings: parts.warnings,
      toolRuns: parts.toolRuns,
      suggestions: suggestionsForMode("chat"),
      conversationState: {
        activeTopic: "conversation",
        unresolvedQuestion: null,
      },
    }
  }
  if (parts.mode === "research" && top.length === 0) {
    return {
      spokenText:
        "I can process that. I will keep the theatrics out and bring back the useful parts.",
      displayText:
        "Research mode is active. ODIN will analyze the request with Peter's operations context, use any URLs provided as source evidence, and return a concise brief with next actions.",
      signals: [],
      sourceLinks: parts.links,
      drafts: parts.drafts,
      warnings: parts.warnings,
      toolRuns: parts.toolRuns,
      suggestions: suggestionsForMode("research"),
      conversationState: {
        activeTopic: "research",
        unresolvedQuestion: "Provide a URL, pasted text, or a specific research question.",
      },
    }
  }
  const spokenText = top.length
    ? `I found ${top.length} item${top.length === 1 ? "" : "s"} needing attention. ${top[0].title}.`
    : parts.mode === "calendar" && parts.tone !== "formal"
      ? "Your calendar is clear, Peter. Suspicious, but useful."
      : "I do not see a critical item in the scanned sources."
  const displayText = top.length
    ? top.map((signal, i) => `${i + 1}. ${signal.title}\n${signal.summary}\nAction: ${signal.nextAction ?? "Open the source and review."}`).join("\n\n")
    : "No critical operations signal found in the scanned window."
  return {
    spokenText,
    displayText,
    signals: top,
    sourceLinks: parts.links,
    drafts: parts.drafts,
    warnings: parts.warnings,
    toolRuns: parts.toolRuns,
    suggestions: suggestionsForMode(parts.mode),
    conversationState: conversationStateFor({
      mode: parts.mode,
      query: parts.query,
      toolRuns: parts.toolRuns,
      signals: top,
    }),
  }
}

async function synthesize(args: {
  userId: string
  query: string
  source: Source
  mode: Mode
  tone: OdinTone
  context: string[]
  seed: OdinCommandResponse
  conversationId?: string
  visiblePage?: string
}): Promise<OdinCommandResponse> {
  try {
    const liveContext = args.context.join("\n\n")
    const morningBrief = isMorningBriefQuery(args.query, args.mode)
    const system = await buildOdinPersona({
      userId: args.userId,
      mode: args.mode,
      tone: args.tone,
      liveContext,
      conversationId: args.conversationId,
      visiblePage: args.visiblePage,
    })

    const text = await askClaude(
      system,
      JSON.stringify({
        user_query: args.query,
        source: args.source,
        mode: args.mode,
        tone: args.tone,
        live_context: args.context,
        existing_structured_result: {
          signals: args.seed.signals,
          sourceLinks: args.seed.sourceLinks,
          drafts: args.seed.drafts,
          warnings: args.seed.warnings,
          toolRuns: args.seed.toolRuns,
        },
        instructions: morningBrief
          ? "Write the ODIN answer Peter should hear as a concise executive update, not a source-by-source report. If live_context contains external automation briefs from odin_memories, treat them as the source of truth for business items. Lead with the single issue that needs Peter most, explain why in plain language, and give exactly one next move. Do not read full Slack/Gmail bodies, do not enumerate every topic, and do not use labels like Topic or Urgency. If data is stale or missing, say that briefly. Dry wit is allowed only as one short phrase when the issue is not critical. Maximum 3 short sentences, no bullets, no JSON."
          : args.mode === "health"
            ? "Write Peter's health overview using saved health_profiles context plus live Withings data when present. Include readiness, current Withings vitals, active goal, exactly one exercise action, one diet action, and one recovery action. Fitness coaching only; do not diagnose, prescribe, or overstate medical certainty. Maximum 4 short sentences; no headings, bullets, separators, markdown, or JSON."
          : "Write the ODIN answer Peter should hear. Interpret the live data and memory. Do not return JSON.",
      })
    )

    if (!text || text === CLAUDE_MEMORY_FALLBACK) {
      return {
        ...args.seed,
        toolRuns: [
          ...args.seed.toolRuns,
          { tool: "claude_synthesis", status: "partial" },
        ],
      }
    }

    const displayText = [
      text,
      "",
      args.seed.displayText,
    ]
      .filter(Boolean)
      .join("\n")

    return {
      ...args.seed,
      spokenText: morningBrief ? short(text, 520) : short(text, 650),
      displayText,
      toolRuns: [
        ...args.seed.toolRuns,
        { tool: "claude_synthesis", status: "ok" },
      ],
    }
  } catch (err) {
    console.error("[odin-orchestrator] Claude synthesis failed", err)
    return {
      ...args.seed,
      toolRuns: [
        ...args.seed.toolRuns,
        { tool: "claude_synthesis", status: "failed" },
      ],
    }
  }
}

async function runOdinCommand(
  req: Request,
  userId: string,
  body: OdinCommandRequest
): Promise<OdinCommandResponse> {
  const query = (body.query ?? "").trim()
  if (!query) throw new Error("query is required")
  const source = body.source === "voice" ? "voice" : "text"
  const selectedMode = modeFromQuery(query, body.mode)

  const context: string[] = []
  const signals: OperationsSignal[] = []
  const links: OdinCommandResponse["sourceLinks"] = []
  const drafts: OdinCommandResponse["drafts"] = []
  const warnings: string[] = []
  const toolRuns: OdinCommandResponse["toolRuns"] = []
  let sourceFreshness: OdinSourceFreshness = EMPTY_SOURCE_FRESHNESS
  let learningSummary: OdinLearningSummary = { ...EMPTY_LEARNING_SUMMARY }
  let pendingSummary: OdinPendingSummary = { ...EMPTY_PENDING_SUMMARY }
  let googleAccountsPromise: Promise<AccountSummary[]> | null = null
  let withingsAccountsPromise: Promise<AccountSummary[]> | null = null
  const getGoogleAccounts = () => {
    if (!googleAccountsPromise) googleAccountsPromise = listProviderAccounts(userId, "google")
    return googleAccountsPromise
  }
  const getWithingsAccounts = () => {
    if (!withingsAccountsPromise) withingsAccountsPromise = listProviderAccounts(userId, "withings")
    return withingsAccountsPromise
  }

  const [memoryContext, conversationContinuity] = await Promise.all([
    loadOdinMemoryContext(userId).catch((err) => {
      console.warn("[odin-orchestrator] memory context unavailable", err)
      return "ODIN memory: unavailable."
    }),
    recentConversationContext(userId, body.conversationId).catch((err) => {
      console.warn("[odin-orchestrator] conversation context unavailable", err)
      return "Conversation continuity: unavailable."
    }),
    recordConversationEvent({
      userId,
      conversationId: body.conversationId,
      turnId: body.turnId,
      source,
      role: "user",
      mode: selectedMode,
      content: query,
      payload: {
        visiblePage: body.visiblePage ?? null,
        recentContext: body.recentContext ?? null,
      },
    }).catch((err) => {
      console.warn("[odin-orchestrator] user event not recorded", err)
    }),
  ]).then(([memory, conversation]) => [memory, conversation])

  context.push(memoryContext, conversationContinuity)
  if (body.visiblePage) context.push(`Visible ODIN page: ${body.visiblePage}`)
  if (body.recentContext) {
    context.push(`Recent client-side ODIN context from the dashboard: ${body.recentContext}`)
  }
  if (body.conversationHistory) {
    context.push(
      `Live conversation history for continuity. Treat follow-up phrases like "that", "yes", "what do you mean", and "continue" as referring to this thread:\n${body.conversationHistory}`
    )
  }

  const wantsChat = selectedMode === "chat"
  const wantsResearch = selectedMode === "research"
  const lowerQuery = query.toLowerCase()
  if (selectedMode === "health" && healthPlanConfirmationRequested(query)) {
    return writeHealthPlanEvents(userId, await getGoogleAccounts())
  }
  const wakeOrMorningBrief = /\b(wake up odin|good morning|morning brief|start my day)\b/.test(lowerQuery)
  const healthPlanning = healthPlanningRequested(query)
  const healthOverviewRequested =
    selectedMode === "health" ||
    healthPlanning ||
    /\b(health overview|my health|health goal|health goals|health plan|diet plan|exercise plan|fitness coach|withings)\b/.test(lowerQuery)
  const manualScanRequested = explicitScanRequested(body, query, selectedMode)
  const scanSources = requestedScanSources(body, query, selectedMode)
  const scanWindowDays = scanWindowDaysFromRequest(body, query)
  const shouldLoadExternalBusinessBriefs =
    wakeOrMorningBrief ||
    manualScanRequested ||
    selectedMode === "brief" ||
    selectedMode === "combined" ||
    /\b(brief|what needs me|what needs my attention|priority|priorities|needs peter|pending)\b/.test(lowerQuery)
  const externalBusinessBriefs = shouldLoadExternalBusinessBriefs
    ? await loadExternalBusinessBriefContext(userId).catch((err) => {
        const message = err instanceof Error ? err.message : "External automation brief lookup failed"
        console.warn("[odin-orchestrator] external business briefs unavailable", err)
        return {
          context: `External automation briefs unavailable: ${message}`,
          signals: [] as OperationsSignal[],
          sourceLinks: [] as OdinCommandResponse["sourceLinks"],
          warnings: [message],
          status: "failed" as const,
          count: 0,
        }
      })
    : null
  if (externalBusinessBriefs) {
    context.push(externalBusinessBriefs.context)
    signals.push(...externalBusinessBriefs.signals)
    links.push(...externalBusinessBriefs.sourceLinks)
    warnings.push(...externalBusinessBriefs.warnings)
    toolRuns.push({
      tool: "external_business_briefs",
      status: externalBusinessBriefs.status,
    })
    if (manualScanRequested) {
      context.push(
        "Live Scan contract: Slack and Gmail priority discovery should come from agent-ingested source briefs in ODIN memory/pending queue. For Stay Minty, Claude is expected to scan Slack/DMs, read only Gmail label:stayminty by default, and use the weekly Google Docs as drive-source priority anchors for Smokies and Nashville. Do not treat ODIN's direct Slack/Gmail polling as primary evidence; if an agent brief is missing or stale, say that source needs an agent refresh."
      )
    }
  }
  const useCachedResponsibility =
    !wantsChat && !wantsResearch && !healthOverviewRequested && !manualScanRequested

  if (useCachedResponsibility) {
    const cached = await buildCachedResponsibilityContext(userId).catch((err) => {
      console.warn("[odin-orchestrator] cached responsibility unavailable", err)
      return null
    })
    if (cached) {
      context.push(cached.context)
      signals.push(...cached.signals as OperationsSignal[])
      links.push(...cached.sourceLinks)
      warnings.push(...cached.warnings)
      sourceFreshness = cached.sourceFreshness
      pendingSummary = cached.pendingSummary
      toolRuns.push({
        tool: "cached_responsibility",
        status: cached.signals.length > 0 ? "ok" : "partial",
      })
    }
  }

  if (healthPlanning) {
    context.push(
      `Health scheduling request: use Withings recovery/body data plus Google Calendar availability to propose a day plan. Use ${body.timezone} for all user-facing times; do not speak in UTC unless Peter explicitly asks. Do not say calendar events were created. Suggest at most three blocks with exact times: recovery walk, mobility, wind-down/sleep protection, or strength only if sleep and heart-rate context support it. Ask Peter to confirm before writing events.`
    )
  }

  const freshScanAllowed = manualScanRequested || wantsResearch || healthOverviewRequested
  const wantsWeather =
    !wantsChat &&
    !wantsResearch &&
    (selectedMode === "brief" ||
      selectedMode === "weather" ||
      scanSources.has("weather") ||
      /\b(weather|temperature|forecast|rain|raining|storm|hot|cold|outside|umbrella|laguna|manila|wake up|morning)\b/.test(lowerQuery))
  const wantsHealth =
    healthOverviewRequested ||
    (freshScanAllowed &&
    !wantsChat &&
    !wantsResearch &&
    scanSources.has("health"))
  const requestedAgentSlack =
    freshScanAllowed &&
    !wantsChat &&
    !wantsResearch &&
    scanSources.has("slack")
  const requestedAgentGmail = freshScanAllowed && !wantsChat && !wantsResearch && scanSources.has("gmail")
  const wantsSlack = false
  const wantsGmail = false
  const wantsCalendar = freshScanAllowed && !wantsChat && !wantsResearch && scanSources.has("calendar")
  const wantsBrowser = freshScanAllowed && !wantsChat && scanSources.has("browser")
  if (requestedAgentSlack) {
    context.push(
      "Slack direct polling is disabled in ODIN orchestrator. ODIN should answer from the latest Claude/Codex agent-ingested source briefs and pending items; for Stay Minty, Claude should perform the Slack channel/DM calls. If those briefs are missing, say no fresh agent brief is available and ask Peter to run or post the external source brief."
    )
    toolRuns.push({
      tool: "agent_brief_required_slack",
      status: externalBusinessBriefs?.count ? "ok" : "partial",
    })
  }
  if (requestedAgentGmail) {
    context.push(
      "Gmail direct polling is disabled in ODIN orchestrator. ODIN should answer from the latest Claude/Codex agent-ingested source briefs and pending items; for Stay Minty, Claude should read only Gmail label:stayminty unless Peter asks for a deeper pull. If those briefs are missing, say no fresh agent brief is available and ask Peter to run or post the external source brief."
    )
    toolRuns.push({
      tool: "agent_brief_required_gmail",
      status: externalBusinessBriefs?.count ? "ok" : "partial",
    })
  }
  const cachedScans = freshScanAllowed && !healthPlanning
    ? await loadCachedSourceScans(userId, [
        ...(wantsCalendar ? ["calendar" as const] : []),
        ...(wantsHealth ? ["health" as const] : []),
        ...(wantsWeather ? ["weather" as const] : []),
      ], { weatherLocation: body.weatherLocation })
    : {}

  const scans = await Promise.all([
    wantsSlack ? scanSlack(req, query, userId) : Promise.resolve(null),
    wantsGmail ? getGoogleAccounts().then((accounts) => scanGmail(userId, accounts, query, scanWindowDays)) : Promise.resolve(null),
    wantsCalendar
      ? cachedScans.calendar
        ? Promise.resolve(cachedScans.calendar)
        : getGoogleAccounts().then((accounts) => scanCalendar(userId, accounts, query))
      : Promise.resolve(null),
    wantsHealth ? loadHealthProfileScan(userId) : Promise.resolve(null),
    wantsHealth
      ? cachedScans.health
        ? Promise.resolve(cachedScans.health)
        : getWithingsAccounts().then((accounts) => scanHealth(userId, accounts))
      : Promise.resolve(null),
    wantsWeather ? cachedScans.weather ?? scanWeather(body.weatherLocation) : Promise.resolve(null),
    wantsResearch ? buildResearchContext(query) : Promise.resolve(null),
    wantsChat
      ? Promise.resolve("Chat mode: no live source scan requested.")
      : wantsBrowser
        ? latestBrowserContext(userId)
        : Promise.resolve("Browser worker: cached mode; no fresh browser scan requested."),
  ])

  const [slack, gmail, calendar, healthProfile, health, weather, research, browser] = scans
  for (const result of [slack, gmail, calendar, healthProfile, health, weather]) {
    if (!result) continue
    context.push(result.context)
    signals.push(...result.signals)
    links.push(...result.sourceLinks)
    if ("drafts" in result) drafts.push(...result.drafts)
    warnings.push(...result.warnings)
  }
  if (research) {
    context.push(research.context)
    links.push(...research.sourceLinks)
    warnings.push(...research.warnings)
  }
  if (wantsChat) {
    context.push(
      "Chat mode: answer directly as ODIN by GUMAPAC. Peter wants a responsive AI assistant, not a scan. Keep voice answer short and natural; display answer can be a little more useful."
    )
    toolRuns.push({ tool: "claude_chat", status: "ok" })
  }
  context.push(browser as string)
  if (slack) toolRuns.push({ tool: "slack", status: slack.status })
  if (gmail) toolRuns.push({ tool: "gmail", status: gmail.status })
  if (calendar) toolRuns.push({ tool: isCachedResult(calendar) ? "calendar_cache" : "calendar", status: calendar.status })
  if (healthProfile) toolRuns.push({ tool: "health_profile", status: healthProfile.status })
  if (health) toolRuns.push({ tool: isCachedResult(health) ? "health_cache" : "health", status: health.status })
  if (weather) toolRuns.push({ tool: isCachedResult(weather) ? "weather_cache" : "weather", status: weather.status })
  if (research) toolRuns.push({ tool: "research", status: research.status })
  if (wantsBrowser) {
    toolRuns.push({ tool: "browser_worker", status: (browser as string).includes("login_required") ? "partial" : "ok" })
  }

  if (manualScanRequested) {
    const snapshotTasks: Array<Promise<void>> = []
    const snapshotPayload = (source: OdinScanSource) => ({
      signals: signals.filter((signal) => signal.source === source).slice(0, 12),
      links: links.filter((link) => link.source === source).slice(0, 12),
    })
    if (slack) {
      snapshotTasks.push(upsertScanSnapshot({
        userId,
        source: "slack",
        status: slack.status,
        summary: slack.context,
        payload: snapshotPayload("slack"),
        signalCount: slack.signals.length,
        warnings: slack.warnings,
      }))
    }
    if (gmail) {
      snapshotTasks.push(upsertScanSnapshot({
        userId,
        source: "gmail",
        status: gmail.status,
        summary: gmail.context,
        payload: snapshotPayload("gmail"),
        signalCount: gmail.signals.length,
        windowDays: scanWindowDays,
        warnings: gmail.warnings,
      }))
    }
    if (calendar && !isCachedResult(calendar)) {
      snapshotTasks.push(upsertScanSnapshot({
        userId,
        source: "calendar",
        status: calendar.status,
        summary: calendar.context,
        payload: snapshotPayload("calendar"),
        signalCount: calendar.signals.length,
        windowDays: 1,
        warnings: calendar.warnings,
      }))
    }
    if (health && !isCachedResult(health)) {
      snapshotTasks.push(upsertScanSnapshot({
        userId,
        source: "health",
        status: health.status,
        summary: health.context,
        payload: snapshotPayload("health"),
        signalCount: health.signals.length,
        warnings: health.warnings,
      }))
    }
    if (weather && !isCachedResult(weather)) {
      snapshotTasks.push(upsertScanSnapshot({
        userId,
        source: "weather",
        status: weather.status,
        summary: weather.context,
        payload: {
          ...snapshotPayload("weather"),
          weatherLocation: weatherLocation(body.weatherLocation),
        },
        signalCount: weather.signals.length,
        warnings: weather.warnings,
      }))
    }
    if (wantsBrowser) {
      const browserText = browser as string
      snapshotTasks.push(upsertScanSnapshot({
        userId,
        source: "browser",
        status: browserText.includes("login_required") ? "partial" : "ok",
        summary: browserText,
        payload: { context: browserText },
        signalCount: 0,
        warnings: browserText.includes("login_required") ? ["Browser worker needs login."] : [],
      }))
    }

    const snapshotResults = await Promise.allSettled(snapshotTasks)
    const failedSnapshots = snapshotResults.filter((result) => result.status === "rejected")
    if (failedSnapshots.length) {
      warnings.push(`${failedSnapshots.length} scan snapshot update${failedSnapshots.length === 1 ? "" : "s"} failed.`)
    }

    const freshPendingSources = new Set<OdinResponsibilitySource>()
    if (slack) freshPendingSources.add("slack")
    if (gmail) freshPendingSources.add("gmail")
    if (calendar && !isCachedResult(calendar)) freshPendingSources.add("calendar")
    if (health && !isCachedResult(health)) freshPendingSources.add("health")
    if (wantsBrowser) freshPendingSources.add("browser")

    const freshManualSignals = responsibilitySignals(signals).filter((signal) =>
      freshPendingSources.has(signal.source)
    )
    if (freshPendingSources.size > 0) {
      const pendingLearning = await upsertPendingItemsFromSignals({
        userId,
        signals: freshManualSignals,
        sourceLinks: links,
        sourceType: "manual_scan",
        sourceId: body.turnId ?? body.conversationId,
        scannedSources: [...freshPendingSources],
      }).catch((err) => {
        console.warn("[odin-orchestrator] pending queue update failed", err)
        warnings.push("ODIN could not update the persistent pending queue.")
        return { ...EMPTY_LEARNING_SUMMARY }
      })
      learningSummary = mergeLearningSummaries(learningSummary, pendingLearning)
    } else if (requestedAgentSlack || requestedAgentGmail) {
      warnings.push(
        "No fresh agent source brief arrived during Live Scan. Slack/Gmail remain last-known only."
      )
    }
    const cachedResponsibility = await buildCachedResponsibilityContext(userId).catch((err) => {
      console.warn("[odin-orchestrator] cached responsibility reload failed", err)
      return null
    })
    if (cachedResponsibility) {
      signals.splice(
        0,
        signals.length,
        ...cachedResponsibility.signals.map((signal) => ({
          id: signal.id,
          source: signal.source,
          category: signal.category,
          title: signal.title,
          summary: signal.summary,
          evidence: signal.evidence,
          nextAction: signal.nextAction,
          suggestedReply: signal.suggestedReply,
          sourceUrl: signal.sourceUrl,
          dueAt: signal.dueAt,
          person: signal.person,
          business: businessFromText(`${signal.business ?? ""} ${signal.title} ${signal.summary}`),
          status: signal.status,
          urgency: signal.urgency,
        }))
      )
      context.push(cachedResponsibility.context)
      sourceFreshness = cachedResponsibility.sourceFreshness
      pendingSummary = cachedResponsibility.pendingSummary
    } else {
      sourceFreshness = await getSourceFreshness(userId)
      pendingSummary = pendingSummaryFromSignals(responsibilitySignals(signals))
    }
  } else if (!useCachedResponsibility) {
    sourceFreshness = await getSourceFreshness(userId)
    pendingSummary = pendingSummaryFromSignals(responsibilitySignals(signals))
  }

  const hasCriticalSignal = signals.some((signal) => {
    const text = `${signal.category} ${signal.title} ${signal.summary} ${signal.evidence ?? ""}`.toLowerCase()
    return (
      signal.category === "urgent" ||
      /\b(critical|urgent|safety|payroll|finance|owner escalation|guest escalation|legal|warning|termination|meredith)\b/.test(
        text
      )
    )
  })
  const tone = defaultOdinTone({
    mode: selectedMode,
    requestedTone: body.tone,
    hasCriticalSignal,
  })

  const seed = responseWithResponsibilityMeta(fallbackResponse({
    query,
    mode: selectedMode,
    tone,
    signals: signals
      .sort((a, b) => {
        const order: Record<SignalCategory, number> = {
          urgent: 0,
          today: 1,
          waiting: 2,
          follow_up: 3,
          routine: 4,
          quiet: 5,
        }
        return order[a.category] - order[b.category]
      })
      .slice(0, 5),
    links,
    drafts,
    warnings,
    toolRuns,
  }), {
    sourceFreshness,
    learningSummary,
    pendingSummary,
  })

  const synthesized = body.skipSynthesis
    ? {
        ...seed,
        toolRuns: [
          ...seed.toolRuns,
          { tool: "claude_synthesis", status: "partial" as const },
        ],
      }
    : await synthesize({
        userId,
        query,
        source,
        mode: selectedMode,
        tone,
        context,
        seed,
        conversationId: body.conversationId,
        visiblePage: body.visiblePage,
      })
  const morningBriefRequested = isMorningBriefQuery(query, selectedMode)
  const finalResponse = manualScanRequested
    ? {
        ...synthesized,
        spokenText: conciseManualScanSpokenText(synthesized, pendingSummary),
      }
    : morningBriefRequested
        ? {
            ...synthesized,
            spokenText: morningBriefSpokenText(synthesized.signals),
          }
        : synthesized

  const conversationLearning = await runConversationLearning({
    userId,
    userInput: query,
    odinResponse: finalResponse.spokenText,
    sourceType: "conversation",
    sourceId: body.turnId ?? body.conversationId,
  }).catch((err) => {
    console.warn("[odin-orchestrator] conversation learning failed", err)
    return { ...EMPTY_LEARNING_SUMMARY }
  })
  learningSummary = mergeLearningSummaries(learningSummary, conversationLearning)
  const data = responseWithResponsibilityMeta(finalResponse, {
    sourceFreshness,
    learningSummary,
    pendingSummary,
  })

  await recordConversationEvent({
    userId,
    conversationId: body.conversationId,
    turnId: body.turnId,
    source: "system",
    role: "assistant",
    mode: selectedMode,
    content: data.spokenText,
    payload: { response: data },
  }).catch((err) => {
    console.warn("[odin-orchestrator] assistant event not recorded", err)
  })
  logEpisodic({
    userId,
    conversationId: body.conversationId,
    userInput: query,
    odinResponse: data.spokenText,
    observation: `${selectedMode} request answered with ${data.toolRuns.length} tool run${data.toolRuns.length === 1 ? "" : "s"} and ${data.signals.length} signal${data.signals.length === 1 ? "" : "s"}.`,
    contextJson: {
      mode: selectedMode,
      source,
      tone,
      warnings: data.warnings,
      toolRuns: data.toolRuns,
      visiblePage: body.visiblePage ?? null,
    },
  }).catch((err) => {
    console.warn("[odin-orchestrator] episodic memory not recorded", err)
  })
  return data
}

function errorResponse(message: string): OdinCommandResponse {
  return {
    spokenText:
      "ODIN hit a backend fault, Peter. I kept the session alive; try the same request again or narrow it to Calendar, Gmail, Slack, or Vitals.",
    displayText: `ODIN backend fault: ${message}`,
    signals: [],
    sourceLinks: [],
    drafts: [],
    warnings: [message],
    toolRuns: [{ tool: "odin-orchestrator", status: "failed" }],
    suggestions: ["Try Calendar today.", "Scan urgent Gmail.", "What can you still do?"],
    conversationState: {
      activeTopic: "error_recovery",
      unresolvedQuestion: message,
    },
  }
}

interface OpenAiMessage {
  role?: string
  content?: unknown
}

interface CustomLlmBody {
  messages?: OpenAiMessage[]
  stream?: boolean
  user?: string
  conversation_id?: string
  conversationId?: string
  metadata?: Record<string, unknown>
  dynamic_variables?: Record<string, unknown>
  elevenlabs_extra_body?: Record<string, unknown>
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === "string" ? text : ""
        }
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

function isCustomLlmBody(body: unknown): body is CustomLlmBody {
  return Boolean(body && typeof body === "object" && Array.isArray((body as CustomLlmBody).messages))
}

function latestUserText(messages: OpenAiMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === "user")
  return short(textFromContent(latest?.content), 2000)
}

function customConversationId(body: CustomLlmBody): string | undefined {
  const containers = [body, body.metadata, body.dynamic_variables, body.elevenlabs_extra_body].filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object")
  )
  for (const item of containers) {
    const id =
      item.conversation_id ??
      item.conversationId ??
      item.elevenlabs_conversation_id ??
      item.session_id ??
      item.call_id
    if (typeof id === "string" && id.trim().length > 3) return short(id.trim(), 120)
  }
  return undefined
}

function conversationHistoryFromMessages(messages: OpenAiMessage[]): string {
  const latestUserIndex = messages.reduce(
    (latest, message, index) => (message.role === "user" ? index : latest),
    -1
  )
  const priorMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => {
      if (index >= latestUserIndex) return false
      return message.role === "user" || message.role === "assistant"
    })
    .slice(-10)

  if (!priorMessages.length) return ""

  return priorMessages
    .map(({ message }) => {
      const speaker = message.role === "user" ? "Peter" : "ODIN"
      return `${speaker}: ${short(textFromContent(message.content), 900)}`
    })
    .filter((line) => !line.endsWith(": "))
    .join("\n")
}

function customLlmAuthorized(req: Request): boolean {
  // @ts-expect-error Deno global
  const secrets = [
    Deno.env.get("ELEVENLABS_CUSTOM_LLM_SECRET"),
    Deno.env.get("ELEVENLABS_WEBHOOK_SECRET"),
    Deno.env.get("ELEVENLABS_API_KEY"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0)
  if (secrets.length === 0) return false
  const authSecret = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  const headerSecret = req.headers.get("x-elevenlabs-secret") ?? req.headers.get("x-odin-secret") ?? authSecret
  return secrets.includes(headerSecret)
}

function odinInternalFunctionSecret(): string | null {
  // @ts-expect-error Deno global
  const secret =
    Deno.env.get("ODIN_INTERNAL_FUNCTION_SECRET") ??
    Deno.env.get("ELEVENLABS_CUSTOM_LLM_SECRET") ??
    Deno.env.get("ELEVENLABS_WEBHOOK_SECRET") ??
    Deno.env.get("ELEVENLABS_API_KEY") ??
    ""
  return secret.length > 0 ? secret : null
}

function externalBriefAuthorized(req: Request): boolean {
  // @ts-expect-error Deno global
  const expected = Deno.env.get("ODIN_API_KEY") ?? ""
  const supplied = req.headers.get("x-odin-api-key") ?? ""
  return expected.length > 0 && supplied.trim() === expected
}

async function safeCallerUserId(req: Request): Promise<string | null> {
  try {
    return await getCallerUserId(req)
  } catch (err) {
    console.warn("[odin-orchestrator] Supabase JWT auth unavailable", err)
    return null
  }
}

async function resolveExternalBriefUserId(): Promise<string> {
  // @ts-expect-error Deno global
  const defaultUserId = Deno.env.get("ODIN_DEFAULT_USER_ID") || ""
  if (defaultUserId) return defaultUserId

  // @ts-expect-error Deno global
  const defaultEmail = Deno.env.get("ODIN_DEFAULT_USER_EMAIL") ?? Deno.env.get("PETER_USER_EMAIL") ?? "peterkgumapac@gmail.com"
  const { data, error } = await getAdminClient()
    .from("users")
    .select("id")
    .eq("email", defaultEmail)
    .limit(1)
    .maybeSingle()
  if (!error && data?.id) return data.id as string
  return PETER_USER_ID
}

function pendingSourceForExternalItem(item: NormalizedExternalBriefItem): OdinResponsibilitySource {
  return item.sourceType === "drive" ? "memory" : item.sourceType
}

function externalPendingItemKey(brief: NormalizedExternalBrief, item: NormalizedExternalBriefItem): string {
  const provided = item.id ? externalKeyText(item.id, 110) : ""
  const urlKey = item.sourceUrl ? externalKeyText(item.sourceUrl, 110) : ""
  const textKey = externalKeyText(`${item.person ?? ""} ${item.title}`, 130)
  return short(
    `agent:${brief.sourceAgent}:${brief.business}:${item.sourceType}:${provided || urlKey || textKey}`,
    220
  )
}

async function retireSupersededExternalItems(args: {
  userId: string
  brief: NormalizedExternalBrief
  activeKeys: Set<string>
  now: string
}): Promise<number> {
  if (!args.brief.replacePending) return 0

  const businessLabel = externalBriefBusinessLabel(args.brief.business)
  const { data, error } = await getAdminClient()
    .from("odin_pending_items")
    .select("id,source,source_item_id,business,payload,status")
    .eq("user_id", args.userId)
    .in("source", ["slack", "gmail", "memory"])
    .in("status", ["open", "waiting"])
    .limit(250)

  if (error) {
    console.warn("[odin-orchestrator/agent_ingest] stale pending lookup failed", error.message)
    return 0
  }

  const staleIds = (data ?? [])
    .filter((row) => {
      const key = `${row.source}:${row.source_item_id}`
      if (args.activeKeys.has(key)) return false
      const payload = recordOrEmpty(row.payload)
      const rowAgent = typeof payload.sourceAgent === "string" ? payload.sourceAgent : null
      const rowBusinessKey = typeof payload.businessKey === "string" ? payload.businessKey : null
      const rowExternalMode = typeof payload.externalBriefMode === "string" ? payload.externalBriefMode : null
      const rowBusiness = typeof row.business === "string" ? row.business : null

      const sameAgent = rowAgent === args.brief.sourceAgent
      const sameBusiness = rowBusiness === businessLabel || rowBusinessKey === args.brief.business
      const sameBusinessAgentBrief =
        sameBusiness &&
        (Boolean(rowAgent) ||
          rowExternalMode === "agent_ingest" ||
          rowExternalMode === "external_brief")
      const legacySameBusiness = !rowAgent && rowBusiness === businessLabel
      const legacyUnscoped = !rowAgent && !rowBusiness && args.brief.business === "stayminty"
      return sameAgent || sameBusinessAgentBrief || legacySameBusiness || legacyUnscoped
    })
    .map((row) => row.id as string)

  if (!staleIds.length) return 0

  const { error: updateError } = await getAdminClient()
    .from("odin_pending_items")
    .update({
      status: "handled",
      bucket: "done_recently",
      resolved_at: args.now,
    })
    .eq("user_id", args.userId)
    .in("id", staleIds)

  if (updateError) {
    console.warn("[odin-orchestrator/agent_ingest] stale pending update failed", updateError.message)
    return 0
  }

  return staleIds.length
}

async function upsertExternalBriefPendingItems(args: {
  userId: string
  brief: NormalizedExternalBrief
  memoryId?: string | null
  receivedAt: string
}): Promise<OdinLearningSummary> {
  if (args.brief.test) return { ...EMPTY_LEARNING_SUMMARY }

  const businessLabel = externalBriefBusinessLabel(args.brief.business)
  const rows = args.brief.items.map((item) => {
    const source = pendingSourceForExternalItem(item)
    const sourceItemId = externalPendingItemKey(args.brief, item)
    return {
      user_id: args.userId,
      source,
      source_item_id: sourceItemId,
      business: businessLabel,
      person: item.person,
      title: item.title,
      summary: item.summary,
      urgency: item.urgency,
      bucket: item.status === "handled" ? "done_recently" : item.bucket,
      status: item.status,
      evidence_url: item.sourceUrl,
      evidence_label: item.evidenceLabel,
      next_action: item.nextAction,
      suggested_reply: item.suggestedReply,
      due_at: item.dueAt,
      last_seen_at: args.receivedAt,
      resolved_at: item.status === "handled" ? args.receivedAt : null,
      payload: {
        sourceAgent: args.brief.sourceAgent,
        agent: args.brief.agent,
        businessKey: args.brief.business,
        externalBriefMode: args.brief.mode,
        externalBriefMemoryId: args.memoryId ?? null,
        externalItemId: item.id,
        externalSourceType: item.sourceType,
        externalTimestamp: args.brief.timestamp,
        receivedAt: args.receivedAt,
        sources: args.brief.sources,
      },
    }
  })

  const activeKeys = new Set(rows.map((row) => `${row.source}:${row.source_item_id}`))
  let updated = 0
  if (rows.length > 0) {
    const { error } = await getAdminClient()
      .from("odin_pending_items")
      .upsert(rows, { onConflict: "user_id,source,source_item_id" })
    if (error) throw new Error(`Failed to upsert agent brief pending items: ${error.message}`)
    updated += rows.length
  }

  const superseded = await retireSupersededExternalItems({
    userId: args.userId,
    brief: args.brief,
    activeKeys,
    now: args.receivedAt,
  })
  updated += superseded

  const refreshedSources = new Set<OdinScanSource>()
  for (const item of args.brief.items) {
    if (item.sourceType === "slack" || item.sourceType === "gmail") refreshedSources.add(item.sourceType)
  }
  for (const source of args.brief.sources) {
    if (source.type === "slack" || source.type === "gmail") refreshedSources.add(source.type)
  }

  await Promise.allSettled(
    [...refreshedSources].map((source) =>
      upsertScanSnapshot({
        userId: args.userId,
        source,
        status: rows.length > 0 ? "ok" : "partial",
        summary: `${businessLabel} ${source.toUpperCase()} brief received from ${args.brief.sourceAgent}: ${args.brief.summary}`,
        payload: {
          sourceAgent: args.brief.sourceAgent,
          business: businessLabel,
          items: args.brief.items
            .filter((item) => item.sourceType === source)
            .map((item) => ({
              title: item.title,
              urgency: item.urgency,
              bucket: item.bucket,
              sourceUrl: item.sourceUrl,
            })),
          sources: args.brief.sources.filter((item) => item.type === source),
          receivedAt: args.receivedAt,
        },
        signalCount: args.brief.items.filter((item) => item.sourceType === source).length,
        windowDays: 7,
        warnings: rows.length > 0 ? [] : ["Agent brief contained no normalized pending items."],
      })
    )
  )

  const eventsLogged = await logLearningEvent({
    userId: args.userId,
    sourceType: "manual_scan",
    sourceId: args.memoryId ?? args.brief.sourceAgent,
    eventType: "pending",
    summary: `Agent ingest ${args.brief.sourceAgent} updated ${rows.length} pending item${rows.length === 1 ? "" : "s"} and closed ${superseded} stale item${superseded === 1 ? "" : "s"}.`,
    payload: {
      mode: args.brief.mode,
      agent: args.brief.agent,
      business: args.brief.business,
      sourceAgent: args.brief.sourceAgent,
      rows: rows.length,
      superseded,
      refreshedSources: [...refreshedSources],
    },
  })

  return {
    memoriesUpdated: 0,
    rulesUpdated: 0,
    pendingUpdated: updated,
    eventsLogged,
  }
}

async function handleExternalBrief(req: Request, body: ExternalBriefRequest): Promise<Response> {
  if (!externalBriefAuthorized(req)) {
    return jsonResponse({ error: "Unauthorized external brief" }, 401)
  }

  const validation = validateExternalBrief(body)
  if (!validation.data) {
    return jsonResponse({ error: validation.error ?? "Invalid external brief" }, 400)
  }

  const brief = validation.data
  const userId = await resolveExternalBriefUserId()
  const source = automationSourceForBusiness(brief.business)
  const receivedAt = new Date().toISOString()
  const title = `${brief.business} morning brief`
  const status = brief.test ? "archived" : "active"
  const { data, error } = await getAdminClient()
    .from("odin_memories")
    .insert({
      user_id: userId,
      kind: "business",
      title,
      content: brief.summary,
      source,
      confidence: 1,
      status,
      context_json: {
        mode: brief.mode,
        agent: brief.agent,
        source_agent: brief.sourceAgent,
        urgency_score: brief.urgencyScore,
        report_markdown: brief.report,
        action_items: brief.actionItems,
        items: brief.items,
        sources: brief.sources,
        external_timestamp: brief.timestamp,
        is_test: brief.test,
        replace_pending: brief.replacePending,
        received_at: receivedAt,
      },
    })
    .select("id,source,created_at")
    .single()

  if (error) {
    console.error("[odin-orchestrator/external_brief]", error.message)
    return jsonResponse({ error: error.message }, 500)
  }

  let pending: OdinLearningSummary = { ...EMPTY_LEARNING_SUMMARY }
  let pendingError: string | null = null
  try {
    pending = await upsertExternalBriefPendingItems({
      userId,
      brief,
      memoryId: data?.id ?? null,
      receivedAt,
    })
  } catch (err) {
    pendingError = err instanceof Error ? err.message : "Agent brief pending update failed"
    console.error("[odin-orchestrator/agent_ingest]", pendingError)
  }

  return jsonResponse({
    data: {
      ok: true,
      id: data?.id,
      source,
      source_agent: brief.sourceAgent,
      title,
      status,
      test: brief.test,
      items: brief.items.length,
      pending,
      warning: pendingError,
      received_at: receivedAt,
    },
  })
}

async function resolveCustomUserId(body: CustomLlmBody): Promise<string | null> {
  const containers = [body, body.metadata, body.dynamic_variables, body.elevenlabs_extra_body].filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object")
  )
  for (const item of containers) {
    const id = item.user_id ?? item.userId
    if (typeof id === "string" && id.length > 20) return id
  }

  // @ts-expect-error Deno global
  const defaultEmail = Deno.env.get("ODIN_DEFAULT_USER_EMAIL") ?? Deno.env.get("PETER_USER_EMAIL") ?? "peterkgumapac@gmail.com"
  const emailCandidates = [
    ...containers.flatMap((item) => [item.user_email, item.email, item.user]),
    body.user,
    defaultEmail,
  ].filter((item): item is string => typeof item === "string" && item.includes("@"))

  for (const email of emailCandidates) {
    const { data, error } = await getAdminClient()
      .from("users")
      .select("id")
      .eq("email", email)
      .limit(1)
      .maybeSingle()
    if (!error && data?.id) return data.id as string
  }
  return null
}

async function resolveElevenLabsUserId(
  req: Request,
  body: CustomLlmBody
): Promise<string | null> {
  const jwtUserId = await safeCallerUserId(req)
  if (jwtUserId) return jwtUserId

  if (!customLlmAuthorized(req)) return null

  // ElevenLabs calls this endpoint with a non-JWT secret, so use the deployed
  // default user id when browser JWT auth is unavailable.
  // @ts-expect-error Deno global
  const defaultUserId = Deno.env.get("ODIN_DEFAULT_USER_ID") || ""
  if (defaultUserId) {
    console.info("[odin-orchestrator] using ODIN_DEFAULT_USER_ID for ElevenLabs request")
    return defaultUserId
  }

  return (await resolveCustomUserId(body)) ?? PETER_USER_ID
}

function elevenLabsChatCompletionJson(data: OdinCommandResponse): Response {
  const id = `chatcmpl-odin-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model: "odin-orchestrator",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: data.spokenText,
          },
          finish_reason: "stop",
        },
      ],
    }),
    {
      headers: {
        ...CORS_HEADERS,
        "content-type": "application/json",
      },
    }
  )
}

function elevenLabsLiveStream(
  run: () => Promise<OdinCommandResponse>
): Response {
  const encoder = new TextEncoder()
  const id = `chatcmpl-odin-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  const body = new ReadableStream({
    async start(controller) {
      const send = (chunk: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }

      const base = {
        id,
        object: "chat.completion.chunk",
        created,
        model: "odin-orchestrator",
      }

      // ElevenLabs times out if the Custom LLM endpoint is silent while ODIN
      // gathers live source context. Send an immediate assistant/empty-content
      // chunk, then finish with the real answer once the slow work completes.
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      })

      try {
        const data = await run()
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { content: data.spokenText },
              finish_reason: null,
            },
          ],
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "ODIN custom LLM failed"
        console.error("[odin-orchestrator/custom-llm]", message)
        const data = errorResponse(message)
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { content: data.spokenText },
              finish_reason: null,
            },
          ],
        })
      }

      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      })
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })

  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  })
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)
  const pathname = new URL(req.url).pathname

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400)
  }

  if (isExternalBriefBody(rawBody) || pathname.endsWith("/ingest")) {
    return handleExternalBrief(req, recordOrEmpty(rawBody) as ExternalBriefRequest)
  }

  if (isCustomLlmBody(rawBody)) {
    const userId = await resolveElevenLabsUserId(req, rawBody)
    if (!userId) return jsonResponse({ error: "Unable to resolve ODIN user" }, 401)
    const query = latestUserText(rawBody.messages ?? [])
    if (!query) return jsonResponse({ error: "No user message supplied" }, 400)
    const conversationId = customConversationId(rawBody)
    const conversationHistory = conversationHistoryFromMessages(rawBody.messages ?? [])
    const run = () =>
      runOdinCommand(req, userId, {
        query,
        source: "voice",
        timezone: "Asia/Manila",
        conversationId,
        conversationHistory,
        visiblePage: "ElevenLabs Custom LLM",
      })

    if (rawBody.stream !== false) return elevenLabsLiveStream(run)

    try {
      return elevenLabsChatCompletionJson(await run())
    } catch (err) {
      const message = err instanceof Error ? err.message : "ODIN custom LLM failed"
      console.error("[odin-orchestrator/custom-llm]", message)
      return elevenLabsChatCompletionJson(errorResponse(message))
    }
  }

  const userId = await safeCallerUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)

  try {
    const data = await runOdinCommand(req, userId, rawBody as OdinCommandRequest)
    return jsonResponse({ data })
  } catch (err) {
    const message = err instanceof Error ? err.message : "ODIN orchestrator failed"
    console.error("[odin-orchestrator]", message)
    return jsonResponse({ data: errorResponse(message) })
  }
})

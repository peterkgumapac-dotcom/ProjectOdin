import { getAdminClient } from "./supabase_admin.ts"

export type OdinResponsibilitySource =
  | "gmail"
  | "slack"
  | "calendar"
  | "health"
  | "weather"
  | "browser"
  | "manual"
  | "memory"
  | "research"
  | "system"

export type OdinScanSource = "gmail" | "slack" | "calendar" | "health" | "weather" | "browser"
export type OdinPendingBucket = "needs_peter" | "waiting_on_others" | "today" | "done_recently"
export type OdinPendingStatus = "open" | "handled" | "deferred" | "waiting"
export type OdinLearningSourceType = "conversation" | "post_call" | "manual_scan" | "correction" | "system"

export interface OdinLearningSummary {
  memoriesUpdated: number
  rulesUpdated: number
  pendingUpdated: number
  eventsLogged: number
}

export interface OdinPendingSummary {
  needs_peter: number
  waiting_on_others: number
  today: number
  done_recently: number
}

export interface OdinSourceFreshnessEntry {
  source: OdinScanSource
  status: "ok" | "partial" | "failed" | "missing"
  lastSuccessfulScanAt: string | null
  lastScanAt: string | null
  signalCount: number
  summary: string
  warnings: string[]
}

export type OdinSourceFreshness = Record<OdinScanSource, OdinSourceFreshnessEntry>

export interface ResponsibilitySignal {
  id: string
  source: OdinResponsibilitySource
  category: "urgent" | "today" | "waiting" | "follow_up" | "routine" | "quiet"
  title: string
  summary: string
  evidence?: string
  nextAction?: string
  suggestedReply?: string
  sourceUrl?: string
  dueAt?: string
  person?: string
  business?: string
  status: OdinPendingStatus
  urgency?: "critical" | "high" | "medium" | "low"
}

export interface ResponsibilitySourceLink {
  label: string
  url: string
  source: string
}

interface PendingItemRow {
  id: string
  source: OdinResponsibilitySource
  source_item_id: string
  business: string | null
  person: string | null
  title: string
  summary: string
  urgency: "critical" | "high" | "medium" | "low"
  bucket: OdinPendingBucket
  status: OdinPendingStatus
  evidence_url: string | null
  evidence_label: string | null
  next_action: string | null
  suggested_reply: string | null
  due_at: string | null
  last_seen_at: string
  payload: Record<string, unknown> | null
}

interface SnapshotRow {
  source: OdinScanSource
  status: "ok" | "partial" | "failed"
  summary: string
  signal_count: number
  warnings: string[] | null
  scanned_at: string
}

const SCAN_SOURCES: OdinScanSource[] = ["gmail", "slack", "calendar", "health", "weather", "browser"]

const EMPTY_LEARNING: OdinLearningSummary = {
  memoriesUpdated: 0,
  rulesUpdated: 0,
  pendingUpdated: 0,
  eventsLogged: 0,
}

function compact(value: string | null | undefined, max = 420): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ")
}

function keyText(value: string | null | undefined, max = 90): string {
  const text = (value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
  return (text || "none").slice(0, max).replace(/-+$/g, "")
}

function signalText(signal: ResponsibilitySignal): string {
  return [
    signal.title,
    signal.summary,
    signal.evidence,
    signal.nextAction,
    signal.suggestedReply,
    signal.person,
    signal.business,
  ]
    .filter(Boolean)
    .join(" ")
}

function signalSubjectText(signal: ResponsibilitySignal): string {
  return [
    signal.title,
    signal.summary,
    signal.evidence,
    signal.suggestedReply,
    signal.person,
    signal.business,
  ]
    .filter(Boolean)
    .join(" ")
}

function stableUrlKey(signal: ResponsibilitySignal): string | null {
  const raw = signal.sourceUrl?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.hostname.includes("mail.google.com")) {
      const threadId = url.hash.split("/").filter(Boolean).pop()
      return threadId ? `gmail-thread-${keyText(threadId, 80)}` : null
    }
    if (url.hostname.includes("calendar.google.com")) {
      const eventId = url.searchParams.get("eid") ?? url.hash
      return eventId ? `calendar-event-${keyText(eventId, 90)}` : null
    }
    if (url.hostname.includes("slack.com")) {
      const path = url.pathname.replace(/\/p\d+$/i, "")
      return path ? `slack-${keyText(path, 90)}` : null
    }
    return `${keyText(url.hostname, 36)}-${keyText(url.pathname, 90)}`
  } catch {
    return keyText(raw, 100)
  }
}

function responsibilityTopic(signal: ResponsibilitySignal): string {
  const text = signalSubjectText(signal).toLowerCase()
  if (/\b(billables?|unchecked|track update|work orders?|operto)\b/.test(text)) return "billables-track"
  if (/\b(nashville central storage|who is the owner|owner lookup|owner of)\b/.test(text)) return "owner-lookup"
  if (/\b(broken|glass|lid|damage|deduct|deduction|security deposit)\b/.test(text)) return "damage-claim"
  if (/\b(gdc[/-]?3[/-]?mrd|arrival|last[- ]minute|check[- ]?in|check[- ]?out|inspection)\b/.test(text)) {
    return "arrival-inspection"
  }
  if (/\b(gdc[/-]?1[/-]?md|door|projector|maintenance|work order|wo)\b/.test(text)) return "maintenance-work-order"
  if (/\b(airbnb|reservation|private cabin|indoor pool|guest booking|guest decided|continue their stay)\b/.test(text)) {
    return "guest-booking"
  }
  if (/\b(calendar|meeting|brief|agenda)\b/.test(text) || signal.source === "calendar") return "calendar-event"
  if (/\b(heart|sleep|steps|calories|withings|vitals|pulse)\b/.test(text) || signal.source === "health") return "health"
  if (/\b(login|verification|newsletter|promo|promotion|unsubscribe)\b/.test(text)) return "noise"
  return keyText(signal.title, 80)
}

function entityKey(signal: ResponsibilitySignal): string {
  const text = signalSubjectText(signal)
  const property = text.match(/\b[A-Z]{2,6}[/-]\d+(?:[/-][A-Z0-9]+)?\b/i)?.[0]
  if (property) return keyText(property, 70)

  const reservation = text.match(/\b(?:reservation|booking)\s*#?:?\s*([A-Z0-9-]{4,})\b/i)?.[1]
    ?? text.match(/\bres(?:\.|#|\s+#?:?)\s*([A-Z0-9-]{4,})\b/i)?.[1]
  if (reservation) return `reservation-${keyText(reservation, 70)}`

  if (signal.source === "gmail") {
    const urlKey = stableUrlKey(signal)
    if (urlKey) return urlKey
  }

  if (signal.person) return `person-${keyText(signal.person, 70)}`
  const urlKey = stableUrlKey(signal)
  if (urlKey) return urlKey
  return keyText(signal.title, 80)
}

function canonicalPendingKey(signal: ResponsibilitySignal): string {
  if (signal.source === "gmail") {
    const urlKey = stableUrlKey(signal)
    if (urlKey) return compact(urlKey, 180)
  }

  const source = keyText(signal.source, 24)
  const business = keyText(signal.business, 42)
  const person = keyText(signal.person, 58)
  const topic = responsibilityTopic(signal)
  const entity = entityKey(signal)
  return compact(`${source}:${business}:${person}:${topic}:${entity}`, 220)
}

function signalRank(signal: ResponsibilitySignal): number {
  const urgencyRank: Record<ReturnType<typeof urgencyFromSignal>, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  }
  const categoryRank: Record<ResponsibilitySignal["category"], number> = {
    urgent: 4,
    waiting: 3,
    today: 2,
    follow_up: 1,
    routine: 0,
    quiet: 0,
  }
  return (
    urgencyRank[urgencyFromSignal(signal)] * 100 +
    categoryRank[signal.category] * 10 +
    (signal.sourceUrl ? 4 : 0) +
    (signal.nextAction ? 2 : 0) +
    (/\bneeds attention\b/i.test(signal.title) ? -2 : 0)
  )
}

export function dedupeResponsibilitySignals(signals: ResponsibilitySignal[]): ResponsibilitySignal[] {
  const byKey = new Map<string, ResponsibilitySignal>()
  for (const signal of signals) {
    const key = `${signal.source}:${canonicalPendingKey(signal)}`
    const existing = byKey.get(key)
    if (!existing || signalRank(signal) >= signalRank(existing)) {
      byKey.set(key, signal)
    }
  }
  return [...byKey.values()]
}

function preciseNextAction(signal: ResponsibilitySignal): string | null {
  const text = signalText(signal).toLowerCase()
  if (/\b(broken|glass|lid|damage)\b/.test(text)) {
    return "Confirm the damage photos, replacement item, and deposit deduction trail; this is not a payroll task."
  }
  if (/\b(nashville central storage|who is the owner|owner lookup|owner of)\b/.test(text)) {
    return "Reply with the owner name and source of truth; if Track is blank, ask Meredith where ownership is recorded."
  }
  if (/\b(gdc[/-]?1[/-]?md|door|projector)\b/.test(text)) {
    return "Confirm the work-order owner, door status, and projector stand proof before closing the Track item."
  }
  if (/\b(gdc[/-]?3[/-]?mrd|high[- ]risk|checkout inspection|check[- ]?out inspection|last[- ]minute booking)\b/.test(text)) {
    return "Confirm the high-risk flag, checkout inspection owner, and whether Eana can reply to the guest now."
  }
  if (/\b(airbnb|reservation|private cabin|indoor pool)\b/.test(text)) {
    return "Open the reservation thread, identify the guest ask, and draft one short reply or assignment."
  }
  if (/\b(billables?|unchecked|track update|work orders?|meredith)\b/.test(text)) {
    return "Send Meredith the billables/work-order status, the remaining blocker, and one completion ETA."
  }
  if (/\b(safety deposit|security deposit|deposit)\b/.test(text)) {
    return "Confirm deposit status and whether approval or documentation is actually required."
  }
  return null
}

function emptyPendingSummary(): OdinPendingSummary {
  return {
    needs_peter: 0,
    waiting_on_others: 0,
    today: 0,
    done_recently: 0,
  }
}

export function mergeLearningSummaries(...items: OdinLearningSummary[]): OdinLearningSummary {
  return items.reduce(
    (sum, item) => ({
      memoriesUpdated: sum.memoriesUpdated + item.memoriesUpdated,
      rulesUpdated: sum.rulesUpdated + item.rulesUpdated,
      pendingUpdated: sum.pendingUpdated + item.pendingUpdated,
      eventsLogged: sum.eventsLogged + item.eventsLogged,
    }),
    { ...EMPTY_LEARNING }
  )
}

export function pendingSummaryFromSignals(signals: ResponsibilitySignal[]): OdinPendingSummary {
  return dedupeResponsibilitySignals(signals).reduce((summary, signal) => {
    summary[bucketFromSignal(signal)] += 1
    return summary
  }, emptyPendingSummary())
}

export function bucketFromSignal(signal: ResponsibilitySignal): OdinPendingBucket {
  if (signal.status === "handled" || signal.status === "deferred") return "done_recently"
  if (signal.status === "waiting" || signal.category === "waiting") return "waiting_on_others"
  if (signal.source === "calendar" || signal.category === "today") return "today"
  return "needs_peter"
}

function urgencyFromSignal(signal: ResponsibilitySignal): "critical" | "high" | "medium" | "low" {
  if (signal.urgency) return signal.urgency
  const text = `${signal.category} ${signal.title} ${signal.summary} ${signal.nextAction ?? ""}`.toLowerCase()
  const topic = responsibilityTopic(signal)
  if (topic === "damage-claim" && !/\b(safety|injury|legal|fire|flood)\b/.test(text)) return "high"
  if (topic === "owner-lookup") return "high"
  if (/\b(critical|safety|legal|fire|flood|termination|written warning|security breach|security issue|lockout)\b/.test(text)) return "critical"
  if (
    signal.category === "urgent" ||
    /\b(urgent|asap|blocked|cannot|can't|refund|claim|approval|damage|broken|guest escalation|owner escalation)\b/.test(text)
  ) {
    return "high"
  }
  if (/\b(payroll|deposit|billable|work order|meredith|shiela)\b/.test(text)) return "high"
  if (signal.category === "today" || signal.category === "waiting") return "medium"
  return "low"
}

function linkForSignal(
  signal: ResponsibilitySignal,
  links: ResponsibilitySourceLink[]
): { url: string | null; label: string | null } {
  if (signal.sourceUrl) return { url: signal.sourceUrl, label: signal.title }
  const direct = links.find(
    (link) =>
      link.source === signal.source &&
      (signal.title.toLowerCase().includes(link.label.toLowerCase()) ||
        link.label.toLowerCase().includes(signal.title.toLowerCase()))
  )
  const fallback = direct ?? links.find((link) => link.source === signal.source)
  return {
    url: fallback?.url ?? null,
    label: fallback?.label ?? signal.evidence ?? null,
  }
}

export async function logLearningEvent(args: {
  userId: string
  sourceType: OdinLearningSourceType
  sourceId?: string
  eventType: "memory" | "rule" | "pending" | "scan" | "correction"
  summary: string
  payload?: Record<string, unknown>
  status?: "applied" | "skipped" | "failed" | "archived"
}): Promise<number> {
  const { error } = await getAdminClient().from("odin_learning_events").insert({
    user_id: args.userId,
    source_type: args.sourceType,
    source_id: args.sourceId ?? null,
    event_type: args.eventType,
    summary: compact(args.summary, 600),
    payload: args.payload ?? {},
    status: args.status ?? "applied",
  })
  if (error) {
    console.warn("[odin-learning] event insert failed", error.message)
    return 0
  }
  return 1
}

export async function upsertScanSnapshot(args: {
  userId: string
  source: OdinScanSource
  status: "ok" | "partial" | "failed"
  summary: string
  payload?: Record<string, unknown>
  signalCount?: number
  windowDays?: number
  warnings?: string[]
  scannedAt?: string
}): Promise<void> {
  await getAdminClient()
    .from("odin_scan_snapshots")
    .upsert(
      {
        user_id: args.userId,
        source: args.source,
        status: args.status,
        summary: compact(args.summary, 900),
        payload: args.payload ?? {},
        signal_count: args.signalCount ?? 0,
        window_days: args.windowDays ?? null,
        warnings: args.warnings ?? [],
        scanned_at: args.scannedAt ?? new Date().toISOString(),
      },
      { onConflict: "user_id,source" }
    )
    .throwOnError()
}

export async function upsertPendingItemsFromSignals(args: {
  userId: string
  signals: ResponsibilitySignal[]
  sourceLinks?: ResponsibilitySourceLink[]
  sourceType?: OdinLearningSourceType
  sourceId?: string
  scannedSources?: OdinResponsibilitySource[]
}): Promise<OdinLearningSummary> {
  const actionableSignals = dedupeResponsibilitySignals(
    args.signals.filter((signal) => signal.category !== "routine" && signal.category !== "quiet")
  )
  const nonActionableKeys = args.signals
    .filter((signal) => signal.category === "routine" || signal.category === "quiet")
    .map((signal) => canonicalPendingKey(signal))

  if (nonActionableKeys.length > 0) {
    await getAdminClient()
      .from("odin_pending_items")
      .update({
        status: "handled",
        bucket: "done_recently",
        resolved_at: new Date().toISOString(),
      })
      .eq("user_id", args.userId)
      .in("source_item_id", nonActionableKeys)
      .in("status", ["open", "waiting"])
  }

  if (actionableSignals.length === 0) {
    const scannedSources =
      args.scannedSources && args.scannedSources.length > 0
        ? [...new Set(args.scannedSources)]
        : [...new Set(args.signals.map((signal) => signal.source))]
    const supersededCount = await markSupersededPendingRows({
      userId: args.userId,
      sources: scannedSources,
      activeKeys: new Set(),
      now: new Date().toISOString(),
    })
    if (!supersededCount) return { ...EMPTY_LEARNING }
    const eventsLogged = await logLearningEvent({
      userId: args.userId,
      sourceType: args.sourceType ?? "manual_scan",
      sourceId: args.sourceId,
      eventType: "pending",
      summary: `Closed ${supersededCount} stale pending item${supersededCount === 1 ? "" : "s"} because the latest scan found no actionable item.`,
      payload: { supersededCount, sources: scannedSources },
    })
    return {
      memoriesUpdated: 0,
      rulesUpdated: 0,
      pendingUpdated: supersededCount,
      eventsLogged,
    }
  }

  const links = args.sourceLinks ?? []
  const keys = actionableSignals.map((signal) => canonicalPendingKey(signal))
  const { data: existingRows } = await getAdminClient()
    .from("odin_pending_items")
    .select("source,source_item_id,status,bucket,resolved_at")
    .eq("user_id", args.userId)
    .in("source_item_id", keys)

  const existing = new Map(
    (existingRows ?? []).map((row) => [`${row.source}:${row.source_item_id}`, row])
  )
  const now = new Date().toISOString()
  const rows = actionableSignals.map((signal) => {
    const sourceItemId = canonicalPendingKey(signal)
    const current = existing.get(`${signal.source}:${sourceItemId}`)
    const closed = current?.status === "handled" || current?.status === "deferred"
    const status = closed ? current.status : signal.status
    const bucket = closed ? "done_recently" : bucketFromSignal(signal)
    const evidence = linkForSignal(signal, links)
    const nextAction = preciseNextAction(signal) ?? signal.nextAction
    return {
      user_id: args.userId,
      source: signal.source,
      source_item_id: sourceItemId,
      business: signal.business ?? null,
      person: signal.person ?? null,
      title: compact(signal.title, 220),
      summary: compact(signal.summary, 900),
      urgency: urgencyFromSignal(signal),
      bucket,
      status,
      evidence_url: evidence.url,
      evidence_label: evidence.label,
      next_action: compact(nextAction, 500) || null,
      suggested_reply: compact(signal.suggestedReply, 900) || null,
      due_at: signal.dueAt ?? null,
      last_seen_at: now,
      resolved_at: closed ? current.resolved_at : null,
      payload: {
        category: signal.category,
        evidence: signal.evidence ?? null,
        rawSignalId: signal.id,
        responsibilityTopic: responsibilityTopic(signal),
      },
    }
  })

  const { error } = await getAdminClient()
    .from("odin_pending_items")
    .upsert(rows, { onConflict: "user_id,source,source_item_id" })
  if (error) throw new Error(`Failed to upsert pending items: ${error.message}`)

  const activeKeys = new Set(rows.map((row) => `${row.source}:${row.source_item_id}`))
  const scannedSources =
    args.scannedSources && args.scannedSources.length > 0
      ? [...new Set(args.scannedSources)]
      : [...new Set(args.signals.map((signal) => signal.source))]
  const supersededCount = await markSupersededPendingRows({
    userId: args.userId,
    sources: scannedSources,
    activeKeys,
    now,
  })

  const eventsLogged = await logLearningEvent({
    userId: args.userId,
    sourceType: args.sourceType ?? "manual_scan",
    sourceId: args.sourceId,
    eventType: "pending",
    summary: `Updated ${rows.length} persistent pending item${rows.length === 1 ? "" : "s"} and closed ${supersededCount} stale item${supersededCount === 1 ? "" : "s"} from latest ODIN evidence.`,
    payload: {
      count: rows.length,
      supersededCount,
      sources: [...new Set(rows.map((row) => row.source))],
    },
  })

  return {
    memoriesUpdated: 0,
    rulesUpdated: 0,
    pendingUpdated: rows.length + supersededCount,
    eventsLogged,
  }
}

async function markSupersededPendingRows(args: {
  userId: string
  sources: OdinResponsibilitySource[]
  activeKeys: Set<string>
  now: string
}): Promise<number> {
  const pendingSources = args.sources.filter((source) =>
    ["gmail", "slack", "calendar", "health", "browser", "manual", "memory", "research", "system"].includes(source)
  )
  if (!pendingSources.length) return 0

  const { data, error } = await getAdminClient()
    .from("odin_pending_items")
    .select("id,source,source_item_id,status")
    .eq("user_id", args.userId)
    .in("source", pendingSources)
    .in("status", ["open", "waiting"])

  if (error) {
    console.warn("[odin-learning] stale pending lookup failed", error.message)
    return 0
  }

  const staleIds = (data ?? [])
    .filter((row) => !args.activeKeys.has(`${row.source}:${row.source_item_id}`))
    .map((row) => row.id as string)

  if (!staleIds.length) return 0

  const chunkSize = 50
  for (let index = 0; index < staleIds.length; index += chunkSize) {
    const chunk = staleIds.slice(index, index + chunkSize)
    const { error: updateError } = await getAdminClient()
      .from("odin_pending_items")
      .update({
        status: "handled",
        bucket: "done_recently",
        resolved_at: args.now,
      })
      .eq("user_id", args.userId)
      .in("id", chunk)
    if (updateError) {
      console.warn("[odin-learning] stale pending update failed", updateError.message)
      return index
    }
  }

  return staleIds.length
}

export async function listPendingSignals(userId: string, limit = 40): Promise<ResponsibilitySignal[]> {
  const { data, error } = await getAdminClient()
    .from("odin_pending_items")
    .select("id,source,source_item_id,business,person,title,summary,urgency,bucket,status,evidence_url,evidence_label,next_action,suggested_reply,due_at,last_seen_at,payload")
    .eq("user_id", userId)
    .in("status", ["open", "waiting"])
    .order("updated_at", { ascending: false })
    .limit(limit)
  if (error) {
    console.warn("[odin-learning] pending list failed", error.message)
    return []
  }

  return ((data ?? []) as PendingItemRow[])
    .filter((item) => {
      if (item.source !== "gmail" && item.source !== "slack") return true
      const payload = item.payload ?? {}
      return Boolean(
        payload.sourceAgent ||
          payload.source_agent ||
          payload.agent ||
          payload.externalBriefMode === "agent_ingest" ||
          payload.externalBriefMode === "external_brief"
      )
    })
    .map((item) => ({
    id: item.id,
    source: item.source,
    category:
      item.bucket === "waiting_on_others"
        ? "waiting"
        : item.bucket === "today"
          ? "today"
          : item.urgency === "critical" || item.urgency === "high"
            ? "urgent"
            : "follow_up",
    title: item.title,
    summary: item.summary,
    evidence: item.evidence_label ?? undefined,
    nextAction: item.next_action ?? undefined,
    suggestedReply: item.suggested_reply ?? undefined,
    sourceUrl: item.evidence_url ?? undefined,
    dueAt: item.due_at ?? undefined,
    person: item.person ?? undefined,
    business: item.business ?? undefined,
    status: item.status,
    urgency: item.urgency,
  }))
}

export async function getSourceFreshness(userId: string): Promise<OdinSourceFreshness> {
  const { data, error } = await getAdminClient()
    .from("odin_scan_snapshots")
    .select("source,status,summary,signal_count,warnings,scanned_at")
    .eq("user_id", userId)

  const base = Object.fromEntries(
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

  if (error) {
    console.warn("[odin-learning] source freshness failed", error.message)
    return base
  }

  for (const row of (data ?? []) as SnapshotRow[]) {
    base[row.source] = {
      source: row.source,
      status: row.status,
      lastSuccessfulScanAt: row.status === "failed" ? null : row.scanned_at,
      lastScanAt: row.scanned_at,
      signalCount: row.signal_count,
      summary: row.summary,
      warnings: row.warnings ?? [],
    }
  }
  return base
}

export async function buildCachedResponsibilityContext(userId: string): Promise<{
  context: string
  signals: ResponsibilitySignal[]
  sourceLinks: ResponsibilitySourceLink[]
  warnings: string[]
  sourceFreshness: OdinSourceFreshness
  pendingSummary: OdinPendingSummary
}> {
  const [signals, sourceFreshness] = await Promise.all([
    listPendingSignals(userId),
    getSourceFreshness(userId),
  ])
  const warnings = Object.values(sourceFreshness)
    .filter((source) => source.status === "missing" || source.status === "failed")
    .map((source) =>
      source.status === "missing"
        ? `${source.source}: no Claude/Codex source brief stored yet`
        : `${source.source}: last scan failed`
    )
  const sourceLinks = signals
    .filter((signal) => Boolean(signal.sourceUrl))
    .map((signal) => ({
      label: signal.title,
      url: signal.sourceUrl as string,
      source: signal.source,
    }))

  return {
    context: `Cached ODIN responsibility model. Use this as the default source of pending work unless Peter asked for a fresh scan: ${JSON.stringify({
      sourceFreshness,
      pendingItems: signals.slice(0, 18).map((signal) => ({
        source: signal.source,
        title: signal.title,
        summary: signal.summary,
        nextAction: signal.nextAction,
        status: signal.status,
        urgency: signal.urgency,
        business: signal.business,
      })),
    })}`,
    signals,
    sourceLinks,
    warnings,
    sourceFreshness,
    pendingSummary: pendingSummaryFromSignals(signals),
  }
}

async function insertMemoryOnce(args: {
  userId: string
  kind: "preference" | "business" | "person" | "tone" | "priority" | "routine" | "source" | "other"
  title: string
  content: string
  sourceType: OdinLearningSourceType
  sourceId?: string
}): Promise<number> {
  const admin = getAdminClient()
  const title = compact(args.title, 180)
  const content = compact(args.content, 900)
  const { data: existing } = await admin
    .from("odin_memories")
    .select("id")
    .eq("user_id", args.userId)
    .eq("title", title)
    .eq("status", "active")
    .limit(1)
    .maybeSingle()
  if (existing?.id) return 0

  const { error } = await admin.from("odin_memories").insert({
    user_id: args.userId,
    kind: args.kind,
    title,
    content,
    source: "odin",
    confidence: 0.76,
    status: "active",
  })
  if (error) {
    console.warn("[odin-learning] memory insert failed", error.message)
    return 0
  }

  await logLearningEvent({
    userId: args.userId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    eventType: "memory",
    summary: `Learned memory: ${title}`,
    payload: { kind: args.kind, content },
  })
  return 1
}

async function insertSemanticOnce(args: {
  userId: string
  fact: string
  category: "work" | "people" | "preferences"
}): Promise<void> {
  const fact = compact(args.fact, 900)
  const admin = getAdminClient()
  const { data: existing } = await admin
    .from("semantic_memory")
    .select("id")
    .eq("user_id", args.userId)
    .eq("fact", fact)
    .limit(1)
    .maybeSingle()
  if (existing?.id) return

  await admin
    .from("semantic_memory")
    .insert({
      user_id: args.userId,
      fact,
      category: args.category,
      confidence: 0.72,
      source: "auto_learning",
    })
}

async function insertPriorityRuleOnce(args: {
  userId: string
  ruleText: string
  sourceType: OdinLearningSourceType
  sourceId?: string
}): Promise<number> {
  const ruleText = compact(args.ruleText, 360)
  const name = compact(`Learned: ${ruleText}`, 120)
  const admin = getAdminClient()
  const { data: existing } = await admin
    .from("priority_rules")
    .select("id")
    .eq("user_id", args.userId)
    .eq("name", name)
    .limit(1)
    .maybeSingle()
  if (existing?.id) return 0

  const { error } = await admin.from("priority_rules").insert({
    user_id: args.userId,
    name,
    description: `Auto-learned from Peter: ${ruleText}`,
    source_type: "manual",
    conditions: [{ type: "text_contains", value: ruleText }],
    priority_score: 85,
    action_tags: ["auto_learned", "odin"],
    notify: true,
    is_active: true,
    sort_order: 80,
  })
  if (error) {
    console.warn("[odin-learning] priority rule insert failed", error.message)
    return 0
  }

  await logLearningEvent({
    userId: args.userId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    eventType: "rule",
    summary: `Learned priority rule: ${ruleText}`,
    payload: { ruleText },
  })
  return 1
}

export async function runConversationLearning(args: {
  userId: string
  userInput: string
  odinResponse?: string
  sourceType: OdinLearningSourceType
  sourceId?: string
}): Promise<OdinLearningSummary> {
  const text = compact(args.userInput, 2400)
  const lower = text.toLowerCase()
  const summary: OdinLearningSummary = { ...EMPTY_LEARNING }
  if (!text || text.length < 6) return summary

  const rememberMatch = text.match(/\bremember(?: that)?\s+(.{8,420})/i)
  if (rememberMatch?.[1]) {
    const content = compact(rememberMatch[1], 500)
    summary.memoriesUpdated += await insertMemoryOnce({
      userId: args.userId,
      kind: "preference",
      title: `Remembered: ${compact(content, 80)}`,
      content,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
    })
    await insertSemanticOnce({ userId: args.userId, fact: content, category: "preferences" })
  }

  const suppressMatch = text.match(/\b(?:ignore|hide|mute|don't show|do not show|stop showing)\s+(.{3,260})/i)
  if (suppressMatch?.[1]) {
    const target = compact(suppressMatch[1], 220)
    const content = `Peter prefers ODIN to suppress or de-prioritize: ${target}.`
    summary.memoriesUpdated += await insertMemoryOnce({
      userId: args.userId,
      kind: "preference",
      title: `Suppress: ${titleCase(compact(target, 70))}`,
      content,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
    })
    await insertSemanticOnce({ userId: args.userId, fact: content, category: "preferences" })
  }

  const flagMatch = text.match(/\b(?:always flag|flag|watch for|prioritize)\s+(.{4,260})/i)
  if (flagMatch?.[1] && !/\b(do not|don't|never)\b/.test(lower)) {
    const ruleText = compact(flagMatch[1], 220)
    summary.rulesUpdated += await insertPriorityRuleOnce({
      userId: args.userId,
      ruleText,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
    })
  }

  const ownerMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:handles|owns|manages|is responsible for|takes care of)\s+(.{4,220})/)
  if (ownerMatch?.[1] && ownerMatch?.[2]) {
    const person = compact(ownerMatch[1], 80)
    const responsibility = compact(ownerMatch[2], 260)
    const content = `${person} handles ${responsibility}.`
    summary.memoriesUpdated += await insertMemoryOnce({
      userId: args.userId,
      kind: "person",
      title: `${person} role`,
      content,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
    })
    await insertSemanticOnce({ userId: args.userId, fact: content, category: "people" })
  }

  if (summary.memoriesUpdated || summary.rulesUpdated) {
    summary.eventsLogged += await logLearningEvent({
      userId: args.userId,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      eventType: "correction",
      summary: `Auto-learning applied from Peter's wording: ${compact(text, 220)}`,
      payload: {
        memoriesUpdated: summary.memoriesUpdated,
        rulesUpdated: summary.rulesUpdated,
      },
    })
  }

  return summary
}

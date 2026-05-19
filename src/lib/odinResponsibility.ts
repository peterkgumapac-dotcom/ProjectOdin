import { supabase } from "@/lib/supabaseClient"
import type {
  OperationsBusiness,
  OperationsSignal,
  OperationsSignalCategory,
  OperationsSignalSource,
  OperationsSignalStatus,
  OperationsSourceHealth,
} from "@/types/operations"

export type OdinPendingBucket =
  | "needs_peter"
  | "waiting_on_others"
  | "today"
  | "done_recently"

export type OdinScanSnapshotSource =
  | "gmail"
  | "slack"
  | "calendar"
  | "health"
  | "weather"
  | "browser"

export interface OdinPendingItem {
  id: string
  user_id: string
  source: OperationsSignalSource
  source_item_id: string
  business: string | null
  person: string | null
  title: string
  summary: string
  urgency: "critical" | "high" | "medium" | "low"
  bucket: OdinPendingBucket
  status: OperationsSignalStatus
  evidence_url: string | null
  evidence_label: string | null
  next_action: string | null
  suggested_reply: string | null
  due_at: string | null
  last_seen_at: string
  updated_at: string
  payload?: Record<string, unknown> | null
}

export interface OdinScanSnapshot {
  id: string
  user_id: string
  source: OdinScanSnapshotSource
  status: "ok" | "partial" | "failed"
  summary: string
  signal_count: number
  window_days: number | null
  warnings: string[]
  scanned_at: string
  updated_at: string
}

export interface OdinLearningEvent {
  id: string
  user_id: string
  source_type: "conversation" | "post_call" | "manual_scan" | "correction" | "system"
  source_id: string | null
  event_type: "memory" | "rule" | "pending" | "scan" | "correction"
  summary: string
  payload: Record<string, unknown>
  status: "applied" | "skipped" | "failed" | "archived"
  created_at: string
}

export interface OdinPendingSummary {
  needs_peter: number
  waiting_on_others: number
  today: number
  done_recently: number
}

export interface OdinAgentFreshness {
  latestAt: string | null
  latestSourceAgent: string | null
  latestBusiness: string | null
  itemCount: number
  stale: boolean
  detail: string
}

const SOURCE_LABEL: Record<OdinScanSnapshotSource, string> = {
  gmail: "Gmail",
  slack: "Slack",
  calendar: "Calendar",
  health: "Withings",
  weather: "Weather",
  browser: "Browser",
}

const HALL_SOURCE_HEALTH: OdinScanSnapshotSource[] = [
  "gmail",
  "slack",
  "calendar",
  "health",
]

function asBusiness(value: string | null): OperationsBusiness | undefined {
  if (value === "Stay Minty" || value === "Dinbnb" || value === "Personal") return value
  return undefined
}

function businessFromSourceAgent(agent?: string | null): OperationsBusiness | undefined {
  const normalized = (agent ?? "").toLowerCase()
  if (normalized.includes("stayminty") || normalized.includes("stay_minty")) return "Stay Minty"
  if (normalized.includes("dinbnb")) return "Dinbnb"
  return undefined
}

export function pendingItemBusiness(item: OdinPendingItem): OperationsBusiness | undefined {
  return asBusiness(item.business) ?? businessFromSourceAgent(pendingItemSourceAgent(item))
}

function categoryFromPending(item: OdinPendingItem): OperationsSignalCategory {
  if (item.bucket === "waiting_on_others") return "waiting"
  if (item.bucket === "today") return "today"
  if (item.urgency === "critical" || item.urgency === "high") return "urgent"
  return "follow_up"
}

function pendingKeyText(value: string | null | undefined, max = 90): string {
  const text = (value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
  return (text || "none").slice(0, max).replace(/-+$/g, "")
}

function pendingSubjectText(item: OdinPendingItem): string {
  return [
    item.title,
    item.summary,
    item.evidence_label,
    item.suggested_reply,
    item.person,
    item.business,
  ]
    .filter(Boolean)
    .join(" ")
}

function pendingTopic(item: OdinPendingItem): string {
  const text = pendingSubjectText(item).toLowerCase()
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
  if (/\b(calendar|meeting|brief|agenda)\b/.test(text) || item.source === "calendar") return "calendar-event"
  if (/\b(heart|sleep|steps|calories|withings|vitals|pulse)\b/.test(text)) return "health"
  return pendingKeyText(item.title, 80)
}

function pendingEntity(item: OdinPendingItem): string {
  const text = pendingSubjectText(item)
  const property = text.match(/\b[A-Z]{2,6}[/-]\d+(?:[/-][A-Z0-9]+)?\b/i)?.[0]
  if (property) return pendingKeyText(property, 70)
  if (item.source === "gmail" && item.evidence_url) return pendingKeyText(item.evidence_url, 110)
  if (item.person) return `person-${pendingKeyText(item.person, 70)}`
  if (item.evidence_url) return pendingKeyText(item.evidence_url, 110)
  return pendingKeyText(item.source_item_id || item.title, 80)
}

function pendingDedupKey(item: OdinPendingItem): string {
  const hasLegacyBadKey = item.source_item_id.includes("reservation-ponsibility")
  const canonical = item.source_item_id.includes(":") && !hasLegacyBadKey
    ? item.source_item_id
    : [
        item.source,
        pendingKeyText(item.business, 40),
        pendingKeyText(item.person, 58),
        pendingTopic(item),
        pendingEntity(item),
      ].join(":")
  return `${item.source}:${canonical}`
}

function pendingRank(item: OdinPendingItem): number {
  const urgencyRank = { critical: 4, high: 3, medium: 2, low: 1 }[item.urgency]
  const statusRank =
    item.status === "open"
      ? 4
      : item.status === "waiting"
        ? 3
        : item.status === "deferred"
          ? 2
          : 1
  return urgencyRank * 100 + statusRank * 10 + (item.evidence_url ? 3 : 0) + (item.next_action ? 2 : 0)
}

function pendingSortRank(item: OdinPendingItem): number {
  const activeRank = item.status === "open" || item.status === "waiting" ? 1000 : 0
  const bucketRank =
    item.bucket === "needs_peter"
      ? 300
      : item.bucket === "today"
        ? 200
        : item.bucket === "waiting_on_others"
          ? 150
          : 0
  return activeRank + bucketRank + pendingRank(item)
}

function agentPayloadValue(item: OdinPendingItem, key: string): string | null {
  const value = item.payload?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function pendingItemSourceAgent(item: OdinPendingItem): string | null {
  return (
    agentPayloadValue(item, "sourceAgent") ??
    agentPayloadValue(item, "source_agent") ??
    agentPayloadValue(item, "agent")
  )
}

export function isAgentPendingItem(item: OdinPendingItem): boolean {
  const mode = agentPayloadValue(item, "externalBriefMode")
  return Boolean(pendingItemSourceAgent(item) || mode === "agent_ingest" || mode === "external_brief")
}

function isTrustedPendingItem(item: OdinPendingItem): boolean {
  if (item.source !== "gmail" && item.source !== "slack") return true
  return isAgentPendingItem(item)
}

export function formatAgentBriefAge(iso?: string | null): string {
  if (!iso) return "never"
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return "unknown"
  const diffMs = Math.max(0, Date.now() - time)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function agentBriefLabel(agent?: string | null): string {
  const normalized = (agent ?? "").toLowerCase()
  if (normalized.includes("stayminty") || normalized.includes("stay_minty")) return "source brief"
  if (normalized.includes("dinbnb")) return "source brief"
  if (normalized.includes("claude") || normalized.includes("codex")) return "ODIN source brief"
  return "ODIN source brief"
}

export function summarizeAgentFreshness(
  items: OdinPendingItem[],
  staleMs = 30 * 60 * 1000,
  business?: OperationsBusiness
): OdinAgentFreshness {
  const agentItems = items.filter(
    (item) =>
      isAgentPendingItem(item) &&
      (!business || pendingItemBusiness(item) === business)
  )
  const newest = [...agentItems].sort((a, b) => {
    const bTime = new Date(b.last_seen_at || b.updated_at).getTime()
    const aTime = new Date(a.last_seen_at || a.updated_at).getTime()
    return bTime - aTime
  })[0]

  if (!newest) {
    return {
      latestAt: null,
      latestSourceAgent: null,
      latestBusiness: null,
      itemCount: 0,
      stale: true,
      detail: "No fresh ODIN source brief has reached ODIN yet.",
    }
  }

  const latestAt = newest.last_seen_at || newest.updated_at
  const latestTime = new Date(latestAt).getTime()
  const stale = !Number.isFinite(latestTime) || Date.now() - latestTime > staleMs
  const latestSourceAgent = pendingItemSourceAgent(newest)
  const latestBusiness = pendingItemBusiness(newest) ?? newest.business
  const label = agentBriefLabel(latestSourceAgent)
  return {
    latestAt,
    latestSourceAgent,
    latestBusiness,
    itemCount: agentItems.length,
    stale,
    detail: `${stale ? "Stale" : "Fresh"} ${latestBusiness ? `${latestBusiness} ` : ""}${label}: ${formatAgentBriefAge(latestAt)}.`,
  }
}

export function hasAgentBriefAfter(
  items: OdinPendingItem[],
  since: Date,
  business?: OperationsBusiness
): boolean {
  const threshold = since.getTime()
  return items.some((item) => {
    if (!isAgentPendingItem(item)) return false
    if (business && pendingItemBusiness(item) !== business) return false
    const time = new Date(item.last_seen_at || item.updated_at).getTime()
    return Number.isFinite(time) && time > threshold
  })
}

function dedupePendingItems(items: OdinPendingItem[]): OdinPendingItem[] {
  const byKey = new Map<string, OdinPendingItem>()
  for (const item of items) {
    const key = pendingDedupKey(item)
    const existing = byKey.get(key)
    if (!existing || pendingRank(item) >= pendingRank(existing)) {
      byKey.set(key, item)
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const rankDelta = pendingSortRank(b) - pendingSortRank(a)
    return rankDelta || b.updated_at.localeCompare(a.updated_at)
  })
}

export function pendingItemToSignal(item: OdinPendingItem): OperationsSignal {
  return {
    id: item.id,
    source: item.source,
    category: categoryFromPending(item),
    title: item.title,
    summary: item.summary,
    evidence: item.evidence_label ?? undefined,
    nextAction: item.next_action ?? undefined,
    suggestedReply: item.suggested_reply ?? undefined,
    sourceUrl: item.evidence_url ?? undefined,
    dueAt: item.due_at ?? undefined,
    person: item.person ?? undefined,
    business: pendingItemBusiness(item),
    status: item.status,
  }
}

export function summarizePending(items: OdinPendingItem[]): OdinPendingSummary {
  return items.reduce(
    (summary, item) => {
      if (item.status === "handled" || item.status === "deferred" || item.bucket === "done_recently") {
        summary.done_recently += 1
      } else if (item.status === "waiting" || item.bucket === "waiting_on_others") {
        summary.waiting_on_others += 1
      } else if (item.bucket === "today") {
        summary.today += 1
      } else {
        summary.needs_peter += 1
      }
      return summary
    },
    { needs_peter: 0, waiting_on_others: 0, today: 0, done_recently: 0 }
  )
}

export async function listOdinPendingItems(userId: string): Promise<OdinPendingItem[]> {
  const { data, error } = await supabase
    .from("odin_pending_items")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["open", "waiting"])
    .order("updated_at", { ascending: false })
    .limit(80)
  if (error) throw new Error(error.message)
  return dedupePendingItems(((data ?? []) as OdinPendingItem[]).filter(isTrustedPendingItem))
}

export async function updateOdinPendingItemStatus(
  id: string,
  status: OperationsSignalStatus
): Promise<void> {
  const patch =
    status === "handled" || status === "deferred"
      ? { status, bucket: "done_recently", resolved_at: new Date().toISOString() }
      : {
          status,
          bucket: status === "waiting" ? "waiting_on_others" : "needs_peter",
          resolved_at: null,
        }
  const { error } = await supabase
    .from("odin_pending_items")
    .update(patch)
    .eq("id", id)
  if (error) throw new Error(error.message)
}

export async function listOdinScanSnapshots(userId: string): Promise<OdinScanSnapshot[]> {
  const { data, error } = await supabase
    .from("odin_scan_snapshots")
    .select("*")
    .eq("user_id", userId)
    .order("scanned_at", { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as OdinScanSnapshot[]
}

export async function listOdinLearningEvents(userId: string): Promise<OdinLearningEvent[]> {
  const { data, error } = await supabase
    .from("odin_learning_events")
    .select("*")
    .eq("user_id", userId)
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)
  return (data ?? []) as OdinLearningEvent[]
}

export async function archiveOdinLearningEvent(id: string): Promise<void> {
  const { error } = await supabase
    .from("odin_learning_events")
    .update({ status: "archived" })
    .eq("id", id)
  if (error) throw new Error(error.message)
}

export function scanSnapshotsToSourceHealth(
  snapshots: OdinScanSnapshot[]
): OperationsSourceHealth[] {
  const latest = new Map(snapshots.map((snapshot) => [snapshot.source, snapshot]))
  return HALL_SOURCE_HEALTH.map((source) => {
    const snapshot = latest.get(source)
    if (!snapshot) {
      return {
        id: source,
        label: SOURCE_LABEL[source],
        state: "attention",
        detail: "No source brief received yet.",
      }
    }
    return {
      id: source,
      label: SOURCE_LABEL[source],
      state:
        snapshot.status === "ok"
          ? "healthy"
          : snapshot.status === "partial"
            ? "attention"
            : "disconnected",
      detail: snapshot.summary || "Last known source brief.",
      checkedAt: snapshot.scanned_at,
    }
  })
}

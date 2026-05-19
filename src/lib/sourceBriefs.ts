import { supabase } from "@/lib/supabaseClient"

export type SourceBriefBusiness = "Stay Minty" | "Dinbnb"
export type SourceBriefSource = "stayminty_automation" | "dinbnb_automation"

export interface SourceBriefItem {
  id: string | null
  title: string
  summary: string
  person: string | null
  urgency: "critical" | "high" | "medium" | "low"
  bucket: "needs_peter" | "waiting_on_others" | "today" | "done_recently"
  status: "open" | "handled" | "deferred" | "waiting"
  nextAction: string | null
  sourceType: "slack" | "gmail" | "drive"
  sourceUrl: string | null
  evidenceLabel: string | null
}

export interface SourceBrief {
  id: string
  business: SourceBriefBusiness
  source: SourceBriefSource
  title: string
  summary: string
  report: string | null
  urgencyScore: number
  sourceAgent: string | null
  items: SourceBriefItem[]
  createdAt: string
}

type SourceBriefRow = {
  id: string
  title: string
  content: string
  source: string
  context_json?: unknown
  created_at: string
}

const SOURCES: SourceBriefSource[] = ["stayminty_automation", "dinbnb_automation"]

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function businessFromSource(source: string): SourceBriefBusiness {
  return source === "dinbnb_automation" ? "Dinbnb" : "Stay Minty"
}

function urgency(value: unknown): SourceBriefItem["urgency"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low"
    ? value
    : "medium"
}

function bucket(value: unknown): SourceBriefItem["bucket"] {
  return value === "needs_peter" ||
    value === "waiting_on_others" ||
    value === "today" ||
    value === "done_recently"
    ? value
    : "needs_peter"
}

function status(value: unknown): SourceBriefItem["status"] {
  return value === "open" || value === "handled" || value === "deferred" || value === "waiting"
    ? value
    : "open"
}

function sourceType(value: unknown): SourceBriefItem["sourceType"] {
  return value === "gmail" || value === "drive" || value === "slack" ? value : "slack"
}

function parseItems(value: unknown): SourceBriefItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SourceBriefItem | null => {
      const item = record(raw)
      const title = text(item.title) ?? text(item.subject) ?? text(item.person)
      const summary = text(item.summary) ?? text(item.description) ?? text(item.evidence)
      if (!title || !summary) return null
      return {
        id: text(item.id),
        title,
        summary,
        person: text(item.person),
        urgency: urgency(item.urgency),
        bucket: bucket(item.bucket),
        status: status(item.status),
        nextAction: text(item.nextAction) ?? text(item.next_action) ?? text(item.action),
        sourceType: sourceType(item.sourceType ?? item.source_type),
        sourceUrl: text(item.sourceUrl) ?? text(item.source_url),
        evidenceLabel: text(item.evidenceLabel) ?? text(item.evidence_label),
      }
    })
    .filter((item): item is SourceBriefItem => Boolean(item))
}

function sourceBriefFromRow(row: SourceBriefRow): SourceBrief | null {
  if (!SOURCES.includes(row.source as SourceBriefSource)) return null
  const context = record(row.context_json)
  return {
    id: row.id,
    business: businessFromSource(row.source),
    source: row.source as SourceBriefSource,
    title: row.title,
    summary: row.content,
    report: text(context.report_markdown) ?? text(context.report) ?? text(context.polished_report),
    urgencyScore: numberValue(context.urgency_score),
    sourceAgent: text(context.source_agent),
    items: parseItems(context.items),
    createdAt: row.created_at,
  }
}

export async function listLatestSourceBriefs(userId: string): Promise<SourceBrief[]> {
  const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from("odin_memories")
    .select("id,title,content,source,context_json,created_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .in("source", SOURCES)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(12)

  if (error) throw new Error(error.message)

  const latest = new Map<SourceBriefSource, SourceBrief>()
  for (const row of data ?? []) {
    const brief = sourceBriefFromRow(row as SourceBriefRow)
    if (brief && !latest.has(brief.source)) latest.set(brief.source, brief)
  }
  return [...latest.values()]
}

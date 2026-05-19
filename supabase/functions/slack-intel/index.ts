// Edge Function: slack-intel v5
// DOO lens: only surfaces items Peter is personally involved in or must unblock.

// @ts-expect-error Deno
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
// @ts-expect-error Deno npm specifier
import Anthropic from "npm:@anthropic-ai/sdk@0.95"
import { corsPreflight, jsonResponse } from "../_shared/cors.ts"
import { getCallerUserId } from "../_shared/supabase_admin.ts"
import { listProviderAccounts } from "../_shared/connected_accounts.ts"
import { getSlackTokens } from "../_shared/slack.ts"

const SLACK_BASE = "https://slack.com/api"
const MESSAGES_PER_DM = 16
const MESSAGES_PER_CHANNEL = 8
const MAX_STANDARD_CHANNELS = 1
const MAX_DMS = 12
const LOOKBACK_DAYS = 3
const HISTORY_DELAY_MS = 350
const PETER_USER_ID = "3e44b0c2-0fde-4279-90b3-1491320ff3e4"
const PRIORITY_DM_NAMES = [
  "meredith",
  "kelli",
  "shiela",
  "reveen",
  "kim",
  "eana",
]
const DOO_SEARCH_TERMS = [
  "billables",
  "billable",
  "deposit",
  "signature",
  "approval",
  "owner",
  "payroll",
  "warning",
  "written warning",
  "performance",
  "unacceptable",
  "do this job",
  "want this job",
  "direct conversation",
  "termination",
  "overwhelmed",
  "work order",
  "storage",
  "TrackHS",
]

interface SlackChannel {
  id: string
  name?: string
  is_member?: boolean
  is_im?: boolean
  user?: string
  unread_count?: number
  updated?: number
}
interface SlackUser {
  id: string
  real_name?: string
  profile?: {
    display_name?: string
    real_name?: string
  }
}
interface SlackMessage {
  user?: string
  text?: string
  ts: string
}
interface SlackSearchMatch {
  channel?: {
    id?: string
    name?: string
  }
  user?: string
  username?: string
  text?: string
  ts?: string
  permalink?: string
}

function tsToReadable(ts: string): string {
  const ms = parseFloat(ts) * 1000
  if (!Number.isFinite(ms)) return ts
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function cleanSlackText(raw: string): string {
  return raw
    .replace(/<@([A-Z0-9]+)\|?([^>]*)>/g, (_m, _id, l) => (l ? `@${l}` : "@user"))
    .replace(/<#([A-Z0-9]+)\|?([^>]*)>/g, (_m, _id, l) => (l ? `#${l}` : "#channel"))
    .replace(/<!subteam\^[A-Z0-9]+\|?([^>]*)>/g, (_m, l) => l || "@group")
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/:[a-z0-9_+-]+:/g, "")
    .replace(/\*\*?([^*\n]+)\*\*?/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function displayName(user?: SlackUser): string | null {
  if (!user) return null
  return (
    user.profile?.display_name?.trim() ||
    user.profile?.real_name?.trim() ||
    user.real_name?.trim() ||
    user.id
  )
}

function ymdInManila(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function slackApiFetch(
  token: string,
  url: string,
  timeoutMs = 7000
): Promise<Response> {
  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (res.status !== 429) return res

  const retryAfter = Number(res.headers.get("retry-after") ?? "1")
  await sleep(Math.min(Math.max(retryAfter, 1), 5) * 1000)
  res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  return res
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveSlackUsers(
  token: string,
  userIds: string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const unique = Array.from(new Set(userIds.filter(Boolean)))
  await Promise.allSettled(
    unique.map(async (user) => {
      const qs = new URLSearchParams({ user })
      const res = await fetch(`${SLACK_BASE}/users.info?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return
      const json = (await res.json()) as {
        ok: boolean
        user?: SlackUser
      }
      const name = displayName(json.user)
      if (json.ok && name) names.set(user, name)
    })
  )
  return names
}

async function searchSlackMessages(
  token: string,
  query: string,
  userNames: Map<string, string>
): Promise<{
  block: string | null
  count: number
  warning?: string
}> {
  try {
    const qs = new URLSearchParams({
      query,
      count: "20",
      sort: "timestamp",
      sort_dir: "desc",
    })
    const res = await slackApiFetch(
      token,
      `${SLACK_BASE}/search.messages?${qs}`,
      5000
    )
    if (!res.ok) {
      return {
        block: null,
        count: 0,
        warning: `search.messages HTTP ${res.status}`,
      }
    }
    const json = (await res.json()) as {
      ok: boolean
      error?: string
      messages?: {
        matches?: SlackSearchMatch[]
      }
    }
    if (!json.ok) {
      return {
        block: null,
        count: 0,
        warning: `search.messages ${json.error ?? "error"}`,
      }
    }
    const matches = json.messages?.matches ?? []
    if (matches.length === 0) return { block: null, count: 0 }
    const missingUserIds = Array.from(
      new Set(
        matches
          .map((m) => m.user)
          .filter((v): v is string => typeof v === "string" && !userNames.has(v))
      )
    )
    if (missingUserIds.length > 0) {
      const resolved = await resolveSlackUsers(token, missingUserIds)
      for (const [id, name] of resolved) userNames.set(id, name)
    }
    const lines = matches
      .map((m) => {
        const sender = m.user ? userNames.get(m.user) ?? m.username ?? m.user : m.username ?? "Unknown"
        const channel = m.channel?.name ? `#${m.channel.name}` : m.channel?.id ?? "DM/private"
        const when = m.ts ? tsToReadable(m.ts) : "unknown time"
        return `  [${when}] ${channel} ${sender}: ${cleanSlackText(m.text ?? "")}`
      })
      .join("\n")
    return { block: `### Slack search: ${query}\n${lines}`, count: matches.length }
  } catch {
    return { block: null, count: 0, warning: "search.messages request timed out" }
  }
}

async function fetchChannelHistory(
  token: string,
  channel: SlackChannel,
  oldestTs: number,
  userNames: Map<string, string>,
  selfUserId: string | null
): Promise<{
  block: string | null
  count: number
  latestTs: number
  warning?: string
}> {
  try {
    const qs = new URLSearchParams({
      channel: channel.id,
      limit: String(channel.is_im ? MESSAGES_PER_DM : MESSAGES_PER_CHANNEL),
      oldest: String(oldestTs),
    })
    const res = await slackApiFetch(
      token,
      `${SLACK_BASE}/conversations.history?${qs}`,
      5000
    )
    if (!res.ok) {
      return {
        block: null,
        count: 0,
        latestTs: 0,
        warning: `${channel.name ?? channel.id}: Slack HTTP ${res.status}`,
      }
    }
    const json = (await res.json()) as {
      ok: boolean
      error?: string
      messages?: SlackMessage[]
    }
    if (!json.ok) {
      return {
        block: null,
        count: 0,
        latestTs: 0,
        warning: `${channel.name ?? channel.id}: Slack ${json.error ?? "error"}`,
      }
    }
    if (!json.messages?.length) return { block: null, count: 0, latestTs: 0 }
    const missingUserIds = Array.from(
      new Set(
        json.messages
          .map((m) => m.user)
          .filter(
            (v): v is string =>
              typeof v === "string" && v !== selfUserId && !userNames.has(v)
          )
      )
    )
    if (missingUserIds.length > 0) {
      const resolved = await resolveSlackUsers(token, missingUserIds)
      for (const [id, name] of resolved) userNames.set(id, name)
    }
    const lines = json.messages
      .map((m) => {
        const sender =
          m.user && m.user === selfUserId
            ? "Peter"
            : m.user
              ? userNames.get(m.user) ?? m.user
              : "Unknown"
        return `  [${tsToReadable(m.ts)}] ${sender}: ${cleanSlackText(m.text ?? "")}`
      })
      .reverse()
      .join("\n")
    const latestTs = Math.max(
      ...json.messages.map((m) => parseFloat(m.ts)).filter(Number.isFinite)
    )
    const label = channel.is_im
      ? `### DM with ${channel.user ? userNames.get(channel.user) ?? channel.user : "Unknown"}`
      : `### #${channel.name ?? channel.id}`
    return { block: `${label}\n${lines}`, count: json.messages.length, latestTs }
  } catch {
    return {
      block: null,
      count: 0,
      latestTs: 0,
      warning: `${channel.name ?? channel.id}: request timed out`,
    }
  }
}

export interface IntelItem {
  source?: "slack"
  business?: "Stay Minty" | "Dinbnb" | "Personal" | "Unassigned"
  sourceUrl?: string
  sourceLabel?: string
  workspaceId?: string
  workspaceName?: string
  urgency: "critical" | "high" | "medium" | "low"
  workspace: string
  workspace_id?: string
  channel: string
  channel_id?: string
  ts?: string
  permalink?: string
  sent_at: string
  summary: string
  action: string
  evidence?: string
  reply?: string
  person?: string
  why_now?: string
}

function businessFromSlackText(text: string): NonNullable<IntelItem["business"]> {
  const lower = text.toLowerCase()
  if (
    /\b(dinbnb|lev|oslo|bergen|guesty|hostaway|pricelabs|emil|jonas|kasper|nameda|diana|king emmanuel|rob|gerson|jane)\b/i.test(
      text
    ) ||
    lower.includes("kg-") ||
    lower.includes("get team") ||
    lower.includes("apartment hotel")
  ) {
    return "Dinbnb"
  }
  if (
    lower.includes("stay minty") ||
    lower.includes("stayminty") ||
    lower.includes("smoky") ||
    lower.includes("nashville") ||
    lower.includes("glamp") ||
    lower.includes("dunn's creek") ||
    lower.includes("dunns creek") ||
    lower.includes("stellara") ||
    lower.includes("evermere") ||
    /\b(meredith|kelli|reveen|jessica|eric|andy|sean|brandi|shiela|skie)\b/i.test(text)
  ) {
    return "Stay Minty"
  }
  return "Unassigned"
}

function withSlackMetadata(item: IntelItem): IntelItem {
  const business =
    item.business && item.business !== "Unassigned"
      ? item.business
      : businessFromSlackText(
          `${item.workspace} ${item.channel} ${item.person ?? ""} ${item.summary} ${item.action} ${item.evidence ?? ""}`
        )
  return {
    ...item,
    source: "slack",
    business,
    sourceLabel: "Slack",
    sourceUrl: item.sourceUrl ?? item.permalink,
    workspaceId: item.workspaceId ?? item.workspace_id,
    workspaceName: item.workspaceName ?? item.workspace,
  }
}

interface AgentMetrics {
  workspacesScanned: number
  channelsScanned: number
  messagesScanned: number
  warnings: string[]
}

interface ScanFilters {
  accountId?: string
  channelId?: string
  channelName?: string
  dateFrom?: string
  dateTo?: string
}

interface AgentContext {
  userId: string
  accounts: Awaited<ReturnType<typeof listProviderAccounts>>
  nowMs: number
  metrics: AgentMetrics
  filters: ScanFilters
}

function isYmd(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function addManilaDays(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00+08:00`) + days * 24 * 60 * 60 * 1000
  return ymdInManila(ms)
}

function manilaStartSeconds(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00+08:00`) / 1000
}

function buildScanWindow(ctx: Pick<AgentContext, "nowMs" | "filters">) {
  const fallbackFrom = ymdInManila(
    ctx.nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  )
  const fallbackTo = ymdInManila(ctx.nowMs)
  const from = isYmd(ctx.filters.dateFrom) ? ctx.filters.dateFrom : fallbackFrom
  const to = isYmd(ctx.filters.dateTo) ? ctx.filters.dateTo : fallbackTo
  const orderedFrom = from <= to ? from : to
  const orderedTo = from <= to ? to : from
  const before = addManilaDays(orderedTo, 1)
  return {
    afterDate: orderedFrom,
    beforeDate: before,
    oldest: String(manilaStartSeconds(orderedFrom)),
    latest: String(manilaStartSeconds(before)),
    label: `${orderedFrom} to ${orderedTo}`,
  }
}

function parseIntelItems(rawText: string): IntelItem[] {
  const jsonText = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()

  try {
    const parsed = JSON.parse(jsonText)
    if (Array.isArray(parsed)) return parsed as IntelItem[]
  } catch {
    const match = jsonText.match(/\[[\s\S]*\]/)
    if (match) {
      try {
        const parsed = JSON.parse(match[0])
        if (Array.isArray(parsed)) return parsed as IntelItem[]
      } catch {
        return []
      }
    }
  }
  return []
}

function textFromMessage(message: { content: Array<Record<string, unknown>> }) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("")
    .trim()
}

function isResolvedNoise(text: string): boolean {
  return /\b(okay na|updated na|done na|got it covered|no worries|resolved|completed|processed today)\b/i.test(
    text
  )
}

function fallbackBrief(text: string): string {
  return text.length > 220 ? `${text.slice(0, 217)}...` : text
}

function fallbackGuidance(text: string, person: string): {
  urgency: IntelItem["urgency"]
  why_now: string
  action: string
  reply: string
} {
  if (/payroll|payrun|overpaid|deduct|time off|zero task/i.test(text)) {
    return {
      urgency: "high",
      why_now:
        "Payroll/accountability issues can create pay errors, missing documentation, or unresolved performance gaps if they sit open.",
      action: `Confirm with ${person} that the payroll edit or attendance issue is closed, save proof of the final payrun/status, and document the accountability note today.`,
      reply: `Hey ${person} — can you confirm this is fully closed and send me the final payrun/status screenshot? I’m documenting the accountability side on my end today.`,
    }
  }
  if (/billable|work order|TrackHS|Track/i.test(text)) {
    return {
      urgency: "high",
      why_now:
        "Billables and work orders affect owner charges and finance handoff, so unclear ownership will keep bouncing back to Peter.",
      action: `Align with ${person} on the exact unchecked billables/work orders, finish the Track update, and post a completion note before finance proceeds.`,
      reply: `Hey ${person} — send me the remaining unchecked billables/work orders and I’ll close the Track update today, then I’ll post a clean completion note for finance.`,
    }
  }
  if (/deposit|signature|approval|owner/i.test(text)) {
    return {
      urgency: "high",
      why_now:
        "Approval or deposit blockers can stop vendor work, material ordering, or owner-facing decisions.",
      action: `Identify whose approval is required, route the approval/deposit ask to that owner, and confirm back to ${person} once the vendor can proceed.`,
      reply: `Hey ${person} — I’ll route the approval/deposit requirement to the right owner now and confirm once the vendor has what they need to proceed.`,
    }
  }
  if (/warning|termination|overwhelmed|unacceptable|want this job/i.test(text)) {
    return {
      urgency: "critical",
      why_now:
        "This is a leadership/accountability escalation and needs a direct response from Peter, not passive monitoring.",
      action: `Respond directly to ${person}, acknowledge the escalation, state the corrective plan, and schedule the direct conversation if needed.`,
      reply: `Hey ${person} — I hear you. I’m taking ownership of this, closing the immediate items today, and I’m available for a direct conversation so we can reset expectations clearly.`,
    }
  }
  if (/storage/i.test(text)) {
    return {
      urgency: "medium",
      why_now:
        "Ownership ambiguity blocks the team from updating Track or routing expenses correctly.",
      action: `Confirm the storage owner, update the source of truth, and reply to ${person} with the owner name.`,
      reply: `Hey ${person} — I’m confirming the storage owner now. I’ll update Track/source of truth and send you the owner name once verified.`,
    }
  }
  return {
    urgency: "medium",
    why_now:
      "This matched the 3-day DOO scan and appears to need Peter to confirm status, unblock someone, or document the decision.",
    action: `Reply to ${person} with the current status, the decision needed, and the next owner/date.`,
    reply: `Hey ${person} — I’m checking this now. I’ll confirm the current status, decision needed, and next owner/date today.`,
  }
}

function fallbackScore(text: string, source: "dm" | "search"): number {
  let score = source === "dm" ? 20 : 0
  if (
    /do this job|want this job|unacceptable|overwhelmed|direct conversation|weak link|written warning|termination|warned you|position/i.test(
      text
    )
  ) {
    score += 120
  }
  if (/payroll|payrun|overpaid|deduct|time off|zero task|zero tasks/i.test(text)) {
    score += 100
  }
  if (/deposit|signature|approval|approved|owner/i.test(text)) score += 85
  if (/billable|billables|work order|w\/o|TrackHS|Track/i.test(text)) score += 75
  if (/safety|fire|flood|injury|leak|ceiling drip/i.test(text)) score += 70
  if (/https?:\/\/\S+/.test(text) && text.length < 120) score += 25
  if (isResolvedNoise(text)) score -= 200
  if (/review|reservation|good morning|last minute booking/i.test(text)) score -= 80
  return score
}

function urgencyForScore(score: number): IntelItem["urgency"] {
  if (score >= 120) return "critical"
  if (score >= 85) return "high"
  if (score >= 55) return "medium"
  return "low"
}

function formatEvidenceForClaude(retrieved: {
  priority_dms?: { conversations?: Array<Record<string, unknown>> }
  searches?: Array<{ matches?: Array<Record<string, unknown>> }>
  channel_reads?: { channels?: Array<Record<string, unknown>> }
}): string {
  const blocks: string[] = []
  const channelReads = retrieved.channel_reads?.channels ?? []
  if (channelReads.length > 0) {
    const readBlocks = channelReads
      .map((channel) => {
        const workspace = String(channel.workspace ?? "Slack")
        const channelId = String(
          channel.channel_name ?? channel.channel_id ?? "channel"
        )
        const messages = Array.isArray(channel.messages) ? channel.messages : []
        const lines = messages
          .map((msg) => {
            if (!msg || typeof msg !== "object") return null
            const record = msg as Record<string, unknown>
            const sender = String(record.sender ?? "Unknown")
            const sentAt = String(record.sent_at ?? "")
            const text = cleanSlackText(String(record.text ?? ""))
            if (!text) return null
            return `  [${sentAt}] ${sender}: ${text}`
          })
          .filter((line): line is string => Boolean(line))
          .join("\n")
        if (!lines) return null
        return `### ${workspace} channel ${channelId}\n${lines}`
      })
      .filter((block): block is string => Boolean(block))
    if (readBlocks.length > 0) {
      blocks.push(`## Selected channel history\n${readBlocks.join("\n\n")}`)
    }
  }

  const conversations = retrieved.priority_dms?.conversations ?? []
  if (conversations.length > 0) {
    const dmBlocks = conversations
      .map((conv) => {
        const workspace = String(conv.workspace ?? "Slack")
        const person = String(conv.person ?? "Unknown")
        const messages = Array.isArray(conv.messages) ? conv.messages : []
        const lines = messages
          .map((msg) => {
            if (!msg || typeof msg !== "object") return null
            const record = msg as Record<string, unknown>
            const sender = String(record.sender ?? "Unknown")
            const sentAt = String(record.sent_at ?? "")
            const text = cleanSlackText(String(record.text ?? ""))
            if (!text) return null
            const score = fallbackScore(text, "dm")
            if (score <= 30) return null
            return { score, line: `  [${sentAt}] ${sender}: ${text}` }
          })
          .filter((item): item is { score: number; line: string } => Boolean(item))
          .sort((a, b) => b.score - a.score)
          .slice(0, 6)
          .map((item) => item.line)
          .join("\n")
        if (!lines) return null
        return `### ${workspace} DM with ${person}\n${lines}`
      })
      .filter((block): block is string => Boolean(block))
    if (dmBlocks.length > 0) {
      blocks.push(`## Recent priority DMs\n${dmBlocks.join("\n\n")}`)
    }
  }

  const seen = new Set<string>()
  const searchLines: Array<{ score: number; line: string }> = []
  for (const search of retrieved.searches ?? []) {
    for (const match of search.matches ?? []) {
      const workspace = String(match.workspace ?? "Slack")
      const channel = String(match.channel ?? "DM/private")
      const user = String(match.user ?? "Unknown")
      const sentAt = String(match.sent_at ?? "")
      const text = cleanSlackText(String(match.text ?? ""))
      if (!text) continue
      const key = `${workspace}:${channel}:${user}:${sentAt}:${text.slice(0, 100)}`
      if (seen.has(key)) continue
      seen.add(key)
      const score = fallbackScore(text, "search")
      if (score <= 30) continue
      searchLines.push({
        score,
        line: `  [${sentAt}] ${workspace} ${channel} ${user}: ${text}`,
      })
    }
  }
  if (searchLines.length > 0) {
    blocks.push(
      `## Slack search hits\n${searchLines
        .sort((a, b) => b.score - a.score)
        .slice(0, 36)
        .map((item) => item.line)
        .join("\n")}`
    )
  }

  return blocks.join("\n\n---\n\n")
}

function sourceCandidates(retrieved: {
  priority_dms?: { conversations?: Array<Record<string, unknown>> }
  searches?: Array<{ matches?: Array<Record<string, unknown>> }>
  channel_reads?: { channels?: Array<Record<string, unknown>> }
}) {
  const candidates: Array<{
    workspace: string
    workspace_id: string
    channel: string
    channel_id: string
    person: string
    sent_at: string
    ts: string
    permalink?: string
    text: string
  }> = []

  for (const channel of retrieved.channel_reads?.channels ?? []) {
    const messages = Array.isArray(channel.messages) ? channel.messages : []
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue
      const record = msg as Record<string, unknown>
      candidates.push({
        workspace: String(channel.workspace ?? "Slack"),
        workspace_id: String(channel.workspace_id ?? ""),
        channel: String(channel.channel_name ?? channel.channel_id ?? "channel"),
        channel_id: String(channel.channel_id ?? ""),
        person: String(record.sender ?? "Slack"),
        sent_at: String(record.sent_at ?? ""),
        ts: String(record.ts ?? ""),
        permalink:
          typeof record.permalink === "string" ? record.permalink : undefined,
        text: cleanSlackText(String(record.text ?? "")),
      })
    }
  }

  for (const conv of retrieved.priority_dms?.conversations ?? []) {
    const messages = Array.isArray(conv.messages) ? conv.messages : []
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue
      const record = msg as Record<string, unknown>
      candidates.push({
        workspace: String(conv.workspace ?? "Slack"),
        workspace_id: String(conv.workspace_id ?? ""),
        channel: "DM",
        channel_id: String(conv.channel_id ?? ""),
        person: String(conv.person ?? record.sender ?? "DM"),
        sent_at: String(record.sent_at ?? ""),
        ts: String(record.ts ?? ""),
        permalink:
          typeof record.permalink === "string" ? record.permalink : undefined,
        text: cleanSlackText(String(record.text ?? "")),
      })
    }
  }

  for (const search of retrieved.searches ?? []) {
    for (const match of search.matches ?? []) {
      candidates.push({
        workspace: String(match.workspace ?? "Slack"),
        workspace_id: String(match.workspace_id ?? ""),
        channel: String(match.channel ?? "DM/private"),
        channel_id: String(match.channel_id ?? ""),
        person: String(match.user ?? "Slack"),
        sent_at: String(match.sent_at ?? ""),
        ts: String(match.ts ?? ""),
        permalink:
          typeof match.permalink === "string" ? match.permalink : undefined,
        text: cleanSlackText(String(match.text ?? "")),
      })
    }
  }

  return candidates.filter((candidate) => candidate.text && candidate.ts)
}

function overlapScore(item: IntelItem, candidate: ReturnType<typeof sourceCandidates>[number]) {
  let score = 0
  if (item.workspace === candidate.workspace) score += 20
  if (item.sent_at && item.sent_at === candidate.sent_at) score += 35
  if (
    item.person &&
    candidate.person.toLowerCase().includes(item.person.toLowerCase())
  ) {
    score += 20
  }
  const needle = cleanSlackText(
    `${item.evidence ?? ""} ${item.summary ?? ""}`
  ).toLowerCase()
  const haystack = candidate.text.toLowerCase()
  for (const part of needle.split(/\s+/).filter((word) => word.length > 5)) {
    if (haystack.includes(part)) score += 2
  }
  if (needle.slice(0, 45) && haystack.includes(needle.slice(0, 45))) score += 40
  return score
}

function attachSourceLinks(
  items: IntelItem[],
  retrieved: {
    priority_dms?: { conversations?: Array<Record<string, unknown>> }
    searches?: Array<{ matches?: Array<Record<string, unknown>> }>
    channel_reads?: { channels?: Array<Record<string, unknown>> }
  }
): IntelItem[] {
  const candidates = sourceCandidates(retrieved)
  return items.map((item) => {
    if (item.permalink || (item.workspace_id && item.channel_id && item.ts)) {
      return withSlackMetadata(item)
    }
    const best = candidates
      .map((candidate) => ({
        candidate,
        score: overlapScore(item, candidate),
      }))
      .sort((a, b) => b.score - a.score)[0]
    if (!best || best.score < 35) return withSlackMetadata(item)
    return withSlackMetadata({
      ...item,
      workspace_id: best.candidate.workspace_id,
      channel_id: best.candidate.channel_id,
      ts: best.candidate.ts,
      permalink: best.candidate.permalink,
    })
  })
}

function fallbackIntelItems(retrieved: {
  priority_dms?: { conversations?: Array<Record<string, unknown>> }
  searches?: Array<{ matches?: Array<Record<string, unknown>> }>
  channel_reads?: { channels?: Array<Record<string, unknown>> }
}): IntelItem[] {
  const keyword =
    /(billable|payroll|deposit|signature|approval|warning|termination|overwhelmed|owner|storage|TrackHS|work order|zero task|time off|unresponsive|blocked|unacceptable|do this job|want this job|direct conversation|position|weak link)/i
  const candidates: Array<IntelItem & { score: number }> = []
  for (const channel of retrieved.channel_reads?.channels ?? []) {
    const messages = Array.isArray(channel.messages) ? channel.messages : []
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue
      const record = msg as Record<string, unknown>
      const text = cleanSlackText(String(record.text ?? ""))
      if (!keyword.test(text)) continue
      const score = fallbackScore(text, "search")
      if (score <= 30) continue
      const person = String(record.sender ?? "Slack")
      const guidance = fallbackGuidance(text, person)
        candidates.push({
        score,
        urgency: urgencyForScore(score) || guidance.urgency,
        workspace: String(channel.workspace ?? "Slack"),
        workspace_id: String(channel.workspace_id ?? ""),
        channel: String(channel.channel_name ?? channel.channel_id ?? "channel"),
        channel_id: String(channel.channel_id ?? ""),
        ts: String(record.ts ?? ""),
        permalink: typeof record.permalink === "string" ? record.permalink : undefined,
        sent_at: String(record.sent_at ?? ""),
        person,
        summary: fallbackBrief(text),
        why_now: guidance.why_now,
        evidence: text.slice(0, 260),
        action: guidance.action,
        reply: guidance.reply,
      })
    }
  }
  for (const conv of retrieved.priority_dms?.conversations ?? []) {
    const messages = Array.isArray(conv.messages) ? conv.messages : []
    const scored = messages
      .map((msg) => {
        const text =
          typeof msg === "object" && msg && "text" in msg
            ? cleanSlackText(String((msg as { text?: unknown }).text ?? ""))
            : ""
        return { msg, text, score: fallbackScore(text, "dm") }
      })
      .filter(({ text, score }) => keyword.test(text) && score > 30)
      .sort((a, b) => b.score - a.score)[0]
    if (!scored) continue
    const person = String(conv.person ?? "DM")
    const guidance = fallbackGuidance(scored.text, person)
    candidates.push({
      score: scored.score,
      urgency: urgencyForScore(scored.score) || guidance.urgency,
      workspace: String(conv.workspace ?? "Slack"),
      workspace_id: String(conv.workspace_id ?? ""),
      channel: "DM",
      channel_id: String(conv.channel_id ?? ""),
      ts: String((scored.msg as { ts?: unknown }).ts ?? ""),
      permalink:
        typeof (scored.msg as { permalink?: unknown }).permalink === "string"
          ? ((scored.msg as { permalink?: unknown }).permalink as string)
          : undefined,
      sent_at: String((scored.msg as { sent_at?: unknown }).sent_at ?? ""),
      person,
      summary: fallbackBrief(scored.text),
      why_now: guidance.why_now,
      evidence: scored.text.slice(0, 260),
      action: guidance.action,
      reply: guidance.reply,
    })
  }
  for (const search of retrieved.searches ?? []) {
    for (const match of search.matches ?? []) {
      const text = cleanSlackText(String(match.text ?? ""))
      if (!keyword.test(text)) continue
      const score = fallbackScore(text, "search")
      if (score <= 30) continue
      if (String(match.user ?? "").toLowerCase().includes("peter")) continue
      if (String(match.channel ?? "").toLowerCase().startsWith("all-team")) continue
      const person = String(match.user ?? "Slack")
      const guidance = fallbackGuidance(text, person)
      candidates.push({
        score,
        urgency: urgencyForScore(score) || guidance.urgency,
        workspace: String(match.workspace ?? "Slack"),
        workspace_id: String(match.workspace_id ?? ""),
        channel: String(match.channel ?? "DM/private"),
        channel_id: String(match.channel_id ?? ""),
        ts: String(match.ts ?? ""),
        permalink:
          typeof match.permalink === "string" ? match.permalink : undefined,
        sent_at: String(match.sent_at ?? ""),
        person,
        summary: fallbackBrief(text),
        why_now: guidance.why_now,
        evidence: text.slice(0, 260),
        action: guidance.action,
        reply: guidance.reply,
      })
    }
  }
  const seen = new Set<string>()
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      const topic =
        /payroll|payrun|overpaid/i.test(item.summary)
          ? "payroll"
          : /do this job|want this job|unacceptable|overwhelmed|position/i.test(
                item.summary
              )
            ? "role"
            : /billable|work order|Track/i.test(item.summary)
              ? "billables"
              : /deposit|signature|approval/i.test(item.summary)
                ? "approval"
                : item.summary.slice(0, 40)
      const key = `${item.workspace}:${item.person}:${topic}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 5)
    .map(({ score, ...item }) => {
      void score
      return item
    })
}

function accountByIdOrAll(ctx: AgentContext, accountId?: unknown) {
  if (typeof accountId === "string" && accountId.length > 0) {
    return ctx.accounts.filter((acct) => acct.id === accountId)
  }
  return ctx.accounts
}

async function slackSearchTool(
  ctx: AgentContext,
  input: Record<string, unknown>
) {
  const query = typeof input.query === "string" ? input.query : ""
  const count =
    typeof input.count === "number"
      ? Math.max(1, Math.min(20, Math.floor(input.count)))
      : 20
  if (!query.trim()) return { error: "query is required", matches: [] }

  const matches: Array<Record<string, unknown>> = []
  const searched: string[] = []
  for (const acct of accountByIdOrAll(ctx, input.account_id)) {
    const workspace = acct.workspace_name ?? acct.account_label ?? "Workspace"
    const workspaceId = acct.workspace_id ?? ""
    const names = new Map<string, string>()
    try {
      const tokens = await getSlackTokens(ctx.userId, acct.id)
      const qs = new URLSearchParams({
        query,
        count: String(count),
        sort: "timestamp",
        sort_dir: "desc",
      })
      const res = await slackApiFetch(
        tokens.access_token,
        `${SLACK_BASE}/search.messages?${qs}`,
        7000
      )
      const json = (await res.json()) as {
        ok: boolean
        error?: string
        messages?: { matches?: SlackSearchMatch[] }
      }
      searched.push(workspace)
      if (!json.ok) {
        ctx.metrics.warnings.push(`${workspace}: search.messages ${json.error}`)
        continue
      }
      const raw = json.messages?.matches ?? []
      const missing = Array.from(
        new Set(
          raw
            .map((m) => m.user)
            .filter((v): v is string => typeof v === "string")
        )
      )
      const resolved = await resolveSlackUsers(tokens.access_token, missing)
      for (const [id, name] of resolved) names.set(id, name)
      for (const m of raw) {
        ctx.metrics.messagesScanned += 1
        matches.push({
          workspace,
          workspace_id: workspaceId,
          channel_id: m.channel?.id ?? null,
          channel: m.channel?.name ?? "DM/private",
          user: m.user ? names.get(m.user) ?? m.username ?? m.user : m.username,
          ts: m.ts,
          sent_at: m.ts ? tsToReadable(m.ts) : null,
          text: cleanSlackText(m.text ?? ""),
          permalink: m.permalink ?? null,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "search failed"
      ctx.metrics.warnings.push(`${workspace}: ${message}`)
    }
  }
  return { searched, matches }
}

async function slackReadPriorityDmsTool(
  ctx: AgentContext,
  input: Record<string, unknown>
) {
  const people = Array.isArray(input.people)
    ? input.people.filter((v): v is string => typeof v === "string")
    : PRIORITY_DM_NAMES
  const maxDms =
    typeof input.max_dms === "number"
      ? Math.max(1, Math.min(20, Math.floor(input.max_dms)))
      : 12
  const limit =
    typeof input.limit === "number"
      ? Math.max(1, Math.min(30, Math.floor(input.limit)))
      : 16
  const oldest =
    typeof input.oldest === "string"
      ? Number(input.oldest)
      : (ctx.nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000
  const latest = typeof input.latest === "string" ? Number(input.latest) : null
  const conversations: Array<Record<string, unknown>> = []

  for (const acct of accountByIdOrAll(ctx, input.account_id)) {
    const workspace = acct.workspace_name ?? acct.account_label ?? "Workspace"
    const workspaceId = acct.workspace_id ?? ""
    const selfUserId =
      typeof acct.metadata?.slack_user_id === "string"
        ? acct.metadata.slack_user_id
        : null
    try {
      const tokens = await getSlackTokens(ctx.userId, acct.id)
      const imRes = await slackApiFetch(
        tokens.access_token,
        `${SLACK_BASE}/conversations.list?types=im&limit=200`,
        5000
      )
      const imJson = (await imRes.json()) as {
        ok: boolean
        error?: string
        channels?: SlackChannel[]
      }
      if (!imJson.ok) {
        ctx.metrics.warnings.push(`${workspace}: conversations.list ${imJson.error}`)
        continue
      }
      const candidates = (imJson.channels ?? [])
        .filter((c) => c.user && c.user !== selfUserId)
        .map((c) => ({ ...c, is_im: true, name: "DM" }))
        .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
        .slice(0, 80)
      const userNames = await resolveSlackUsers(
        tokens.access_token,
        candidates.map((c) => c.user).filter((v): v is string => typeof v === "string")
      )
      const priorityNames = people.map((name) => name.toLowerCase())
      const dms = candidates
        .sort((a, b) => {
          const aName = (a.user ? userNames.get(a.user) : "")?.toLowerCase() ?? ""
          const bName = (b.user ? userNames.get(b.user) : "")?.toLowerCase() ?? ""
          const aPriority = priorityNames.some((name) => aName.includes(name))
            ? 1
            : 0
          const bPriority = priorityNames.some((name) => bName.includes(name))
            ? 1
            : 0
          return bPriority - aPriority || (b.updated ?? 0) - (a.updated ?? 0)
        })
        .slice(0, maxDms)

      for (const dm of dms) {
        const qs = new URLSearchParams({
          channel: dm.id,
          limit: String(limit),
          oldest: String(oldest),
        })
        if (typeof latest === "number" && Number.isFinite(latest)) {
          qs.set("latest", String(latest))
        }
        const res = await slackApiFetch(
          tokens.access_token,
          `${SLACK_BASE}/conversations.history?${qs}`,
          7000
        )
        if (res.status === 429) {
          ctx.metrics.warnings.push(
            `${workspace}: Slack rate limited DM reads; scan a narrower date/workspace if this misses expected items`
          )
          break
        }
        if (!res.ok) {
          ctx.metrics.warnings.push(`${workspace}: ${dm.name} HTTP ${res.status}`)
          continue
        }
        const hist = (await res.json()) as {
          ok: boolean
          error?: string
          messages?: SlackMessage[]
        }
        if (!hist.ok) {
          ctx.metrics.warnings.push(`${workspace}: DM ${hist.error}`)
          continue
        }
        const messages = hist.messages ?? []
        if (messages.length === 0) continue
        ctx.metrics.channelsScanned += 1
        ctx.metrics.messagesScanned += messages.length
        const person = dm.user ? userNames.get(dm.user) ?? dm.user : "Unknown"
        conversations.push({
          workspace,
          workspace_id: workspaceId,
          channel_id: dm.id,
          person,
          latest_ts: messages[0]?.ts ?? null,
          messages: messages
            .map((m) => ({
              sender:
                m.user && m.user === selfUserId
                  ? "Peter"
                  : m.user
                    ? userNames.get(m.user) ?? m.user
                    : "Unknown",
              sent_at: tsToReadable(m.ts),
              ts: m.ts,
              text: cleanSlackText(m.text ?? ""),
            }))
            .reverse(),
        })
        await sleep(HISTORY_DELAY_MS)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "DM read failed"
      ctx.metrics.warnings.push(`${workspace}: ${message}`)
    }
  }
  return { conversations }
}

async function slackReadChannelTool(
  ctx: AgentContext,
  input: Record<string, unknown>
) {
  const channelId = typeof input.channel_id === "string" ? input.channel_id : ""
  if (!channelId) return { error: "channel_id is required", messages: [] }
  const limit =
    typeof input.limit === "number"
      ? Math.max(1, Math.min(100, Math.floor(input.limit)))
      : 30
  const oldest =
    typeof input.oldest === "string"
      ? input.oldest
      : String((ctx.nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000)
  const latest = typeof input.latest === "string" ? input.latest : null

  const outputs: Array<Record<string, unknown>> = []
  for (const acct of accountByIdOrAll(ctx, input.account_id)) {
    const workspace = acct.workspace_name ?? acct.account_label ?? "Workspace"
    const workspaceId = acct.workspace_id ?? ""
    const selfUserId =
      typeof acct.metadata?.slack_user_id === "string"
        ? acct.metadata.slack_user_id
        : null
    try {
      const tokens = await getSlackTokens(ctx.userId, acct.id)
      const qs = new URLSearchParams({
        channel: channelId,
        limit: String(limit),
        oldest,
      })
      if (latest) qs.set("latest", latest)
      const res = await slackApiFetch(
        tokens.access_token,
        `${SLACK_BASE}/conversations.history?${qs}`,
        7000
      )
      if (!res.ok) {
        outputs.push({ workspace, error: `Slack HTTP ${res.status}` })
        continue
      }
      const json = (await res.json()) as {
        ok: boolean
        error?: string
        messages?: SlackMessage[]
      }
      if (!json.ok) {
        outputs.push({ workspace, error: json.error ?? "Slack error" })
        continue
      }
      const userIds = Array.from(
        new Set(
          (json.messages ?? [])
            .map((m) => m.user)
            .filter((v): v is string => typeof v === "string")
        )
      )
      const names = await resolveSlackUsers(tokens.access_token, userIds)
      const messages = (json.messages ?? []).map((m) => ({
        sender:
          m.user && m.user === selfUserId
            ? "Peter"
            : m.user
              ? names.get(m.user) ?? m.user
              : "Unknown",
        sent_at: tsToReadable(m.ts),
        ts: m.ts,
        text: cleanSlackText(m.text ?? ""),
      }))
      ctx.metrics.channelsScanned += 1
      ctx.metrics.messagesScanned += messages.length
        outputs.push({
          workspace,
          workspace_id: workspaceId,
          channel_id: channelId,
          channel_name:
            typeof input.channel_name === "string" ? input.channel_name : null,
          messages,
        })
    } catch (err) {
      outputs.push({
        workspace,
        error: err instanceof Error ? err.message : "read failed",
      })
    }
  }
  return { channels: outputs }
}

async function runDooAgent(
  anthropic: Anthropic,
  ctx: AgentContext
): Promise<{
  items: IntelItem[]
  workspacesScanned: number
  channelsScanned: number
  messagesScanned: number
  warnings: string[]
  scannedAt: string
}> {
  const { afterDate, beforeDate, oldest, latest, label: windowLabel } =
    buildScanWindow(ctx)
  const now = new Date(ctx.nowMs).toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  const workspaceList = ctx.accounts
    .map((acct) => `${acct.workspace_name ?? acct.account_label}: ${acct.id}`)
    .join("\n")
  const system = `You are ODIN, briefing Peter Karl Gumapac as Director of Operations.

Peter runs Stay Minty (glamping domes, cabins, Nashville) and Dinbnb (Airbnb/Vrbo).
His Slack display name is "Peter Karl Gumapac".

YOUR JOB: be Peter's director-of-operations DM auditor. Surface only items that need Peter personally as DOO, and make each action immediately usable.

Connected Slack workspaces:
${workspaceList}

Search window: ${windowLabel} Manila dates (Slack search after:${afterDate} before:${beforeDate}). Current time: ${now} Manila.

INCLUDE — Peter must personally act:
1. Someone @mentioned Peter by name in a message
2. A direct message (DM) was sent to Peter
3. A direct report or owner escalates performance, accountability, approvals, billables, missing documentation, or role expectations
4. A safety issue (fire, flooding, injury, dangerous condition)
5. A critical recurring issue the team has failed to resolve
6. A blocker where Peter must approve, decide, confirm ownership, or coordinate with Meredith/owner

EXCLUDE EVERYTHING ELSE:
- Bookings, reservations, check-ins, reviews, announcements, FYIs
- Maintenance tasks already assigned to someone
- General operations chatter
- Peter's own messages unless someone else responded afterward and still needs him
- Items already fully resolved

QUALITY BAR:
- Do not merely say "review links", "open thread", or "respond as needed".
- Cluster repeated DMs from the same person into one item when they are about the same issue.
- Sort by urgency: role/accountability escalation, same-day deadlines, owner/vendor blockers, guest/safety risk, then quick replies.
- If a DM has only links or unclear context, say what is unclear and tell Peter exactly what clarification to ask for.
- If the sender already gave a concrete request, draft the exact short reply Peter should send.
- The action must name the person and the operational decision/question.
- The summary must explain why Peter owns this instead of the team.
- The evidence must be a short excerpt or paraphrase from the Slack line, not generic.
- Use STR/operator language: billables, work orders, owner approval, deposits, signatures, vendor blockers, weekly cadence, written warning, termination, storage ownership.
- If Peter has already committed to an action, make the action about delivering the commitment by the deadline, not replying again.

STRICT LIMIT: Return at most 5 items. If fewer than 5 qualify, return fewer. Quality over quantity.
If nothing meets the criteria, return [].

Return ONLY a JSON array. No markdown. Each object has:
urgency, workspace, channel, sent_at, person, summary, why_now, evidence, action, reply.
If source metadata is visible, also include workspace_id, channel_id, ts, permalink.`

  const priorityDms: { conversations?: Array<Record<string, unknown>> } = {
    conversations: [],
  }
  let channelReads: { channels?: Array<Record<string, unknown>> } = {
    channels: [],
  }
  if (ctx.filters.channelId) {
    try {
      channelReads = await withTimeout(
        slackReadChannelTool(ctx, {
          account_id: ctx.filters.accountId,
          channel_id: ctx.filters.channelId,
          channel_name: ctx.filters.channelName,
          limit: 80,
          oldest,
          latest,
        }),
        12000,
        "selected channel read"
      )
    } catch (err) {
      ctx.metrics.warnings.push(
        err instanceof Error ? err.message : "selected channel read timed out"
      )
    }
  } else {
    for (const acct of ctx.accounts) {
      try {
        const result = await withTimeout(
          slackReadPriorityDmsTool(ctx, {
            account_id: acct.id,
            people: [
              "meredith",
              "kelli",
              "shiela",
              "reveen",
              "kim",
              "zain",
              "eric",
              "jonas",
              "emil",
            ],
            max_dms: 8,
            limit: 14,
            oldest,
            latest,
          }),
          10000,
          `${acct.workspace_name ?? acct.account_label ?? "Workspace"} priority DM read`
        )
        priorityDms.conversations?.push(...(result.conversations ?? []))
      } catch (err) {
        ctx.metrics.warnings.push(
          err instanceof Error ? err.message : "DM read timed out"
        )
      }
    }
  }

  let searches: Array<{ matches?: Array<Record<string, unknown>> }> = []
  if (!ctx.filters.channelId) {
    try {
      searches = await withTimeout(
        Promise.all(
          [
            "billables",
            "billable",
            "payroll",
            "approval",
            "warning",
            "written warning",
            "performance",
            "unacceptable",
            "do this job",
            "want this job",
            "direct conversation",
            "overwhelmed",
            "deposit",
            "signature",
            "storage",
            "TrackHS",
            "termination",
          ].map((term) =>
            slackSearchTool(ctx, {
              query: `${term} after:${afterDate} before:${beforeDate}`,
              account_id: ctx.filters.accountId,
              count: 8,
            })
          )
        ),
        12000,
        "Slack search"
      )
    } catch (err) {
      ctx.metrics.warnings.push(
        err instanceof Error ? err.message : "Slack search timed out"
      )
    }
  }

  const retrievedPayload = {
    priority_dms: priorityDms,
    searches,
    channel_reads: channelReads,
  }
  let items: IntelItem[] = []
  let refinementWarning: string | null = null
  try {
    const retrieved = formatEvidenceForClaude(retrievedPayload)
    const retrievedForClaude = retrieved.slice(0, 12000)
    const message = await withTimeout(
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        temperature: 0.1,
        system,
        messages: [
          {
            role: "user",
            content: `Review the Slack messages below. Apply the DOO filter strictly — only what Peter must personally handle.

Return ONLY a JSON array. No markdown, no explanation. Start [ end ].

Each item:
- "urgency" (critical/high/medium/low)
- "workspace"
- "channel" (no #, or "DM")
- "sent_at"
- "person" (the DM sender or main owner)
- "summary" (what happened and why Peter owns it — 1 sentence)
- "why_now" (deadline, escalation, blocker, or consequence)
- "evidence" (short Slack evidence)
- "action" (exactly what Peter does — name the person, be direct)
- "reply" (optional ready-to-send message if the next action is a Slack reply)
- "workspace_id", "channel_id", "ts", "permalink" if available
- "source" must be "slack"
- "business" must be "Stay Minty", "Dinbnb", "Personal", or "Unassigned"

Max 5 items. If nothing qualifies, return [].

${retrievedForClaude}`,
          },
        ],
      }),
      35000,
      "Claude assessment"
    )
    items = parseIntelItems(textFromMessage(message as never))
    if (items.length === 0) {
      refinementWarning = "Claude returned no qualifying DOO items"
    }
  } catch {
    refinementWarning = "AI refinement timed out; showing rule-ranked Slack findings instead"
  }
  if (items.length === 0) {
    items = fallbackIntelItems(retrievedPayload)
    if (items.length === 0 && refinementWarning) {
      ctx.metrics.warnings.push(refinementWarning)
    }
  }
  items = attachSourceLinks(items, retrievedPayload)

  return {
    items,
    workspacesScanned: ctx.metrics.workspacesScanned,
    channelsScanned: ctx.metrics.channelsScanned,
    messagesScanned: ctx.metrics.messagesScanned,
    warnings: ctx.metrics.warnings,
    scannedAt: new Date().toISOString(),
  }
}

async function resolveSlackIntelUserId(req: Request): Promise<string | null> {
  const jwtUserId = await getCallerUserId(req).catch(() => null)
  if (jwtUserId) return jwtUserId

  // Voice-origin scans reach this function through odin-orchestrator with an
  // ElevenLabs bearer token, not a Supabase JWT. Accept only the shared
  // internal secret and resolve to ODIN's configured single-user account.
  // @ts-expect-error Deno env
  const expected =
    Deno.env.get("ODIN_INTERNAL_FUNCTION_SECRET") ??
    Deno.env.get("ELEVENLABS_CUSTOM_LLM_SECRET") ??
    Deno.env.get("ELEVENLABS_WEBHOOK_SECRET") ??
    Deno.env.get("ELEVENLABS_API_KEY") ??
    ""
  const supplied = req.headers.get("x-odin-internal-secret") ?? ""
  if (!expected || supplied.trim() !== expected) return null

  // @ts-expect-error Deno env
  const defaultUserId = Deno.env.get("ODIN_DEFAULT_USER_ID") || PETER_USER_ID
  const requestedUserId = req.headers.get("x-odin-user-id") ?? ""
  if (requestedUserId && requestedUserId !== defaultUserId) return null
  return defaultUserId
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflight()
  if (req.method !== "POST")
    return jsonResponse({ error: "Method not allowed" }, 405)

  const userId = await resolveSlackIntelUserId(req)
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401)

  // @ts-expect-error Deno env
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
  if (!apiKey)
    return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 500)

  const anthropic = new Anthropic({ apiKey })
  const nowMs = Date.now()
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const filters: ScanFilters = {
      accountId:
        typeof body.accountId === "string" && body.accountId.length > 0
          ? body.accountId
          : undefined,
      channelId:
        typeof body.channelId === "string" && body.channelId.length > 0
          ? body.channelId
          : undefined,
      channelName:
        typeof body.channelName === "string" && body.channelName.length > 0
          ? body.channelName
          : undefined,
      dateFrom: isYmd(body.dateFrom) ? body.dateFrom : undefined,
      dateTo: isYmd(body.dateTo) ? body.dateTo : undefined,
    }
    const accounts = await listProviderAccounts(userId, "slack")
    if (accounts.length === 0) {
      return jsonResponse({
        data: {
          items: [],
          workspacesScanned: 0,
          channelsScanned: 0,
          messagesScanned: 0,
          scannedAt: new Date().toISOString(),
        },
      })
    }
    const scopedAccounts = filters.accountId
      ? accounts.filter((acct) => acct.id === filters.accountId)
      : accounts
    if (scopedAccounts.length === 0) {
      return jsonResponse({ error: "Selected Slack workspace is not connected" }, 400)
    }

    const agentResult = await runDooAgent(anthropic, {
      userId,
      accounts: scopedAccounts,
      nowMs,
      metrics: {
        workspacesScanned: scopedAccounts.length,
        channelsScanned: 0,
        messagesScanned: 0,
        warnings: [],
      },
      filters,
    })
    return jsonResponse({ data: agentResult })

    const now = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Manila",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })

    let totalChannels = 0
    let totalMessages = 0
    const workspaceBlocks: string[] = []
    const scanWarnings: string[] = []
    const afterDate = ymdInManila(nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    const beforeDate = ymdInManila(nowMs + 24 * 60 * 60 * 1000)

    for (const acct of accounts) {
      const workspaceName =
        acct.workspace_name ?? acct.account_label ?? "Workspace"
      const selfUserId =
        typeof acct.metadata?.slack_user_id === "string"
          ? acct.metadata.slack_user_id
          : null

      let token: string
      try {
        const tokens = await getSlackTokens(userId, acct.id)
        token = tokens.access_token
      } catch {
        continue
      }

      let channels: SlackChannel[] = []
      let dms: SlackChannel[] = []
      let userNames = new Map<string, string>()
      const searchBlocks: string[] = []
      try {
        const qs = new URLSearchParams({
          types: "public_channel,private_channel",
          exclude_archived: "true",
          limit: "200",
        })
        const res = await slackApiFetch(
          token,
          `${SLACK_BASE}/conversations.list?${qs}`,
          5000
        )
        const json = (await res.json()) as {
          ok: boolean
          channels?: SlackChannel[]
        }
        channels = (json.channels ?? [])
          .filter((c) => c.is_member !== false)
          .sort((a, b) => (b.unread_count ?? 0) - (a.unread_count ?? 0))
          .slice(0, MAX_STANDARD_CHANNELS)
      } catch {
        channels = []
      }

      try {
        const imRes = await slackApiFetch(
          token,
          `${SLACK_BASE}/conversations.list?types=im&limit=200`,
          4000
        )
        const imJson = (await imRes.json()) as {
          ok: boolean
          channels?: SlackChannel[]
        }
        dms = (imJson.channels ?? [])
          .filter((c) => c.user && c.user !== selfUserId)
          .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
          .map((c) => ({ ...c, is_im: true, name: "DM" }))
        userNames = await resolveSlackUsers(
          token,
          [
            selfUserId,
            ...dms.map((c) => c.user),
          ].filter((v): v is string => typeof v === "string")
        )
        dms = dms
          .sort((a, b) => {
            const aName = (a.user ? userNames.get(a.user) : "")?.toLowerCase() ?? ""
            const bName = (b.user ? userNames.get(b.user) : "")?.toLowerCase() ?? ""
            const aPriority = PRIORITY_DM_NAMES.some((name) =>
              aName.includes(name)
            )
              ? 1
              : 0
            const bPriority = PRIORITY_DM_NAMES.some((name) =>
              bName.includes(name)
            )
              ? 1
              : 0
            return bPriority - aPriority || (b.updated ?? 0) - (a.updated ?? 0)
          })
          .slice(0, MAX_DMS)
      } catch {
        /* DMs optional */
      }

      for (const term of DOO_SEARCH_TERMS) {
        const result = await searchSlackMessages(
          token,
          `"${term}" after:${afterDate} before:${beforeDate}`,
          userNames
        )
        if (result.block) searchBlocks.push(result.block)
        totalMessages += result.count
        if (result.warning) {
          scanWarnings.push(`${workspaceName}: ${result.warning}`)
          if (result.warning.includes("missing_scope")) break
        }
        await sleep(250)
      }

      const scanTargets = [...dms, ...channels]
      totalChannels += scanTargets.length
      const contextBlocks: Array<{ block: string; latestTs: number }> = []
      const warnings: string[] = []
      let consecutiveRateLimits = 0

      for (const ch of scanTargets) {
        const result = await fetchChannelHistory(
          token,
          ch,
          oldestTs,
          userNames,
          selfUserId
        )
        if (result.warning?.includes("Slack HTTP 429")) {
          consecutiveRateLimits += 1
          if (consecutiveRateLimits >= 2) {
            warnings.push("Slack rate limit reached; retry ODIN SCAN in 60 seconds")
            break
          }
        } else {
          consecutiveRateLimits = 0
        }
        if (result.block) {
          contextBlocks.push({
            block: result.block,
            latestTs: result.latestTs,
          })
        }
        totalMessages += result.count
        if (result.warning) warnings.push(result.warning)
        await sleep(HISTORY_DELAY_MS)
      }

      if (contextBlocks.length === 0 && searchBlocks.length === 0) {
        scanWarnings.push(...warnings.map((w) => `${workspaceName}: ${w}`))
        continue
      }
      scanWarnings.push(...warnings.map((w) => `${workspaceName}: ${w}`))
      const contextLines = contextBlocks
        .sort((a, b) => b.latestTs - a.latestTs)
        .map((b) => b.block)
      workspaceBlocks.push(
        `## Workspace: ${workspaceName}\n\n` +
          [...searchBlocks, ...contextLines].join("\n\n")
      )
    }

    if (workspaceBlocks.length === 0) {
      return jsonResponse({
        data: {
          items: [],
          workspacesScanned: accounts.length,
          channelsScanned: totalChannels,
          messagesScanned: totalMessages,
          warnings: scanWarnings,
          scannedAt: new Date().toISOString(),
        },
      })
    }

    const slackDump = workspaceBlocks.join("\n\n---\n\n")

    const systemPrompt = `You are ODIN, briefing Peter Karl Gumapac as Director of Operations.

Peter runs Stay Minty (glamping domes, cabins, Nashville) and Dinbnb (Airbnb/Vrbo).
His Slack display name is "Peter Karl Gumapac".

YOUR JOB: be Peter's director-of-operations DM auditor. Surface only items that need Peter personally as DOO, and make each action immediately usable.

INCLUDE — Peter must personally act:
1. Someone @mentioned Peter by name in a message
2. A direct message (DM) was sent to Peter
3. A direct report or owner escalates performance, accountability, approvals, billables, missing documentation, or role expectations
4. A safety issue (fire, flooding, injury, dangerous condition)
5. A critical recurring issue the team has failed to resolve (same problem reported multiple times)
6. A blocker where Peter must approve, decide, confirm ownership, or coordinate with Meredith/owner

EXCLUDE EVERYTHING ELSE — including:
- Bookings, reservations, check-ins (team owns this)
- Maintenance tasks that are already assigned to someone
- 5-star reviews, announcements, FYIs
- Issues posted once with no follow-up (team will handle)
- General operations chatter
- Lock codes, prep assignments, cleaning schedules
- Peter's own messages unless someone else responded afterward and still needs him

QUALITY BAR:
- Do not merely say "review links" or "respond as needed".
- Cluster repeated DMs from the same person into one item when they are about the same issue.
- Sort by urgency: role/accountability escalation, same-day deadlines, owner/vendor blockers, guest/safety risk, then quick replies.
- If a DM has only links or unclear context, say what is unclear and tell Peter exactly what clarification to ask for.
- If the sender already gave a concrete request, draft the exact short reply Peter should send.
- Treat Peter's own messages as context only; do not create action items from something Peter already said unless someone else later needs him.
- Prefer fewer, sharper items over filling the list.
- The action must name the person and the operational decision/question.
- The summary must explain why Peter owns this instead of the team.
- The evidence must be a short excerpt or paraphrase from the Slack line, not generic.
- Use STR/operator language: billables, work orders, owner approval, deposits, signatures, vendor blockers, weekly cadence, written warning, termination, storage ownership.
- If Peter has already committed to an action, make the action about delivering the commitment by the deadline, not replying again.

STRICT LIMIT: Return at most 5 items. If fewer than 5 qualify, return fewer. Quality over quantity.
If nothing meets the criteria, return [].

ACTION field: One sentence. Who Peter calls/texts/replies to, and what he says or decides. Be specific about the person's name. Never vague.
REPLY field: Optional. Include when Peter should send a Slack reply. Make it ready to send, under 45 words.

Current time: ${now} (Manila). Scanning last ${LOOKBACK_DAYS} days only.`

    const userPrompt = `Review the Slack messages below. Apply the DOO filter strictly — only what Peter must personally handle.

Return ONLY a JSON array. No markdown, no explanation. Start [ end ].

Each item:
- "urgency" (critical/high/medium/low)
- "workspace"
- "channel" (no #, or "DM")
- "sent_at"
- "person" (the DM sender or main owner)
- "summary" (what happened and why Peter owns it — 1 sentence)
- "why_now" (deadline, escalation, blocker, or consequence)
- "evidence" (short Slack evidence)
- "action" (exactly what Peter does — name the person, be direct)
- "reply" (optional ready-to-send message if the next action is a Slack reply)
- "source" must be "slack"
- "business" must be "Stay Minty", "Dinbnb", "Personal", or "Unassigned"

Max 5 items. If nothing qualifies, return [].

${slackDump}`

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      temperature: 0.1,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    })

    const rawText = message.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("")
      .trim()

    const jsonText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()

    let items: IntelItem[] = []
    try {
      const parsed = JSON.parse(jsonText)
      if (Array.isArray(parsed)) items = parsed as IntelItem[]
    } catch {
      const match = jsonText.match(/\[[\s\S]*\]/)
      if (match) {
        try {
          const parsed = JSON.parse(match[0])
          if (Array.isArray(parsed)) items = parsed as IntelItem[]
        } catch {
          items = []
        }
      }
    }

    items = items.map(withSlackMetadata)

    return jsonResponse({
      data: {
        items,
        workspacesScanned: accounts.length,
        channelsScanned: totalChannels,
        messagesScanned: totalMessages,
        warnings: scanWarnings,
        scannedAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    console.error("[slack-intel]", msg)
    return jsonResponse({ error: msg }, 502)
  }
})

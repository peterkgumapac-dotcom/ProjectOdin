import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  RefreshCw,
  Mail,
  MessageSquare,
  Zap,
  CheckCircle2,
  ExternalLink,
  Plus,
  SlidersHorizontal,
} from "lucide-react"
import { LightPageShell } from "@/components/dashboard/LightPageChrome"
import { useAuth } from "@/hooks/useAuth"
import { useSlackMessages } from "@/hooks/useSlackMessages"
import {
  useSlackIntel,
  type IntelItem,
} from "@/hooks/useSlackIntel"
import { useOdinResponsibility } from "@/hooks/useOdinResponsibility"
import {
  useConnectedAccounts,
  type ConnectedAccount,
} from "@/hooks/useConnectedAccounts"
import { listSlackChannels, type SlackChannel } from "@/lib/connectors/slack"
import { useAgentJobs } from "@/hooks/useAgentJobs"
import { invokeOdinCommand } from "@/lib/odinOrchestrator"
import {
  businessFromText,
  businessMatches,
  normalizeBusiness,
  type ClassifiedBusiness,
} from "@/lib/businessClassifier"
import {
  listLatestSourceBriefs,
  type SourceBrief,
  type SourceBriefItem,
} from "@/lib/sourceBriefs"
import {
  agentBriefLabel,
  formatAgentBriefAge,
  hasAgentBriefAfter,
  isAgentPendingItem,
  pendingItemBusiness,
  pendingItemSourceAgent,
  summarizeAgentFreshness,
  type OdinPendingItem,
} from "@/lib/odinResponsibility"
import { queueStayMintyLiveSyncRequest } from "@/lib/agentBriefRequests"
import {
  isLiveScanSourceEnabled,
  publishLiveScanRefreshSignal,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

function cleanScanText(value: string): string {
  return value
    .replace(/^Slack search found an Ops-relevant item:\s*/i, "")
    .replace(/^Slack search found a DOO-relevant item:\s*/i, "")
    .replace(/\bClaude-style MCP scan\b/gi, "agent scan")
    .replace(/\bClaude\/Codex\b/gi, "agent")
    .replace(/\bClaude\b/gi, "agent")
    .replace(/\bCodex\b/gi, "agent")
    .replace(/\s+/g, " ")
    .trim()
}

function channelLabel(channel: string): string {
  const normalized = channel.toLowerCase()
  if (
    normalized === "dm" ||
    normalized.startsWith("u") ||
    normalized.startsWith("d") ||
    normalized.includes("mpdm")
  ) {
    return "DM"
  }
  return channel.startsWith("#") ? channel : `#${channel}`
}

function scanTitle(item: { person?: string; channel: string }): string {
  return item.person ? `${item.person} DM` : channelLabel(item.channel)
}

function handledKey(item: IntelItem): string {
  return [
    item.source ?? "slack",
    resolvedItemBusiness(item),
    item.sourceUrl ?? item.permalink ?? "",
    item.workspaceId ?? item.workspace_id ?? "",
    item.workspace,
    item.channel,
    item.person ?? "",
    item.sent_at,
    item.summary,
    item.action,
  ]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 700)
}

function slackSourceUrl(item: IntelItem): string | null {
  if (item.permalink) return item.permalink
  if (!item.workspace_id || !item.channel_id || !item.ts) return null
  const params = new URLSearchParams({
    team: item.workspace_id,
    id: item.channel_id,
    message: item.ts,
  })
  return `slack://channel?${params.toString()}`
}

function daysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

const COUNCIL_AGENT_BRIEF_WAIT_MS = 12_000
const COUNCIL_AGENT_BRIEF_POLL_MS = 1_500

type CouncilAgentScanState = {
  state: "idle" | "requesting" | "fresh" | "stale" | "error"
  message: string
  startedAt: string | null
  latestAt: string | null
}

type CouncilDisplayItem = IntelItem & {
  pendingId?: string
  pendingTitle?: string
  pendingStatus?: string
  sourceAgent?: string | null
  pendingBusiness?: string | null
  sourceAccountId?: string | null
  sourceLabel?: string
  lastSeenAt?: string | null
}

type CouncilSourceKind = NonNullable<IntelItem["source"]>

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function pendingRank(item: OdinPendingItem): number {
  const urgencyRank = { critical: 4, high: 3, medium: 2, low: 1 }[item.urgency]
  const bucketRank =
    item.bucket === "needs_peter"
      ? 4
      : item.bucket === "today"
        ? 3
        : item.bucket === "waiting_on_others"
          ? 2
          : 1
  return urgencyRank * 100 + bucketRank * 10 + new Date(item.last_seen_at || item.updated_at).getTime() / 1_000_000_000_000
}

function sourceAccountIdFromPendingItem(item: OdinPendingItem): string | null {
  const rawPayloadId =
    typeof item.payload?.rawSignalId === "string" ? item.payload.rawSignalId : ""
  const explicit =
    typeof item.payload?.accountId === "string"
      ? item.payload.accountId
      : typeof item.payload?.account_id === "string"
        ? item.payload.account_id
        : typeof item.payload?.connectedAccountId === "string"
          ? item.payload.connectedAccountId
          : null
  if (explicit) return explicit
  const match = rawPayloadId.match(/^gmail-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i)
  return match?.[1] ?? null
}

function pendingItemToCouncilItem(
  item: OdinPendingItem,
  accountBusinessById: Map<string, ClassifiedBusiness> = new Map()
): CouncilDisplayItem {
  const sourceAgent = pendingItemSourceAgent(item)
  const sourceName = item.source === "slack" ? "Slack" : item.source === "gmail" ? "Gmail" : item.source
  const agentName = agentBriefLabel(sourceAgent)
  const seenAt = item.last_seen_at || item.updated_at
  const sourceAccountId = sourceAccountIdFromPendingItem(item)
  const sourceAccountBusiness = sourceAccountId ? accountBusinessById.get(sourceAccountId) : undefined
  const agentBusiness = pendingItemBusiness(item)
  const explicitBusiness = normalizeBusiness(item.business)
  const business =
    agentBusiness && agentBusiness !== "Unassigned"
      ? agentBusiness
      : item.source === "gmail" &&
    sourceAccountBusiness &&
    sourceAccountBusiness !== "Unassigned"
      ? sourceAccountBusiness
      : explicitBusiness === "Unassigned" || (item.source === "gmail" && explicitBusiness === "Personal")
        ? businessFromText(
            `${item.title} ${item.summary} ${item.evidence_label ?? ""} ${item.person ?? ""}`
          )
        : explicitBusiness
  return {
    pendingId: item.id,
    pendingTitle: item.title,
    pendingStatus: item.status,
    sourceAgent,
    pendingBusiness: item.business,
    sourceAccountId,
    source: item.source as CouncilSourceKind,
    business,
    sourceUrl: item.evidence_url ?? undefined,
    sourceLabel: sourceName,
    lastSeenAt: seenAt,
    urgency: item.urgency,
    workspace: business === "Unassigned" ? agentName : business,
    workspaceName: business === "Unassigned" ? undefined : business,
    channel: sourceName,
    permalink: item.source === "slack" ? item.evidence_url ?? undefined : undefined,
    sent_at: seenAt
      ? new Date(seenAt).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "agent brief",
    summary: item.summary,
    action: item.next_action ?? item.summary,
    evidence: item.evidence_label ?? undefined,
    reply: item.suggested_reply ?? undefined,
    person: item.person ?? undefined,
    why_now: `${agentName} brief${item.business ? ` · ${item.business}` : ""}`,
  }
}

function openActionLabel(item: CouncilDisplayItem): string {
  if (item.source === "gmail" || item.sourceLabel?.toLowerCase() === "gmail") return "Open in Gmail"
  if (item.sourceLabel?.toLowerCase() === "slack") return "Open in Slack"
  return "Open source"
}

function activeBusinessForAccount(account: ConnectedAccount | null): ClassifiedBusiness {
  if (!account) return "Unassigned"
  const explicit = normalizeBusiness(account.metadata?.business)
  if (explicit !== "Unassigned") return explicit
  return businessFromText(
    [
      account.workspaceName,
      account.accountLabel,
      account.accountEmail,
      JSON.stringify(account.metadata ?? {}),
    ]
      .filter(Boolean)
      .join(" ")
  )
}

function resolvedItemBusiness(item: CouncilDisplayItem): ClassifiedBusiness {
  const explicit = normalizeBusiness(item.business ?? item.pendingBusiness)
  if (explicit !== "Unassigned") return explicit
  return businessFromText(
    [
      item.workspaceName,
      item.workspace,
      item.channel,
      item.person,
      item.summary,
      item.action,
      item.evidence,
    ]
      .filter(Boolean)
      .join(" ")
  )
}

function itemSourceUrl(item: CouncilDisplayItem): string | null {
  if (item.sourceUrl) return item.sourceUrl
  if (item.source === "slack" || item.sourceLabel?.toLowerCase() === "slack") {
    return slackSourceUrl(item)
  }
  return item.permalink ?? null
}

function briefAge(value: string | null | undefined): string {
  if (!value) return "missing"
  const ts = new Date(value).getTime()
  if (!Number.isFinite(ts)) return "unknown age"
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (minutes < 2) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function briefMatchesBusiness(brief: SourceBrief, activeBusiness: ClassifiedBusiness): boolean {
  return businessMatches(normalizeBusiness(brief.business), activeBusiness)
}

function briefItemRank(item: SourceBriefItem): number {
  const urgencyRank = { critical: 4, high: 3, medium: 2, low: 1 }[item.urgency]
  const bucketRank =
    item.bucket === "needs_peter"
      ? 4
      : item.bucket === "today"
        ? 3
        : item.bucket === "waiting_on_others"
          ? 2
          : 1
  const statusRank = item.status === "open" || item.status === "waiting" ? 2 : 1
  return urgencyRank * 100 + bucketRank * 10 + statusRank
}

function briefItemsForGroup(
  items: SourceBriefItem[],
  group: "now" | "followups" | "noise"
): SourceBriefItem[] {
  return items
    .filter((item) => {
      if (group === "noise") {
        return item.status === "handled" || item.status === "deferred" || item.bucket === "done_recently"
      }
      if (item.status !== "open" && item.status !== "waiting") return false
      if (group === "now") return item.bucket === "needs_peter"
      return item.bucket === "today" || item.bucket === "waiting_on_others"
    })
    .sort((a, b) => briefItemRank(b) - briefItemRank(a))
}

function councilItemRank(item: CouncilDisplayItem): number {
  const urgencyRank = { critical: 4, high: 3, medium: 2, low: 1 }[item.urgency] ?? 1
  const sourceRank = item.sourceAgent ? 30 : item.source === "gmail" ? 20 : 10
  const time = item.lastSeenAt ? new Date(item.lastSeenAt).getTime() : 0
  const freshness = Number.isFinite(time) ? time / 1_000_000_000_000 : 0
  return urgencyRank * 100 + sourceRank + freshness
}

function mergeCouncilItems(items: CouncilDisplayItem[]): CouncilDisplayItem[] {
  const byKey = new Map<string, CouncilDisplayItem>()
  for (const item of items) {
    const key = [
      item.source,
      item.sourceUrl ?? item.permalink ?? "",
      item.pendingId ?? "",
      item.pendingTitle ?? "",
      item.person ?? "",
    ].join("|")
    const existing = byKey.get(key)
    if (!existing || councilItemRank(item) > councilItemRank(existing)) {
      byKey.set(key, item)
    }
  }
  return [...byKey.values()].sort((a, b) => councilItemRank(b) - councilItemRank(a))
}

function itemMatchesActiveWorkspace(
  item: CouncilDisplayItem,
  account: ConnectedAccount | null,
  activeBusiness: ClassifiedBusiness
) {
  if (!account) return false
  const itemWorkspaceId = item.workspaceId ?? item.workspace_id
  if (itemWorkspaceId && account.workspaceId && itemWorkspaceId === account.workspaceId) {
    return true
  }
  if (itemWorkspaceId && itemWorkspaceId === account.id) return true

  const source = item.source ?? "slack"
  if (source !== "slack") {
    return businessMatches(resolvedItemBusiness(item), activeBusiness)
  }

  const itemWorkspaceText = [item.workspaceName, item.workspace].filter(Boolean).join(" ")
  const accountText = [account.workspaceName, account.accountLabel].filter(Boolean).join(" ")
  if (
    itemWorkspaceText &&
    accountText &&
    itemWorkspaceText.toLowerCase() === accountText.toLowerCase()
  ) {
    return true
  }

  return businessMatches(resolvedItemBusiness(item), activeBusiness)
}

function displayCouncilTitle(item: CouncilDisplayItem): string {
  return cleanScanText(item.pendingTitle ?? councilItemTitle(item))
}

function councilItemTitle(item: IntelItem): string {
  const text = [item.person, item.summary, item.action, item.evidence].filter(Boolean).join(" ")
  const person = item.person ?? scanTitle(item)
  if (/billables?|work orders?|track/i.test(text)) return "Billables need alignment"
  if (/payroll|attendance|payrun|status/i.test(text)) return "Payroll edit + attendance issue"
  if (/owner|approval|signature|deposit|quote|budget/i.test(text)) return "Owner approval path"
  if (/arrival|booking|check.?in|door|lock|code/i.test(text)) return "Arrival risk"
  if (/maintenance|repair|leak|hvac|vendor/i.test(text)) return "Maintenance follow-through"
  if (/lead|follow.?up|conversion|stellara/i.test(text)) return "Lead follow-up window"
  return person.includes("#") || person === "DM" ? shortCouncilText(cleanScanText(item.summary), 54) : `${person} needs attention`
}

function councilItemContext(item: IntelItem): string {
  if (item.source === "gmail" || item.sourceLabel?.toLowerCase() === "gmail") {
    return ["Gmail", item.sent_at].filter(Boolean).join("  ·  ")
  }
  const channel = item.person ? "Priority DMs + Ops" : channelLabel(item.channel)
  return [item.person ?? scanTitle(item), channel, item.sent_at].filter(Boolean).join("  ·  ")
}

function shortCouncilText(value: string | undefined | null, max = 96): string {
  const text = value ? cleanScanText(value) : ""
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function lastScanCopy(value: string | null): string {
  if (!value) return "Not scanned yet"
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function ManilaClock() {
  const now = new Date()
  return (
    <span className="font-mono-data text-sm font-bold text-[#6d5334]">
      {now.toLocaleTimeString([], {
        timeZone: "Asia/Manila",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}{" "}
      • Manila •{" "}
      {now.toLocaleDateString([], {
        timeZone: "Asia/Manila",
        weekday: "short",
        month: "short",
        day: "numeric",
      })}
    </span>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <p className="text-2xl font-extrabold tracking-[-0.04em] text-[#2b1d0f]">{value}</p>
      <p className="mt-1 text-sm font-medium text-[#6d5334]">{label}</p>
    </div>
  )
}

function SummaryLine({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm font-medium text-[#4f3b28]">{label}</span>
      <span className="font-mono-data text-sm font-extrabold text-[#2b1d0f]">{value}</span>
    </div>
  )
}

const SOURCE_URGENCY: Record<
  SourceBriefItem["urgency"],
  {
    label: string
    text: string
    bg: string
  }
> = {
  critical: { label: "Critical", text: "text-red-700", bg: "bg-red-100" },
  high: { label: "High", text: "text-orange-700", bg: "bg-orange-100" },
  medium: { label: "Medium", text: "text-amber-700", bg: "bg-amber-100" },
  low: { label: "Low", text: "text-[#6d5334]", bg: "bg-[#efe6d8]" },
}

function BriefItemList({
  title,
  items,
  empty,
}: {
  title: string
  items: SourceBriefItem[]
  empty: string
}) {
  return (
    <div className="rounded-2xl border border-[#eadcca] bg-[#fffaf1]/70 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#8a7256]">
          {title}
        </p>
        <span className="rounded-full bg-[#efe6d8] px-2 py-1 text-[11px] font-bold text-[#2b1d0f]">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm font-medium leading-relaxed text-[#8a7256]">{empty}</p>
      ) : (
        <div className="space-y-3">
          {items.slice(0, 4).map((item, index) => {
            const cfg = SOURCE_URGENCY[item.urgency] ?? SOURCE_URGENCY.medium
            const SourceIcon = item.sourceType === "gmail" ? Mail : MessageSquare
            return (
              <article
                key={`${item.id ?? item.title}-${index}`}
                className="border-l-2 border-[#dfcfb1] pl-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <SourceIcon size={14} className="text-[#d94b1f]" />
                  <span
                    className={[
                      "rounded px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-[0.1em]",
                      cfg.bg,
                      cfg.text,
                    ].join(" ")}
                  >
                    {cfg.label}
                  </span>
                  {item.person && (
                    <span className="text-xs font-bold text-[#6d5334]">{item.person}</span>
                  )}
                </div>
                <p className="mt-1 text-sm font-extrabold leading-snug text-[#2b1d0f]">
                  {shortCouncilText(item.title, 88)}
                </p>
                <p className="mt-1 text-sm font-medium leading-relaxed text-[#4f3b28]">
                  {shortCouncilText(item.summary, 140)}
                </p>
                {item.nextAction && (
                  <p className="mt-1 text-xs font-semibold leading-relaxed text-[#8a7256]">
                    Move: {shortCouncilText(item.nextAction, 120)}
                  </p>
                )}
                {item.sourceUrl && (
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-[#d94b1f]"
                  >
                    Open source <ExternalLink size={12} />
                  </a>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

const HANDLED_STORAGE_KEY = "odin.council.handled-items.v1"

export function Council() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { google, slack } = useConnectedAccounts()
  const { workspaces, loading, refresh } = useSlackMessages(60_000)
  const odinResponsibility = useOdinResponsibility(user?.id)
  const {
    loadCached: loadCachedIntel,
    scanning,
    result: intel,
  } = useSlackIntel()

  const [activeId, setActiveId] = useState<string | null>(null)
  const [scanChannelId, setScanChannelId] = useState("all")
  const [includeAllChannels, setIncludeAllChannels] = useState(false)
  const [workspaceChannels, setWorkspaceChannels] = useState<SlackChannel[]>([])
  const [scanFrom, setScanFrom] = useState(() => daysAgo(3))
  const [scanTo, setScanTo] = useState(() => daysAgo(0))
  const [refreshing, setRefreshing] = useState(false)
  const [showHandled, setShowHandled] = useState(false)
  const [agentScanState, setAgentScanState] = useState<CouncilAgentScanState>({
    state: "idle",
    message: "",
    startedAt: null,
    latestAt: null,
  })
  const [handledKeys, setHandledKeys] = useState<string[]>(() => {
    if (typeof window === "undefined") return []
    try {
      const raw = window.localStorage.getItem(HANDLED_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : []
    } catch {
      return []
    }
  })
  const [sourceBriefs, setSourceBriefs] = useState<SourceBrief[]>([])
  const [sourceBriefsLoading, setSourceBriefsLoading] = useState(false)
  const [sourceBriefsError, setSourceBriefsError] = useState<string | null>(null)
  const { error: agentError } = useAgentJobs()

  const effectiveId = activeId ?? slack[0]?.id ?? null
  const activeAccount = slack.find((acct) => acct.id === effectiveId) ?? null
  const activeBusiness = activeBusinessForAccount(activeAccount)
  const active = workspaces.find((w) => w.accountId === effectiveId) ?? null
  const handledSet = useMemo(() => new Set(handledKeys), [handledKeys])
  const accountBusinessById = useMemo(() => {
    const map = new Map<string, ClassifiedBusiness>()
    for (const account of [...slack, ...google]) {
      map.set(account.id, activeBusinessForAccount(account))
    }
    return map
  }, [google, slack])
  const rawAgentPriorityItems = useMemo<CouncilDisplayItem[]>(
    () =>
      odinResponsibility.pendingItems
        .filter(
          (item) =>
            (item.status === "open" || item.status === "waiting") &&
            isAgentPendingItem(item)
        )
        .sort((a, b) => pendingRank(b) - pendingRank(a))
        .map((item) => pendingItemToCouncilItem(item, accountBusinessById)),
    [accountBusinessById, odinResponsibility.pendingItems]
  )
  const agentPriorityItems = useMemo(
    () =>
      rawAgentPriorityItems.filter((item) =>
        itemMatchesActiveWorkspace(item, activeAccount, activeBusiness)
      ),
    [activeAccount, activeBusiness, rawAgentPriorityItems]
  )
  const rawVisibleIntelItems = useMemo(
    () =>
      showHandled
        ? intel.items
        : intel.items.filter((item) => !handledSet.has(handledKey(item))),
    [handledSet, intel.items, showHandled]
  )
  const handledIntelCount = intel.items.length - rawVisibleIntelItems.length
  const scanChannels = useMemo(() => {
    const seen = new Map<string, string>()
    for (const channel of workspaceChannels) {
      if (channel.name && (includeAllChannels || channel.is_member !== false)) {
        seen.set(channel.id, channel.name)
      }
    }
    for (const msg of active?.messages ?? []) {
      if (!seen.has(msg.channelId)) seen.set(msg.channelId, msg.channelName)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [active?.messages, includeAllChannels, workspaceChannels])
  const selectedScanChannel = scanChannels.find((c) => c.id === scanChannelId)
  const agentErrorMessage =
    agentError instanceof Error ? agentError.message : agentError ? String(agentError) : null
  const activeFreshnessBusiness =
    activeBusiness === "Unassigned" ? undefined : activeBusiness
  const activeAgentFreshness = useMemo(
    () =>
      summarizeAgentFreshness(
        odinResponsibility.pendingItems,
        undefined,
        activeFreshnessBusiness
      ),
    [activeFreshnessBusiness, odinResponsibility.pendingItems]
  )
  const agentPlusEmailItems = useMemo(
    () => mergeCouncilItems(agentPriorityItems),
    [agentPriorityItems]
  )
  const usingAgentQueue = agentPlusEmailItems.length > 0
  const activeSourceBrief = useMemo(
    () => sourceBriefs.find((brief) => briefMatchesBusiness(brief, activeBusiness)) ?? null,
    [activeBusiness, sourceBriefs]
  )
  const stayMintySourceBrief =
    sourceBriefs.find((brief) => brief.source === "stayminty_automation") ?? null
  const dinbnbSourceBrief =
    sourceBriefs.find((brief) => brief.source === "dinbnb_automation") ?? null
  const activeBriefNeedsNow = useMemo(
    () => briefItemsForGroup(activeSourceBrief?.items ?? [], "now"),
    [activeSourceBrief]
  )
  const activeBriefFollowups = useMemo(
    () => briefItemsForGroup(activeSourceBrief?.items ?? [], "followups"),
    [activeSourceBrief]
  )
  const activeBriefNoise = useMemo(
    () => briefItemsForGroup(activeSourceBrief?.items ?? [], "noise"),
    [activeSourceBrief]
  )
  const activeBriefOpenCount = activeBriefNeedsNow.length + activeBriefFollowups.length
  const lastCouncilSignalAt = activeSourceBrief?.createdAt ?? activeAgentFreshness.latestAt
  const priorityItems = agentPlusEmailItems
  const prioritySourceLine = usingAgentQueue
    ? activeAgentFreshness.detail
    : activeSourceBrief
      ? `${activeSourceBrief.business} report posted ${briefAge(activeSourceBrief.createdAt)}. ${cleanScanText(activeSourceBrief.summary)}`
      : agentScanState.state === "stale" || agentScanState.state === "error"
        ? agentScanState.message
        : "No fresh Claude/Codex source brief has reached Council yet. Run ODIN Scan, then post the agent brief to /ingest."
  const councilScanning =
    scanning || odinResponsibility.loading || agentScanState.state === "requesting"

  useEffect(() => {
    let cancelled = false
    setWorkspaceChannels([])
    setScanChannelId("all")
    if (!effectiveId) return

    listSlackChannels(effectiveId, includeAllChannels)
      .then((resp) => {
        if (cancelled) return
        setWorkspaceChannels(resp.data?.channels ?? [])
      })
      .catch(() => {
        if (!cancelled) setWorkspaceChannels([])
      })

    return () => {
      cancelled = true
    }
  }, [effectiveId, includeAllChannels])

  useEffect(() => {
    loadCachedIntel({
      accountId: effectiveId ?? undefined,
      channelId: selectedScanChannel?.id,
      channelName: selectedScanChannel?.name,
      dateFrom: scanFrom,
      dateTo: scanTo,
    })
  }, [effectiveId, loadCachedIntel, scanFrom, scanTo, selectedScanChannel?.id, selectedScanChannel?.name])

  const refreshSourceBriefs = useCallback(async () => {
    if (!user?.id) {
      setSourceBriefs([])
      setSourceBriefsError(null)
      return []
    }
    setSourceBriefsLoading(true)
    setSourceBriefsError(null)
    try {
      const briefs = await listLatestSourceBriefs(user.id)
      setSourceBriefs(briefs)
      return briefs
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Council could not load source reports."
      setSourceBriefsError(message)
      return []
    } finally {
      setSourceBriefsLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    void refreshSourceBriefs()
  }, [refreshSourceBriefs])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "council")) return
      void Promise.all([refresh(), odinResponsibility.refresh(), refreshSourceBriefs()])
    })
  }, [odinResponsibility, refresh, refreshSourceBriefs])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await Promise.all([refresh(), odinResponsibility.refresh(), refreshSourceBriefs()])
    } finally {
      setRefreshing(false)
    }
  }

  async function handleScan() {
    if (!user?.id) {
      setAgentScanState({
        state: "error",
        message: "Council cannot request an agent brief without an active user session.",
        startedAt: null,
        latestAt: activeAgentFreshness.latestAt,
      })
      return
    }

    const startedAt = new Date()
    const startedIso = startedAt.toISOString()
    publishLiveScanRefreshSignal({
      reason: "council_live_scan",
      requestedAt: startedIso,
      sources: ["all", "calendar", "gmail", "slack", "weather", "health", "council"],
    })
    setAgentScanState({
      state: "requesting",
      startedAt: startedIso,
      latestAt: activeAgentFreshness.latestAt,
      message: "Queueing scoped Stay Minty Claude scan: label:stayminty, Smokies/Nashville, and weekly priority docs.",
    })

    const agentJob = await queueStayMintyLiveSyncRequest({
      userId: user.id,
      requestedAt: startedIso,
      requestedBy: "council_scan",
      scanWindowDays: 7,
    })
    if (agentJob.error) {
      setAgentScanState({
        state: "error",
        startedAt: startedIso,
        latestAt: activeAgentFreshness.latestAt,
        message: `Could not queue Claude/Codex scan request: ${agentJob.error.message}`,
      })
      return
    }

    setAgentScanState((state) => ({
      ...state,
      message: agentJob.data?.id
        ? `Stay Minty Claude scan queued (${agentJob.data.id.slice(0, 8)}). Waiting for fresh /ingest results.`
        : "Stay Minty Claude scan queued. Waiting for fresh /ingest results.",
    }))

    const backendCheck = invokeOdinCommand({
      query:
        "Council ODIN Scan. Require a fresh claude_stayminty brief for Stay Minty only. Scope: Gmail label stayminty, Smokies/Nashville focus, and the two weekly Google Docs as priority anchors. Do not run ODIN direct Slack or Gmail polling. If no agent brief was posted after this request began, say no fresh agent brief was received and keep old Slack/Gmail as last-known only.",
      source: "text",
      timezone: "Asia/Manila",
      mode: "slack",
      tone: "formal",
      skipSynthesis: true,
      useFreshScan: true,
      scanSources: ["slack", "gmail"],
      scanWindowDays: 7,
      conversationId: `council-agent-scan-${startedAt.getTime()}`,
      turnId: crypto.randomUUID(),
      visiblePage: window.location.pathname,
      recentContext:
        `Council scan started at ${startedIso}. Stay Minty priorities must be from a fresh claude_stayminty /ingest brief created after that time. Scope: label:stayminty Gmail only, Smokies/Nashville focus, and weekly Google Docs as priority sources. If none arrive, report stale status instead of rereading old direct Slack results.`,
    }).catch((error) => {
      console.warn(
        "[ODIN] Council agent brief request failed",
        error instanceof Error ? error.message : error
      )
      return null
    })

    try {
      let snapshot = await odinResponsibility.refreshAndGet()
      let freshAgentBrief = hasAgentBriefAfter(snapshot.items, startedAt, "Stay Minty")
      const deadline = Date.now() + COUNCIL_AGENT_BRIEF_WAIT_MS
      while (!freshAgentBrief && Date.now() < deadline) {
        await wait(COUNCIL_AGENT_BRIEF_POLL_MS)
        snapshot = await odinResponsibility.refreshAndGet()
        freshAgentBrief = hasAgentBriefAfter(snapshot.items, startedAt, "Stay Minty")
      }

      const freshness = summarizeAgentFreshness(snapshot.items, undefined, "Stay Minty")
      await backendCheck
      await refreshSourceBriefs()
      if (!freshAgentBrief) {
        setAgentScanState({
          state: "stale",
          startedAt: startedIso,
          latestAt: freshness.latestAt,
          message: freshness.latestAt
            ? `No new Claude/Codex brief arrived for this scan. Showing last known queue from ${formatAgentBriefAge(freshness.latestAt)}.`
            : "No new Claude/Codex brief arrived for this scan. The Slack/Gmail queue is empty.",
        })
        return
      }

      setAgentScanState({
        state: "fresh",
        startedAt: startedIso,
        latestAt: freshness.latestAt,
        message: freshness.detail,
      })
    } catch (error) {
      await backendCheck
      await refreshSourceBriefs()
      setAgentScanState({
        state: "error",
        startedAt: startedIso,
        latestAt: activeAgentFreshness.latestAt,
        message:
          error instanceof Error
            ? error.message
            : "Council could not refresh the agent-fed queue.",
      })
    }
  }

  function saveHandled(next: string[]) {
    const unique = Array.from(new Set(next)).slice(-250)
    setHandledKeys(unique)
    try {
      window.localStorage.setItem(HANDLED_STORAGE_KEY, JSON.stringify(unique))
    } catch {
      // Local persistence is a convenience; scan behavior still works without it.
    }
  }

  async function markHandled(item: CouncilDisplayItem) {
    if (item.pendingId) {
      await odinResponsibility.setPendingStatus(item.pendingId, "handled")
      return
    }
    saveHandled([...handledKeys, handledKey(item)])
  }

  function restoreHandled(item: CouncilDisplayItem) {
    const key = handledKey(item)
    saveHandled(handledKeys.filter((value) => value !== key))
  }

  const criticalCount = priorityItems.filter((item) => item.urgency === "critical").length
  const highCount = priorityItems.filter((item) => item.urgency === "high").length
  const mediumCount = priorityItems.filter((item) => item.urgency === "medium").length
  const waitingReplyCount = priorityItems.filter((item) =>
    /\b(reply|respond|confirm|align|ask|send|review)\b/i.test(item.action)
  ).length
  const blockedCount = priorityItems.filter((item) =>
    /\b(block|blocked|cannot|waiting|approval|deposit|signature)\b/i.test(
      `${item.summary} ${item.action}`
    )
  ).length
  const inProgressCount = Math.max(0, Math.min(2, highCount + mediumCount))
  const handledTodayCount = Math.max(handledIntelCount, handledKeys.length ? Math.min(6, handledKeys.length) : 0)
  const topItem = priorityItems[0]
  const suggestedMove =
    criticalCount > 0
      ? `Review ${criticalCount} critical ${criticalCount === 1 ? "item" : "items"}`
      : topItem
        ? displayCouncilTitle(topItem)
        : "Request an agent brief"
  const suggestedDetail =
    criticalCount > 0
      ? "They are blocking progress."
        : topItem
          ? shortCouncilText(cleanScanText(topItem.action), 80)
        : "Council waits for fresh source briefs before calling Slack or Gmail current."

  return (
    <LightPageShell>
      <header className="mb-7 flex flex-wrap items-start justify-between gap-5">
        <div>
          <button
            type="button"
            onClick={() => navigate("/dashboard?portal=open")}
            className="mb-4 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-[#6d5334] transition hover:text-[#d94b1f]"
          >
            ← Hall
          </button>
          <div className="flex flex-wrap items-end gap-3">
            <h1 className="text-5xl font-extrabold tracking-[-0.06em] text-[#2b1d0f]">
              Council
            </h1>
            <span className="mb-2 inline-flex items-center gap-2 text-sm font-semibold text-[#d94b1f]">
              <span className="h-2 w-2 rounded-full bg-[#d94b1f]" />
              Live
            </span>
          </div>
          <p className="mt-2 text-base font-medium text-[#6d5334]">
            Real-time operational feed. What needs your attention now.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <ManilaClock />
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading || refreshing}
            className="odin-light-action h-12 px-5 text-sm disabled:opacity-50"
          >
            <RefreshCw size={16} className={refreshing || loading ? "animate-spin" : ""} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleScan}
            disabled={councilScanning || !user?.id}
            className="odin-light-action odin-light-action-primary h-12 px-7 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Zap size={17} className={councilScanning ? "animate-pulse" : ""} />
            {councilScanning ? "Waiting" : "Live Scan"}
          </button>
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[250px_minmax(0,1fr)] 2xl:grid-cols-[260px_minmax(0,1fr)_360px]">
        <aside className="odin-light-card rounded-3xl p-5">
          <div className="mb-5 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#6d5334]">
              Workspaces
            </p>
            <button
              type="button"
              onClick={() => navigate("/connections")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-[#dfcfb1] text-[#6d5334] transition hover:border-[#d94b1f] hover:text-[#d94b1f]"
              aria-label="Add Slack workspace"
            >
              <Plus size={16} />
            </button>
          </div>

          <div className="space-y-2">
            {slack.length === 0 ? (
              <button
                type="button"
                onClick={() => navigate("/connections")}
                className="w-full rounded-2xl border border-[#dfcfb1] p-4 text-left text-sm font-semibold text-[#6d5334] transition hover:border-[#d94b1f]"
              >
                Connect Slack
              </button>
            ) : (
              slack.map((acct) => {
                const ws = workspaces.find((w) => w.accountId === acct.id)
                const isActive = effectiveId === acct.id
                const acctBusiness = activeBusinessForAccount(acct)
                const acctItems = rawAgentPriorityItems.filter((item) =>
                  itemMatchesActiveWorkspace(item, acct, acctBusiness)
                )
                const count = acctItems.length > 0 ? acctItems.length : ws?.totalUnread ?? 0
                return (
                  <button
                    key={acct.id}
                    type="button"
                    onClick={() => setActiveId(acct.id)}
                    className={[
                      "flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left transition",
                      isActive
                        ? "bg-[#fff6ec] text-[#2b1d0f] shadow-[inset_0_0_0_1px_rgba(217,75,31,0.14)]"
                        : "text-[#6d5334] hover:bg-[#fff6ec]/70",
                    ].join(" ")}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <MessageSquare size={17} className={isActive ? "text-[#d94b1f]" : "text-[#6d5334]"} />
                      <span className="truncate text-base font-bold">
                        {acct.workspaceName ?? acct.accountLabel}
                      </span>
                    </span>
                    <span
                      className={[
                        "inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-bold",
                        isActive ? "bg-[#d94b1f] text-white" : "bg-[#efe6d8] text-[#2b1d0f]",
                      ].join(" ")}
                    >
                      {count}
                    </span>
                  </button>
                )
              })
            )}
            <button
              type="button"
              onClick={() => setShowHandled((value) => !value)}
              className="flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left text-[#6d5334] transition hover:bg-[#fff6ec]/70"
            >
              <span className="flex items-center gap-3">
                <CheckCircle2 size={17} />
                Archive
              </span>
              <span className="rounded-full bg-[#efe6d8] px-2 py-1 text-xs font-bold text-[#2b1d0f]">
                {handledIntelCount}
              </span>
            </button>
          </div>

          <div className="mt-24 space-y-5 border-t border-[#dfcfb1] pt-5">
            <Metric label="Active priorities" value={priorityItems.length} />
            <Metric label="Waiting replies" value={waitingReplyCount} />
            <Metric label="Blocked" value={blockedCount} />
          </div>

          <div className="mt-6 border-t border-[#dfcfb1] pt-5">
            <p className="text-xs uppercase tracking-[0.16em] text-[#9b815e]">Last scan</p>
            <p className="mt-2 text-base font-bold text-[#2b1d0f]">
              {lastScanCopy(lastCouncilSignalAt ?? null)}
            </p>
            <p className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-[#6d5334]">
              <span
                className={[
                  "h-2 w-2 rounded-full",
                  usingAgentQueue && !activeAgentFreshness.stale ? "bg-emerald-500" : "bg-amber-500",
                ].join(" ")}
              />
              {usingAgentQueue ? activeAgentFreshness.detail : "Waiting for a fresh source brief"}
            </p>
          </div>
        </aside>

        <main className="min-w-0 space-y-5">
          <section className="odin-light-card grid gap-5 rounded-3xl p-6 md:grid-cols-2 2xl:grid-cols-4">
            <label className="grid gap-2 border-[#dfcfb1] 2xl:border-r 2xl:pr-5">
              <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                Channel
              </span>
              <select
                value={scanChannelId}
                onChange={(event) => setScanChannelId(event.target.value)}
                className="odin-light-control h-10 w-full px-0 text-base font-semibold"
              >
                <option value="all">Priority DMs + Ops</option>
                {scanChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2 border-[#dfcfb1] 2xl:border-r 2xl:pr-5">
              <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                Visibility
              </span>
              <select
                value={includeAllChannels ? "all" : "readable"}
                onChange={(event) => setIncludeAllChannels(event.target.value === "all")}
                className="odin-light-control h-10 w-full px-0 text-base font-semibold"
              >
                <option value="readable">Readable channels</option>
                <option value="all">All visible channels</option>
              </select>
            </label>

            <label className="grid gap-2 border-[#dfcfb1] 2xl:border-r 2xl:pr-5">
              <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                From
              </span>
              <input
                type="date"
                value={scanFrom}
                onChange={(event) => setScanFrom(event.target.value)}
                className="odin-light-control h-10 w-full px-0 text-base font-semibold"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                To
              </span>
              <input
                type="date"
                value={scanTo}
                onChange={(event) => setScanTo(event.target.value)}
                className="odin-light-control h-10 w-full px-0 text-base font-semibold"
              />
            </label>

            <button
              type="button"
              onClick={handleScan}
              disabled={councilScanning || !user?.id}
              className="odin-light-action h-14 px-6 text-base font-bold text-[#d94b1f] disabled:opacity-50 md:col-span-2 2xl:col-span-4"
            >
              <Zap size={17} />
              Request Agent Brief
            </button>
          </section>

          <section className="odin-light-card rounded-3xl p-5">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#6d5334]">
                  Source report
                </p>
                <h2 className="mt-2 text-2xl font-extrabold tracking-[-0.04em] text-[#2b1d0f]">
                  {activeSourceBrief
                    ? `${activeSourceBrief.business} operator brief`
                    : `${activeBusiness} source brief pending`}
                </h2>
                <p className="mt-1 max-w-3xl text-sm font-medium leading-relaxed text-[#6d5334]">
                  Claude owns StayMinty. Codex owns Dinbnb. Council treats their posted
                  Slack + Gmail summaries as live signal and marks anything else as last-known.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-bold">
                <span className="rounded-full border border-[#dfcfb1] bg-[#fffaf1] px-3 py-2 text-[#6d5334]">
                  StayMinty: {briefAge(stayMintySourceBrief?.createdAt)}
                </span>
                <span className="rounded-full border border-[#dfcfb1] bg-[#fffaf1] px-3 py-2 text-[#6d5334]">
                  Dinbnb: {briefAge(dinbnbSourceBrief?.createdAt)}
                </span>
                <span className="rounded-full border border-[#dfcfb1] bg-[#fffaf1] px-3 py-2 text-[#6d5334]">
                  Last sync: {lastScanCopy(lastCouncilSignalAt ?? null)}
                </span>
              </div>
            </div>

            {sourceBriefsLoading ? (
              <div className="flex min-h-[120px] items-center justify-center gap-3 rounded-2xl border border-[#eadcca] bg-[#fffaf1]/70 text-sm font-bold text-[#6d5334]">
                <RefreshCw className="animate-spin" size={18} />
                Loading latest source reports...
              </div>
            ) : sourceBriefsError ? (
              <div className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm font-semibold text-red-600">
                {sourceBriefsError}
              </div>
            ) : activeSourceBrief ? (
              <div className="space-y-4">
                <div className="rounded-2xl border border-[#eadcca] bg-[#fff7ed] p-4">
                  <div className="flex flex-wrap items-center gap-3 text-xs font-bold uppercase tracking-[0.14em] text-[#8a7256]">
                    <span>{agentBriefLabel(activeSourceBrief.sourceAgent)}</span>
                    <span>•</span>
                    <span>{briefAge(activeSourceBrief.createdAt)}</span>
                    <span>•</span>
                    <span>Urgency {activeSourceBrief.urgencyScore}/10</span>
                    <span>•</span>
                    <span>{activeBriefOpenCount} open</span>
                  </div>
                  <p className="mt-3 text-base font-semibold leading-relaxed text-[#2b1d0f]">
                    {cleanScanText(activeSourceBrief.summary)}
                  </p>
                </div>

                {activeSourceBrief.report ? (
                  <div className="max-h-[360px] overflow-auto rounded-2xl border border-[#eadcca] bg-[#fffaf1]/80 p-5">
                    <pre className="whitespace-pre-wrap font-sans text-sm font-medium leading-relaxed text-[#2b1d0f]">
                      {activeSourceBrief.report}
                    </pre>
                  </div>
                ) : (
                  <div className="grid gap-4 2xl:grid-cols-3">
                    <BriefItemList
                      title="Needs decision now"
                      items={activeBriefNeedsNow}
                      empty="No owner-level decision is open in this source brief."
                    />
                    <BriefItemList
                      title="Follow-ups pending"
                      items={activeBriefFollowups}
                      empty="No low-clock follow-up was included."
                    />
                    <BriefItemList
                      title="Noise / handled"
                      items={activeBriefNoise}
                      empty="No handled/noise bucket was posted."
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm font-semibold leading-relaxed text-amber-800">
                No fresh {activeBusiness} source brief has reached ODIN in the last 36 hours.
                Live Scan will show last-known queue items, but it will not pretend old Slack
                or Gmail rows are fresh.
              </div>
            )}
          </section>

          <section className="odin-light-card rounded-3xl p-5">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#6d5334]">
                  Priority items
                </p>
                <span className="rounded-full bg-[#efe6d8] px-2 py-1 text-xs font-bold text-[#2b1d0f]">
                  {priorityItems.length}
                </span>
              </div>
              <div className="flex items-center gap-4 text-sm font-medium text-[#6d5334]">
                <span>Sort by: Priority</span>
                <SlidersHorizontal size={17} />
              </div>
            </div>

            <div
              className={[
                "mb-4 rounded-2xl border px-4 py-3 text-sm font-semibold",
                agentScanState.state === "fresh"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : agentScanState.state === "stale" || agentScanState.state === "error"
                    ? "border-amber-300 bg-amber-50 text-amber-800"
                    : "border-[#dfcfb1] bg-[#fffaf1]/75 text-[#6d5334]",
              ].join(" ")}
            >
              {agentScanState.message || prioritySourceLine}
            </div>

            {councilScanning ? (
              <div className="flex min-h-[260px] items-center justify-center gap-3 text-[#6d5334]">
                <RefreshCw className="animate-spin" size={20} />
                Waiting for a fresh ODIN source brief...
              </div>
            ) : priorityItems.length === 0 ? (
              <div className="rounded-2xl border border-[#eadcca] bg-[#fffaf1]/80 px-5 py-6 text-sm font-semibold leading-relaxed text-[#6d5334]">
                <div className="text-[#a17c52]">No open priority items for {activeBusiness}.</div>
                <p className="mt-2 text-[#6d5334]">
                  {councilScanning
                    ? "ODIN is refreshing source brief feed."
                    : "Post a fresh source brief or run Live Scan to wait for one."}
                </p>
              </div>
            ) : (
              <ul className="grid gap-3">
                {priorityItems.slice(0, 8).map((item, index) => {
                  const sourceUrl = itemSourceUrl(item)
                  const isHandled = handledSet.has(handledKey(item))

                  return (
                    <li
                      key={`${item.source}-${item.sent_at}-${item.summary}-${index}`}
                      className="rounded-2xl border border-[#eadcca] bg-white p-4"
                    >
                      <p className="mb-2 text-sm font-bold text-[#3c2f1f]">
                        {displayCouncilTitle(item)}
                      </p>
                      <p className="mb-2 text-sm leading-relaxed text-[#6d5334]">
                        {shortCouncilText(cleanScanText(item.action), 160)}
                      </p>
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-[#8a7256]">
                        {item.sourceLabel && (
                          <span className="rounded-full bg-[#f2e6d1] px-2 py-0.5">
                            {item.sourceLabel}
                          </span>
                        )}
                        {item.sourceAgent && (
                          <span className="rounded-full bg-[#edf3ff] px-2 py-0.5">
                            {agentBriefLabel(item.sourceAgent)}
                          </span>
                        )}
                        {item.evidence ? (
                          <span className="rounded-full bg-[#f3f0ff] px-2 py-0.5">
                            evidence
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs font-medium text-[#a17c52]">{councilItemContext(item)}</p>
                      {sourceUrl ? (
                        <a
                          href={sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#2f2e42] px-3 py-1.5 text-xs font-bold text-white"
                        >
                          <ExternalLink size={14} />
                          {openActionLabel(item)}
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void (isHandled ? restoreHandled(item) : markHandled(item))}
                        className="mt-3 inline-flex h-9 items-center gap-2 rounded-full border border-[#eadcca] bg-[#fff7ed] px-3 text-xs font-bold text-[#6d5334]"
                      >
                        <CheckCircle2 size={14} />
                        {isHandled ? "Restore" : "Mark handled"}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </main>

        <aside className="odin-light-card rounded-3xl p-6 xl:col-span-2 2xl:col-span-1">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#6d5334]">
            ODIN Summary
          </p>
          <div className="mt-5 flex flex-col items-center text-center">
            <div className="odin-council-orb" aria-hidden="true" data-alert={criticalCount > 0 ? "true" : "false"} />
            <p className="mt-4 text-5xl font-extrabold tracking-[-0.06em] text-[#2b1d0f]">
              {priorityItems.length}
            </p>
            <p className="text-base font-bold text-[#2b1d0f]">Priority items</p>
            <div className="mt-5 flex flex-wrap justify-center gap-4 text-xs font-medium text-[#6d5334]">
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-red-500" />
                {criticalCount} Critical
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-orange-400" />
                {highCount} High
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                {mediumCount} Medium
              </span>
            </div>
          </div>

          <div className="mt-6 space-y-4 border-y border-[#dfcfb1] py-5">
            <SummaryLine label="Waiting on you" value={priorityItems.length} />
            <SummaryLine label="In progress" value={inProgressCount} />
            <SummaryLine label="Handled today" value={handledTodayCount} />
          </div>

          <div className="mt-5 border-b border-[#dfcfb1] pb-5">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#9b815e]">
              Last scan
            </p>
            <p className="mt-2 text-base font-bold text-[#2b1d0f]">
              {lastScanCopy(lastCouncilSignalAt ?? null)}
            </p>
            {usingAgentQueue ? (
              <p
                className={[
                  "mt-2 text-xs font-medium",
                  activeAgentFreshness.stale ? "text-amber-700" : "text-emerald-700",
                ].join(" ")}
              >
                {activeAgentFreshness.detail}
              </p>
            ) : intel.warnings.length > 0 ? (
              <p className="mt-2 text-xs font-medium text-amber-700">
                Partial scan: {shortCouncilText(intel.warnings[0], 80)}
              </p>
            ) : (
              <p className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-[#6d5334]">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                Agent brief required for live Slack/Gmail
              </p>
            )}
          </div>

          <div className="mt-5">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#9b815e]">
              Suggested next move
            </p>
            <h3 className="mt-3 text-lg font-extrabold text-[#2b1d0f]">
              {suggestedMove}
            </h3>
            <p className="mt-1 text-sm font-medium text-[#6d5334]">{suggestedDetail}</p>
            <button
              type="button"
              onClick={() => {
                const el = document.querySelector("[data-critical-item='true']")
                el?.scrollIntoView({ behavior: "smooth", block: "center" })
              }}
              className="odin-light-action odin-light-action-primary mt-5 h-12 w-full px-5 text-sm"
            >
              Focus on critical
              <ExternalLink size={15} />
            </button>
          </div>

          {agentErrorMessage && (
            <p className="mt-4 rounded-xl border border-red-300/60 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
              {agentErrorMessage}
            </p>
          )}
        </aside>
      </div>
    </LightPageShell>
  )

}

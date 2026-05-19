import {
  Archive,
  BookOpen,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  FileSearch,
  Inbox,
  ListChecks,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import {
  archiveOdinMemory,
  createOdinMemory,
  listOdinMemories,
  type OdinMemory,
  type OdinMemoryKind,
} from "@/lib/odinMemory"
import type {
  OdinLearningEvent,
  OdinPendingSummary,
} from "@/lib/odinResponsibility"
import { invokeOdinCommand, type OdinCommandResponse } from "@/lib/odinOrchestrator"
import { cn } from "@/lib/utils"
import type {
  OperationsSignal,
  OperationsSignalStatus,
  OperationsSourceHealth,
} from "@/types/operations"

export type UnifiedHubView =
  | "priority"
  | "inbox"
  | "today"
  | "research"
  | "memory"
  | "rules"

interface UnifiedOperationsHubProps {
  userId?: string
  view: UnifiedHubView
  onViewChange: (view: UnifiedHubView) => void
  signals: OperationsSignal[]
  sourceHealth: OperationsSourceHealth[]
  onStatusChange: (id: string, status: OperationsSignalStatus) => void
  onOpenTextCommand: (draft?: string) => void
  onAwaken: () => void
  learningEvents?: OdinLearningEvent[]
  pendingSummary?: OdinPendingSummary
  scanRefreshing?: boolean
  onRefreshScan?: () => void
}

const VIEW_CONFIG = {
  priority: {
    label: "Priority",
    icon: ListChecks,
    description: "Needs Peter, waiting, today, and done recently.",
  },
  inbox: {
    label: "Inbox",
    icon: Inbox,
    description: "All open operational signals in one stream.",
  },
  today: {
    label: "Today",
    icon: Clock3,
    description: "Calendar, deadlines, follow-ups, and time-bound work.",
  },
  research: {
    label: "Research",
    icon: FileSearch,
    description: "Paste a topic or link; ODIN summarizes and suggests next action.",
  },
  memory: {
    label: "Memory",
    icon: BookOpen,
    description: "People, roles, businesses, properties, preferences.",
  },
  rules: {
    label: "Rules",
    icon: Settings2,
    description: "What ODIN should flag, mute, and treat as important.",
  },
} satisfies Record<UnifiedHubView, { label: string; icon: typeof Inbox; description: string }>

const SOURCE_LABEL: Record<OperationsSignal["source"], string> = {
  slack: "Slack",
  gmail: "Gmail",
  calendar: "Calendar",
  health: "Vitals",
  browser: "Browser",
  manual: "Manual",
  memory: "Memory",
  research: "Research",
  weather: "Weather",
  system: "System",
}

const SOURCE_ROUTE: Record<OperationsSignal["source"], string> = {
  slack: "/council",
  gmail: "/connections",
  calendar: "/calendar",
  health: "/connections",
  browser: "/connections",
  manual: "/dashboard",
  memory: "/settings",
  research: "/dashboard",
  weather: "/dashboard",
  system: "/connections",
}

function bucketFor(signal: OperationsSignal) {
  if (signal.status === "handled" || signal.status === "deferred") return "done_recently"
  if (signal.status === "waiting" || signal.category === "waiting") return "waiting"
  if (signal.source === "calendar" || signal.category === "today") return "today"
  if (signal.category === "urgent" || signal.category === "follow_up") return "needs_peter"
  return "inbox"
}

function signalRank(signal: OperationsSignal) {
  const order = {
    needs_peter: 0,
    waiting: 1,
    today: 2,
    inbox: 3,
    done_recently: 4,
  } satisfies Record<ReturnType<typeof bucketFor>, number>
  return order[bucketFor(signal)]
}

function statusLabel(status: OperationsSignalStatus) {
  if (status === "waiting") return "waiting"
  if (status === "deferred") return "deferred"
  if (status === "handled") return "handled"
  return "open"
}

function sourceHealthClass(state: OperationsSourceHealth["state"]) {
  if (state === "healthy") return "border-success/30 bg-success/10 text-success"
  if (state === "syncing") return "border-frost/30 bg-frost/10 text-frost"
  if (state === "attention") return "border-warning/35 bg-warning/10 text-warning"
  return "border-destructive/25 bg-destructive/10 text-destructive"
}

function readableAge(value?: string) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function sourceFreshness(source: OperationsSourceHealth) {
  const checked = readableAge(source.checkedAt)
  if (checked) return `checked ${checked}`
  if (source.state === "syncing") return "checking now"
  if (source.state === "disconnected") return "not connected"
  return "not checked"
}

function matchSignal(signal: OperationsSignal, search: string) {
  if (!search.trim()) return true
  const haystack = [
    signal.title,
    signal.summary,
    signal.person,
    signal.business,
    signal.evidence,
    signal.nextAction,
    signal.suggestedReply,
    signal.source,
    signal.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return haystack.includes(search.toLowerCase())
}

export function UnifiedOperationsHub({
  userId,
  view,
  onViewChange,
  signals,
  sourceHealth,
  onStatusChange,
  onOpenTextCommand,
  onAwaken,
  learningEvents = [],
  pendingSummary,
  scanRefreshing = false,
  onRefreshScan,
}: UnifiedOperationsHubProps) {
  const [search, setSearch] = useState("")
  const [learningOpen, setLearningOpen] = useState(false)
  const activeSignals = useMemo(
    () =>
      signals
        .filter((signal) => signal.category !== "quiet" && signal.category !== "routine")
        .sort((a, b) => signalRank(a) - signalRank(b)),
    [signals]
  )
  const counts = useMemo(() => {
    return {
      needs_peter:
        pendingSummary?.needs_peter ??
        activeSignals.filter((signal) => bucketFor(signal) === "needs_peter").length,
      waiting:
        pendingSummary?.waiting_on_others ??
        activeSignals.filter((signal) => bucketFor(signal) === "waiting").length,
      today:
        pendingSummary?.today ??
        activeSignals.filter((signal) => bucketFor(signal) === "today").length,
      done_recently:
        pendingSummary?.done_recently ??
        activeSignals.filter((signal) => bucketFor(signal) === "done_recently").length,
      inbox: activeSignals.filter((signal) => signal.status === "open" || signal.status === "waiting").length,
    }
  }, [activeSignals, pendingSummary])

  return (
    <section className="glass-card rounded-lg p-4">
      <header className="flex flex-col gap-4 border-b border-border/60 pb-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div>
          <p className="label-track text-gold">Unified Operations Inbox</p>
          <h2 className="mt-2 font-display text-2xl text-foreground">
            One stream. Switch the lens.
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Slack, Gmail, Calendar, vitals, memory, rules, and research meet here.
            Time and weather stay in the top bar.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRefreshScan && (
            <button
              type="button"
              onClick={onRefreshScan}
              disabled={scanRefreshing}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-gold/45 bg-gold/10 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-gold transition hover:bg-gold/15 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw size={13} className={scanRefreshing ? "animate-spin" : ""} />
              Refresh ODIN Scan
            </button>
          )}
          {sourceHealth.map((source) => (
            <span
              key={source.id}
              title={`${source.detail} · ${sourceFreshness(source)}`}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider",
                sourceHealthClass(source.state)
              )}
            >
              {source.label}: {source.state}
              {source.checkedAt && (
                <span className="ml-1 opacity-75">
                  · {readableAge(source.checkedAt)}
                </span>
              )}
            </span>
          ))}
        </div>
      </header>

      {learningEvents.length > 0 && (
        <div className="mt-4 rounded-md border border-border/60 bg-background/25">
          <button
            type="button"
            onClick={() => setLearningOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
          >
            <span>
              <span className="label-track text-gold">Learned Recently</span>
              <span className="ml-3 text-xs text-muted-foreground">
                {learningEvents.length} automatic update{learningEvents.length === 1 ? "" : "s"}
              </span>
            </span>
            <span className="text-xs uppercase tracking-[0.18em] text-tertiary">
              {learningOpen ? "Hide" : "Show"}
            </span>
          </button>
          {learningOpen && (
            <div className="grid gap-2 border-t border-border/50 p-3 md:grid-cols-2">
              {learningEvents.slice(0, 4).map((event) => (
                <div
                  key={event.id}
                  className="rounded border border-border/50 bg-card/45 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">
                      {event.event_type}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-tertiary">
                      {readableAge(event.created_at) ?? "recent"}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {event.summary}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
        <nav className="flex gap-2 overflow-x-auto pb-1">
          {(Object.keys(VIEW_CONFIG) as UnifiedHubView[]).map((key) => {
            const config = VIEW_CONFIG[key]
            const Icon = config.icon
            const count =
              key === "priority"
                ? counts.needs_peter + counts.waiting
                : key === "today"
                  ? counts.today
                  : key === "inbox"
                    ? counts.inbox
                    : key === "memory" || key === "rules" || key === "research"
                      ? null
                      : counts.done_recently
            return (
              <button
                key={key}
                type="button"
                onClick={() => onViewChange(key)}
                className={cn(
                  "inline-flex h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-xs font-semibold uppercase tracking-wider transition",
                  view === key
                    ? "border-gold/60 bg-gold/12 text-gold"
                    : "border-border/60 bg-background/30 text-tertiary hover:border-gold/35 hover:text-foreground"
                )}
              >
                <Icon size={14} />
                {config.label}
                {typeof count === "number" && (
                  <span className="rounded-full border border-current/25 px-1.5 py-0.5 text-[10px]">
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
        <label className="relative min-w-0 2xl:w-[360px]">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary"
          />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search unified inbox..."
            className="h-10 w-full rounded-md border border-border/70 bg-background/50 pl-9 pr-3 text-sm text-foreground outline-none transition placeholder:text-tertiary focus:border-gold/60"
          />
        </label>
      </div>

      <p className="mt-3 text-[11px] text-tertiary">
        {VIEW_CONFIG[view].description}
      </p>

      <div className="mt-4">
        {view === "priority" && (
          <PriorityBoard
            signals={activeSignals.filter((signal) => matchSignal(signal, search))}
            counts={counts}
            onStatusChange={onStatusChange}
            onOpenTextCommand={onOpenTextCommand}
          />
        )}
        {view === "inbox" && (
          <SignalList
            signals={activeSignals
              .filter((signal) => signal.status === "open" || signal.status === "waiting")
              .filter((signal) => matchSignal(signal, search))}
            emptyText="No open inbox items match this search."
            onStatusChange={onStatusChange}
            onOpenTextCommand={onOpenTextCommand}
          />
        )}
        {view === "today" && (
          <SignalList
            signals={activeSignals
              .filter((signal) => bucketFor(signal) === "today")
              .filter((signal) => matchSignal(signal, search))}
            emptyText="No time-bound commitments match this search."
            onStatusChange={onStatusChange}
            onOpenTextCommand={onOpenTextCommand}
          />
        )}
        {view === "research" && (
          <ResearchPanel onAwaken={onAwaken} onOpenTextCommand={onOpenTextCommand} />
        )}
        {view === "memory" && (
          <MemoryPanel userId={userId} search={search} />
        )}
        {view === "rules" && (
          <RulesPanel userId={userId} search={search} />
        )}
      </div>
    </section>
  )
}

function PriorityBoard({
  signals,
  counts,
  onStatusChange,
  onOpenTextCommand,
}: {
  signals: OperationsSignal[]
  counts: {
    needs_peter: number
    waiting: number
    today: number
    done_recently: number
    inbox: number
  }
  onStatusChange: (id: string, status: OperationsSignalStatus) => void
  onOpenTextCommand: (draft?: string) => void
}) {
  const groups = [
    {
      id: "needs_peter",
      title: "Needs Peter",
      helper: "Decisions, replies, approvals.",
      signals: signals.filter((signal) => bucketFor(signal) === "needs_peter"),
      count: counts.needs_peter,
    },
    {
      id: "waiting",
      title: "Waiting",
      helper: "Blocked by someone else.",
      signals: signals.filter((signal) => bucketFor(signal) === "waiting"),
      count: counts.waiting,
    },
    {
      id: "today",
      title: "Today",
      helper: "Meetings, deadlines, time-bound items.",
      signals: signals.filter((signal) => bucketFor(signal) === "today"),
      count: counts.today,
    },
    {
      id: "done_recently",
      title: "Done recently",
      helper: "Handled or deferred. Restore if ODIN was wrong.",
      signals: signals.filter((signal) => bucketFor(signal) === "done_recently"),
      count: counts.done_recently,
    },
  ]

  return (
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
      {groups.map((group) => (
        <div
          key={group.id}
          className="min-h-[220px] rounded-lg border border-border/60 bg-background/20 p-3"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold">
                {group.title}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-tertiary">
                {group.helper}
              </p>
            </div>
            <span className="rounded border border-border/70 px-1.5 py-0.5 font-mono-data text-xs text-foreground">
              {group.count}
            </span>
          </div>
          <SignalList
            signals={group.signals.slice(0, 4)}
            dense
            emptyText={
              group.id === "done_recently"
                ? "Nothing closed in the current view."
                : "Nothing here."
            }
            onStatusChange={onStatusChange}
            onOpenTextCommand={onOpenTextCommand}
          />
        </div>
      ))}
    </div>
  )
}

function SignalList({
  signals,
  emptyText,
  dense = false,
  onStatusChange,
  onOpenTextCommand,
}: {
  signals: OperationsSignal[]
  emptyText: string
  dense?: boolean
  onStatusChange: (id: string, status: OperationsSignalStatus) => void
  onOpenTextCommand: (draft?: string) => void
}) {
  if (signals.length === 0) {
    return (
      <div className="rounded-md border border-success/20 bg-success/10 px-3 py-4 text-sm text-success">
        {emptyText}
      </div>
    )
  }

  return (
    <ul className={cn("space-y-2", dense && "space-y-2")}>
      {signals.map((signal) => (
        <li key={signal.id}>
          <SignalCard
            signal={signal}
            dense={dense}
            onStatusChange={onStatusChange}
            onOpenTextCommand={onOpenTextCommand}
          />
        </li>
      ))}
    </ul>
  )
}

function SignalCard({
  signal,
  dense,
  onStatusChange,
  onOpenTextCommand,
}: {
  signal: OperationsSignal
  dense?: boolean
  onStatusChange: (id: string, status: OperationsSignalStatus) => void
  onOpenTextCommand: (draft?: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const isClosed = signal.status === "handled" || signal.status === "deferred"
  const route = signal.sourceUrl ?? SOURCE_ROUTE[signal.source]

  async function copyText() {
    const text = signal.suggestedReply ?? signal.nextAction ?? signal.summary
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <article
      className={cn(
        "rounded-md border border-border/60 bg-card/55 p-3",
        isClosed && "opacity-70"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-gold/30 bg-gold/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
          {SOURCE_LABEL[signal.source]}
        </span>
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-tertiary">
          {bucketFor(signal).replace("_", " ")}
        </span>
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-tertiary">
          {statusLabel(signal.status)}
        </span>
        {signal.business && (
          <span className="ml-auto text-[10px] text-tertiary">
            {signal.business}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm font-semibold text-foreground">
        {signal.title}
      </p>
      <p
        className={cn(
          "mt-1 text-xs leading-relaxed text-muted-foreground",
          dense ? "line-clamp-3" : "line-clamp-2"
        )}
      >
        {signal.summary}
      </p>
      {signal.nextAction && (
        <p className="mt-2 rounded border border-gold/20 bg-gold/10 px-2 py-1.5 text-xs font-medium leading-relaxed text-gold">
          {signal.nextAction}
        </p>
      )}
      {(signal.evidence || signal.dueAt) && (
        <p className="mt-2 text-[11px] text-tertiary">
          {[signal.evidence, readableAge(signal.dueAt)].filter(Boolean).join(" · ")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {isClosed ? (
          <button
            type="button"
            onClick={() => onStatusChange(signal.id, "open")}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-gold/45 hover:text-gold"
          >
            <RotateCcw size={11} />
            Restore
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onStatusChange(signal.id, "handled")}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-success/45 hover:text-success"
            >
              <CheckCircle2 size={11} />
              Handled
            </button>
            <button
              type="button"
              onClick={() => onStatusChange(signal.id, "waiting")}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-frost/45 hover:text-frost"
            >
              <Clock3 size={11} />
              Waiting
            </button>
            <button
              type="button"
              onClick={() => onStatusChange(signal.id, "deferred")}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-warning/45 hover:text-warning"
            >
              <Archive size={11} />
              Defer
            </button>
          </>
        )}
        <button
          type="button"
          onClick={copyText}
          className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-gold/45 hover:text-gold"
        >
          <Copy size={11} />
          {copied ? "Copied" : "Copy"}
        </button>
        {signal.suggestedReply && (
          <button
            type="button"
            onClick={() => onOpenTextCommand(signal.suggestedReply)}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-gold/45 hover:text-gold"
          >
            <Sparkles size={11} />
            Draft
          </button>
        )}
        {route.startsWith("http") ? (
          <a
            href={route}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-gold/45 hover:text-gold"
          >
            <ExternalLink size={11} />
            Open
          </a>
        ) : (
          <Link
            to={route}
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-gold/45 hover:text-gold"
          >
            <ExternalLink size={11} />
            Open
          </Link>
        )}
      </div>
    </article>
  )
}

function ResearchPanel({
  onAwaken,
  onOpenTextCommand,
}: {
  onAwaken: () => void
  onOpenTextCommand: (draft?: string) => void
}) {
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OdinCommandResponse | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError(null)
    try {
      const response = await invokeOdinCommand({
        query: trimmed,
        source: "text",
        timezone: "Asia/Manila",
        mode: "research",
        tone: "standard",
        visiblePage: "/dashboard",
        conversationId: "dashboard-research",
      })
      setResult(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Research failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <form onSubmit={submit} className="rounded-lg border border-border/60 bg-background/25 p-4">
        <p className="label-track text-gold">Research Mode</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Paste a URL, topic, vendor question, policy issue, or operating problem.
          ODIN will summarize, save the useful trail on screen, and suggest the next move.
        </p>
        <textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Research this: vendor deposit rules, guest complaint policy, owner approval threshold..."
          className="mt-4 min-h-[150px] w-full resize-none rounded-md border border-border/70 bg-background/55 p-3 text-sm text-foreground outline-none placeholder:text-tertiary focus:border-gold/60"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-gold/45 bg-gold/10 px-4 text-xs font-bold uppercase tracking-wider text-gold transition hover:bg-gold/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileSearch size={14} />
            {loading ? "Researching" : "Run Research"}
          </button>
          <button
            type="button"
            onClick={onAwaken}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border/70 px-4 text-xs font-bold uppercase tracking-wider text-tertiary transition hover:border-gold/45 hover:text-gold"
          >
            <Sparkles size={14} />
            Ask by voice
          </button>
        </div>
      </form>
      <div className="rounded-lg border border-border/60 bg-card/45 p-4">
        <p className="label-track text-foreground">Research Output</p>
        {error ? (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : !result ? (
          <p className="mt-3 text-sm text-tertiary">
            No research run yet.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
              {result.displayText}
            </p>
            {result.sourceLinks.length > 0 && (
              <div className="rounded-md border border-border/60 bg-background/30 p-3">
                <p className="label-track text-[10px] text-gold">Sources</p>
                <ul className="mt-2 space-y-1">
                  {result.sourceLinks.slice(0, 5).map((link) => (
                    <li key={`${link.source}-${link.url}`}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-frost underline underline-offset-4 hover:text-foreground"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {result.suggestions.slice(0, 3).map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => onOpenTextCommand(suggestion)}
                    className="rounded-full border border-border/70 px-3 py-1.5 text-xs text-tertiary transition hover:border-gold/45 hover:text-gold"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const MEMORY_KINDS: OdinMemoryKind[] = [
  "person",
  "business",
  "preference",
  "priority",
  "routine",
  "source",
  "other",
]

function MemoryPanel({ userId, search }: { userId?: string; search: string }) {
  const [memories, setMemories] = useState<OdinMemory[]>([])
  const [kind, setKind] = useState<OdinMemoryKind>("person")
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    if (!userId) return
    setLoading(true)
    setError(null)
    try {
      setMemories(await listOdinMemories(userId))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load ODIN memory")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!userId || !title.trim() || !content.trim()) return
    setLoading(true)
    setError(null)
    try {
      await createOdinMemory({
        userId,
        kind,
        title: title.trim(),
        content: content.trim(),
      })
      setTitle("")
      setContent("")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save memory")
    } finally {
      setLoading(false)
    }
  }

  async function archive(id: string) {
    setError(null)
    try {
      await archiveOdinMemory(id)
      setMemories((rows) => rows.filter((row) => row.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive memory")
    }
  }

  const filtered = memories.filter((memory) => {
    if (!search.trim()) return true
    return `${memory.kind} ${memory.title} ${memory.content}`
      .toLowerCase()
      .includes(search.toLowerCase())
  })

  return (
    <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
      <form onSubmit={submit} className="rounded-lg border border-border/60 bg-background/25 p-4">
        <p className="label-track text-gold">Manual Context</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Add durable facts ODIN should use when interpreting Slack, Gmail, calendar,
          and voice conversations.
        </p>
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as OdinMemoryKind)}
          className="mt-4 h-10 w-full rounded-md border border-border/70 bg-background/55 px-3 text-sm text-foreground outline-none focus:border-gold/60"
        >
          {MEMORY_KINDS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Meredith Garrett"
          className="mt-2 h-10 w-full rounded-md border border-border/70 bg-background/55 px-3 text-sm text-foreground outline-none placeholder:text-tertiary focus:border-gold/60"
        />
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Ops/owner decisions; flag replies from Meredith as high-context."
          className="mt-2 min-h-[110px] w-full resize-none rounded-md border border-border/70 bg-background/55 p-3 text-sm text-foreground outline-none placeholder:text-tertiary focus:border-gold/60"
        />
        <button
          type="submit"
          disabled={!userId || loading || !title.trim() || !content.trim()}
          className="mt-3 inline-flex h-10 items-center gap-2 rounded-md border border-gold/45 bg-gold/10 px-4 text-xs font-bold uppercase tracking-wider text-gold transition hover:bg-gold/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={14} />
          Remember
        </button>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </form>
      <MemoryList
        memories={filtered}
        loading={loading}
        emptyText="No manual context saved yet."
        onArchive={archive}
      />
    </div>
  )
}

function RulesPanel({ userId, search }: { userId?: string; search: string }) {
  const [rule, setRule] = useState("")
  const [memories, setMemories] = useState<OdinMemory[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const suggestions = [
    "Always flag Meredith Garrett for owner or operations decisions.",
    "Ignore promotional Gmail unless I explicitly ask for a broad search.",
    "Default Gmail triage to the last 7 days.",
    "Flag guest, owner, vendor, finance, maintenance, and calendar invite issues.",
  ]

  async function load() {
    if (!userId) return
    setLoading(true)
    setError(null)
    try {
      const rows = await listOdinMemories(userId)
      setMemories(rows.filter((row) => row.kind === "priority"))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load rules")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  async function addRule(text = rule) {
    if (!userId || !text.trim()) return
    setLoading(true)
    setError(null)
    try {
      await createOdinMemory({
        userId,
        kind: "priority",
        title: text.trim().slice(0, 56),
        content: text.trim(),
      })
      setRule("")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save rule")
    } finally {
      setLoading(false)
    }
  }

  async function archive(id: string) {
    try {
      await archiveOdinMemory(id)
      setMemories((rows) => rows.filter((row) => row.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive rule")
    }
  }

  const filtered = memories.filter((memory) => {
    if (!search.trim()) return true
    return `${memory.title} ${memory.content}`.toLowerCase().includes(search.toLowerCase())
  })

  return (
    <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void addRule()
        }}
        className="rounded-lg border border-border/60 bg-background/25 p-4"
      >
        <p className="label-track text-gold">Rules Engine</p>
        <p className="mt-2 text-sm text-muted-foreground">
          These rules are saved into ODIN memory as priority facts, so the
          backend can use them while reasoning.
        </p>
        <textarea
          value={rule}
          onChange={(event) => setRule(event.target.value)}
          placeholder="Always flag..."
          className="mt-4 min-h-[110px] w-full resize-none rounded-md border border-border/70 bg-background/55 p-3 text-sm text-foreground outline-none placeholder:text-tertiary focus:border-gold/60"
        />
        <button
          type="submit"
          disabled={!userId || loading || !rule.trim()}
          className="mt-3 inline-flex h-10 items-center gap-2 rounded-md border border-gold/45 bg-gold/10 px-4 text-xs font-bold uppercase tracking-wider text-gold transition hover:bg-gold/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ShieldCheck size={14} />
          Save Rule
        </button>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        <div className="mt-4 space-y-2">
          <p className="label-track text-[10px] text-tertiary">Suggested rules</p>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => void addRule(suggestion)}
              className="block w-full rounded-md border border-border/60 bg-background/25 px-3 py-2 text-left text-xs text-muted-foreground transition hover:border-gold/40 hover:text-foreground"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </form>
      <MemoryList
        memories={filtered}
        loading={loading}
        emptyText="No priority rules saved yet."
        onArchive={archive}
      />
    </div>
  )
}

function MemoryList({
  memories,
  loading,
  emptyText,
  onArchive,
}: {
  memories: OdinMemory[]
  loading: boolean
  emptyText: string
  onArchive: (id: string) => void
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/45 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="label-track text-foreground">Saved Context</p>
        {loading && <RefreshCw size={13} className="animate-spin text-frost" />}
      </div>
      {memories.length === 0 ? (
        <p className="rounded-md border border-border/60 bg-background/30 px-3 py-4 text-sm text-tertiary">
          {emptyText}
        </p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {memories.map((memory) => (
            <li
              key={memory.id}
              className="rounded-md border border-border/60 bg-background/25 p-3"
            >
              <div className="flex items-center gap-2">
                <span className="rounded border border-gold/30 bg-gold/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
                  {memory.kind}
                </span>
                <span className="ml-auto text-[10px] text-tertiary">
                  {new Date(memory.updated_at).toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {memory.title}
              </p>
              <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                {memory.content}
              </p>
              <button
                type="button"
                onClick={() => onArchive(memory.id)}
                className="mt-3 inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-destructive/45 hover:text-destructive"
              >
                <Archive size={11} />
                Archive
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

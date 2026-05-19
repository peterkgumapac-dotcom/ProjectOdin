import {
  CalendarDays,
  CheckCircle2,
  FileSearch,
  Inbox,
  ListChecks,
  MessageSquare,
  Mic2,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { UnifiedHubView } from "@/components/dashboard/UnifiedOperationsHub"
import type {
  OperationsSignal,
  OperationsSignalStatus,
  OperationsSourceHealth,
} from "@/types/operations"

interface OdinCommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  signals: OperationsSignal[]
  sourceHealth: OperationsSourceHealth[]
  onViewChange: (view: UnifiedHubView) => void
  onOpenTextCommand: (draft?: string) => void
  onAwaken: () => void
  onStatusChange: (id: string, status: OperationsSignalStatus) => void
}

interface PaletteAction {
  id: string
  label: string
  detail: string
  keywords: string
  icon: typeof Search
  run: () => void
}

const VIEW_ACTIONS: Array<{
  view: UnifiedHubView
  label: string
  detail: string
  icon: typeof Search
  keywords: string
}> = [
  {
    view: "priority",
    label: "Open Priority Queue",
    detail: "Needs Peter, waiting, today, and done recently.",
    icon: ListChecks,
    keywords: "priority queue needs peter waiting today done",
  },
  {
    view: "inbox",
    label: "Open Unified Inbox",
    detail: "All open signals in one stream.",
    icon: Inbox,
    keywords: "inbox unified search all signals gmail slack",
  },
  {
    view: "today",
    label: "Open Today",
    detail: "Calendar, commitments, follow-ups.",
    icon: CalendarDays,
    keywords: "today calendar schedule meetings commitments",
  },
  {
    view: "research",
    label: "Open Research Mode",
    detail: "Paste a link or topic for ODIN to process.",
    icon: FileSearch,
    keywords: "research investigate summarize link topic",
  },
  {
    view: "memory",
    label: "Open Memory",
    detail: "People, roles, businesses, properties, preferences.",
    icon: Sparkles,
    keywords: "memory context people roles business property preference",
  },
  {
    view: "rules",
    label: "Open Rules",
    detail: "Flag, mute, and priority rules.",
    icon: Settings2,
    keywords: "rules always flag ignore gmail days",
  },
]

function signalText(signal: OperationsSignal) {
  return [
    signal.title,
    signal.summary,
    signal.person,
    signal.business,
    signal.evidence,
    signal.nextAction,
    signal.source,
    signal.category,
    signal.status,
  ]
    .filter(Boolean)
    .join(" ")
}

function sourceRoute(source: OperationsSignal["source"]) {
  if (source === "slack") return "/council"
  if (source === "calendar") return "/calendar"
  if (source === "gmail" || source === "health" || source === "system") return "/connections"
  return "/dashboard?portal=open"
}

function sourceCheckedLabel(value?: string) {
  if (!value) return "not checked"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "not checked"
  return `checked ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
}

export function OdinCommandPalette({
  open,
  onOpenChange,
  signals,
  sourceHealth,
  onViewChange,
  onOpenTextCommand,
  onAwaken,
  onStatusChange,
}: OdinCommandPaletteProps) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState("")
  const normalized = query.trim().toLowerCase()

  useEffect(() => {
    if (!open) return
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(timeout)
  }, [open])

  useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const actions = useMemo<PaletteAction[]>(() => {
    const close = () => onOpenChange(false)
    const base: PaletteAction[] = [
      {
        id: "talk",
        label: "Talk to ODIN",
        detail: "Start the voice session from the Eye.",
        keywords: "voice talk speak odin microphone",
        icon: Mic2,
        run: () => {
          close()
          onAwaken()
        },
      },
      {
        id: "ask",
        label: "Ask ODIN",
        detail: "Open the text assistant.",
        keywords: "chat ask text command assistant",
        icon: MessageSquare,
        run: () => {
          close()
          onOpenTextCommand()
        },
      },
      {
        id: "council",
        label: "Open Slack Scan",
        detail: "Deep Slack and DM workspace.",
        keywords: "slack council dm scan",
        icon: MessageSquare,
        run: () => {
          close()
          navigate("/council")
        },
      },
      ...VIEW_ACTIONS.map((action) => ({
        id: `view-${action.view}`,
        label: action.label,
        detail: action.detail,
        keywords: action.keywords,
        icon: action.icon,
        run: () => {
          close()
          onViewChange(action.view)
        },
      })),
    ]
    return base
  }, [navigate, onAwaken, onOpenChange, onOpenTextCommand, onViewChange])

  const filteredActions = actions
    .filter((action) => {
      if (!normalized) return true
      return `${action.label} ${action.detail} ${action.keywords}`
        .toLowerCase()
        .includes(normalized)
    })
    .slice(0, 8)

  const filteredSignals = signals
    .filter((signal) => signal.category !== "quiet" && signal.category !== "routine")
    .filter((signal) => {
      if (!normalized) return signal.status === "open" || signal.status === "waiting"
      return signalText(signal).toLowerCase().includes(normalized)
    })
    .slice(0, 8)

  const sourceProblems = sourceHealth.filter(
    (source) => source.state === "attention" || source.state === "disconnected"
  )

  function runFirstResult() {
    if (filteredActions[0]) {
      filteredActions[0].run()
      return
    }
    if (filteredSignals[0]) {
      onOpenChange(false)
      const route = filteredSignals[0].sourceUrl ?? sourceRoute(filteredSignals[0].source)
      if (route.startsWith("http")) window.open(route, "_blank", "noopener,noreferrer")
      else navigate(route)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[min(760px,calc(100vh-3rem))] w-[min(920px,calc(100vw-2rem))] max-w-none overflow-hidden border border-border/80 bg-card/95 p-0 shadow-[0_30px_120px_rgba(0,0,0,0.55)]"
      >
        <div className="border-b border-border/70 p-4">
          <DialogTitle className="font-display text-xl text-gold">
            Search ODIN
          </DialogTitle>
          <DialogDescription>
            Commands, signals, source health, memory, rules, and research. Press Enter to open the first result.
          </DialogDescription>
          <label className="relative mt-4 block">
            <Search
              size={18}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  runFirstResult()
                }
              }}
              placeholder="Search or run a command..."
              className="h-12 w-full rounded-lg border border-border/70 bg-background/55 pl-10 pr-4 text-base text-foreground outline-none placeholder:text-tertiary focus:border-gold/60"
            />
          </label>
        </div>

        <div className="grid max-h-[560px] min-h-0 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
          <section className="min-h-0 overflow-y-auto border-b border-border/60 p-4 lg:border-b-0 lg:border-r">
            <p className="label-track text-gold">Commands</p>
            <div className="mt-3 space-y-2">
              {filteredActions.map((action) => {
                const Icon = action.icon
                return (
                  <button
                    key={action.id}
                    type="button"
                    onClick={action.run}
                    className="flex w-full items-center gap-3 rounded-md border border-border/60 bg-background/25 px-3 py-2 text-left transition hover:border-gold/45 hover:bg-gold/10"
                  >
                    <Icon size={15} className="text-gold" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-foreground">
                        {action.label}
                      </span>
                      <span className="block truncate text-xs text-tertiary">
                        {action.detail}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="mt-5 rounded-md border border-border/60 bg-background/25 p-3">
              <p className="label-track text-[10px] text-tertiary">Source Health</p>
              <div className="mt-2 space-y-1.5">
                {sourceHealth.map((source) => (
                  <div
                    key={source.id}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-muted-foreground">{source.label}</span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[10px] text-tertiary">
                        {sourceCheckedLabel(source.checkedAt)}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider",
                          source.state === "healthy"
                            ? "border-success/30 text-success"
                            : source.state === "syncing"
                              ? "border-frost/30 text-frost"
                              : source.state === "attention"
                                ? "border-warning/30 text-warning"
                                : "border-destructive/35 text-destructive"
                        )}
                        title={source.detail}
                      >
                        {source.state}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              {sourceProblems.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false)
                    navigate("/connections")
                  }}
                  className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-gold hover:text-foreground"
                >
                  Repair sources
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          </section>

          <section className="min-h-0 overflow-y-auto p-4">
            <p className="label-track text-gold">Signals</p>
            {filteredSignals.length === 0 ? (
              <p className="mt-3 rounded-md border border-success/20 bg-success/10 px-3 py-4 text-sm text-success">
                No matching active signals.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {filteredSignals.map((signal) => (
                  <li
                    key={signal.id}
                    className="rounded-md border border-border/60 bg-background/25 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded border border-gold/30 bg-gold/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
                        {signal.source}
                      </span>
                      <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-tertiary">
                        {signal.status}
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
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {signal.summary}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false)
                          const route = signal.sourceUrl ?? sourceRoute(signal.source)
                          if (route.startsWith("http")) window.open(route, "_blank", "noopener,noreferrer")
                          else navigate(route)
                        }}
                        className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-gold/45 hover:text-gold"
                      >
                        Open
                      </button>
                      {signal.status === "handled" || signal.status === "deferred" ? (
                        <button
                          type="button"
                          onClick={() => onStatusChange(signal.id, "open")}
                          className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-gold/45 hover:text-gold"
                        >
                          <RotateCcw size={11} />
                          Restore
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onStatusChange(signal.id, "handled")}
                          className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary transition hover:border-success/45 hover:text-success"
                        >
                          <CheckCircle2 size={11} />
                          Handled
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

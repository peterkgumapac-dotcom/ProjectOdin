import { Activity, Cloud, Eye, Mail, MessageSquare, RefreshCw, Sparkles } from "lucide-react"
import type {
  OperationsSignal,
  OperationsSourceHealth,
} from "@/types/operations"

interface OperationsBriefProps {
  signals: OperationsSignal[]
  sourceHealth: OperationsSourceHealth[]
  loading: boolean
  onAwaken: () => void
}

const CATEGORY_LABELS = {
  urgent: "Now",
  today: "Today",
  waiting: "Waiting",
  follow_up: "Follow-up",
  routine: "Routine",
  quiet: "Quiet",
} satisfies Record<OperationsSignal["category"], string>

const SOURCE_ICON = {
  gmail: Mail,
  slack: MessageSquare,
  calendar: Activity,
  health: Activity,
  browser: Eye,
  manual: Sparkles,
  memory: Sparkles,
  research: Sparkles,
  weather: Cloud,
  system: RefreshCw,
} satisfies Record<OperationsSignal["source"], typeof Mail>

function stateClass(state: OperationsSourceHealth["state"]): string {
  if (state === "healthy") return "border-success/30 text-success bg-success/10"
  if (state === "syncing") return "border-frost/30 text-frost bg-frost/10"
  if (state === "attention") return "border-warning/30 text-warning bg-warning/10"
  return "border-border/70 text-tertiary bg-background/30"
}

function checkedLabel(value?: string) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

export function OperationsBrief({
  signals,
  sourceHealth,
  loading,
  onAwaken,
}: OperationsBriefProps) {
  const active = signals.filter(
    (signal) => signal.status === "open" || signal.status === "waiting"
  )
  const counts = {
    urgent: active.filter((signal) => signal.category === "urgent").length,
    today: active.filter((signal) => signal.category === "today").length,
    waiting: active.filter(
      (signal) => signal.status === "waiting" || signal.category === "waiting"
    ).length,
    quiet: active.filter((signal) => signal.category === "quiet").length,
  }
  const leadSignals = active
    .filter((signal) => signal.category !== "routine")
    .sort((a, b) => {
      const order = {
        urgent: 0,
        today: 1,
        waiting: 2,
        follow_up: 3,
        routine: 4,
        quiet: 5,
      } satisfies Record<OperationsSignal["category"], number>
      return order[a.category] - order[b.category]
    })
    .slice(0, 1)
  const lead = leadSignals[0]
  const actionCount = counts.urgent + counts.waiting + active.filter(
    (signal) => signal.category === "follow_up"
  ).length
  const connectedSources = sourceHealth.filter(
    (source) => source.state === "healthy" || source.state === "syncing"
  ).length

  return (
    <section className="glass-card rounded-lg p-5 h-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="label-track text-gold">Central Operations</p>
          <h1 className="mt-2 font-display text-2xl text-foreground">
            ODIN Brief
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            One calm readout. Actions live in the queue below.
          </p>
        </div>
        <button
          type="button"
          onClick={onAwaken}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-gold/40 bg-gold/10 px-4 text-xs font-semibold uppercase tracking-wider text-gold transition-colors hover:bg-gold/20"
        >
          <Eye size={14} />
          Awaken
        </button>
      </div>

      <div className="mt-5 grid grid-cols-4 gap-3">
        {[
          ["Needs me", actionCount],
          ["Today", counts.today],
          ["Sources", connectedSources],
          ["Quiet", counts.quiet],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-md border border-border/60 bg-background/25 px-3 py-2"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-tertiary">
              {label}
            </p>
            <p className="mt-1 font-mono-data text-xl text-foreground">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-5">
        {loading && !lead ? (
          <p className="rounded-md border border-frost/20 bg-frost/10 px-3 py-3 text-sm text-frost">
            Reading connected sources…
          </p>
        ) : !lead ? (
          <p className="rounded-md border border-success/20 bg-success/10 px-3 py-3 text-sm text-success">
            Nothing needs Peter at first glance.
          </p>
        ) : (
          <BriefLead signal={lead} />
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-border/60 pt-3">
        {sourceHealth.map((source) => (
          <span
            key={source.id}
            className={[
              "rounded-full border px-2.5 py-1 text-[10px] font-medium",
              stateClass(source.state),
            ].join(" ")}
            title={`${source.detail}${source.checkedAt ? ` · checked ${checkedLabel(source.checkedAt)}` : ""}`}
          >
            {source.label}: {source.state}
            {source.checkedAt && (
              <span className="ml-1 opacity-75">
                · {checkedLabel(source.checkedAt)}
              </span>
            )}
          </span>
        ))}
      </div>
    </section>
  )
}

function BriefLead({ signal }: { signal: OperationsSignal }) {
  const Icon = SOURCE_ICON[signal.source]
  return (
    <div className="rounded-md border border-border/60 bg-background/25 px-3 py-3">
      <div className="flex items-center gap-2">
        <Icon size={13} className="text-gold" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-gold">
          Top signal
        </span>
        <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-tertiary">
          {CATEGORY_LABELS[signal.category]}
        </span>
        {signal.business && (
          <span className="ml-auto rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-tertiary">
            {signal.business}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm font-semibold text-foreground">
        {signal.title}
      </p>
      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {signal.summary}
      </p>
    </div>
  )
}

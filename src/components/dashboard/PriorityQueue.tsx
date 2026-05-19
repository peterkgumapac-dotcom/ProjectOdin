import { CheckCircle2, Clock3, Copy, ExternalLink } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import type {
  OperationsSignal,
  OperationsSignalStatus,
} from "@/types/operations"

interface PriorityQueueProps {
  signals: OperationsSignal[]
  onStatusChange: (id: string, status: OperationsSignalStatus) => void
}

const CATEGORY_STYLE = {
  urgent: "border-destructive/35 bg-destructive/10 text-destructive",
  today: "border-gold/35 bg-gold/10 text-gold",
  waiting: "border-frost/35 bg-frost/10 text-frost",
  follow_up: "border-warning/35 bg-warning/10 text-warning",
  routine: "border-border/60 bg-background/30 text-tertiary",
  quiet: "border-success/30 bg-success/10 text-success",
} satisfies Record<OperationsSignal["category"], string>

export function PriorityQueue({ signals, onStatusChange }: PriorityQueueProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const queue = useMemo(
    () =>
      signals
        .filter(
          (signal) =>
            signal.status === "open" &&
            signal.source !== "calendar" &&
            !["quiet", "routine"].includes(signal.category)
        )
        .slice(0, 3),
    [signals]
  )
  const handled = signals.filter((signal) => signal.status === "handled").length
  const deferred = signals.filter((signal) => signal.status === "deferred").length

  async function copyText(signal: OperationsSignal) {
    const text = signal.suggestedReply ?? signal.nextAction ?? signal.summary
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(signal.id)
      window.setTimeout(() => setCopiedId(null), 1200)
    } catch {
      setCopiedId(null)
    }
  }

  return (
    <section className="glass-card rounded-lg p-4 h-full">
      <header className="mb-4 flex items-center justify-between border-l-2 border-gold pl-3">
        <div>
          <p className="font-display text-sm tracking-[0.2em] text-gold">
            Priority Queue
          </p>
          <p className="mt-0.5 text-[11px] text-tertiary">
            Only items that need a decision or reply
          </p>
        </div>
        {(handled > 0 || deferred > 0) && (
          <span className="text-[10px] text-tertiary">
            {handled} handled · {deferred} deferred
          </span>
        )}
      </header>

      {queue.length === 0 ? (
        <div className="rounded-md border border-success/20 bg-success/10 px-3 py-4">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 size={15} />
            <p className="text-sm font-semibold">No open priority signal.</p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Quiet signals and disconnected sources stay visible outside the queue.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {queue.map((signal) => (
            <li
              key={signal.id}
              className="rounded-md border border-border/60 bg-background/25 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={[
                    "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                    CATEGORY_STYLE[signal.category],
                  ].join(" ")}
                >
                  {signal.category.replace("_", " ")}
                </span>
                <span className="text-[11px] uppercase tracking-wider text-tertiary">
                  {signal.source}
                </span>
                {signal.business && (
                  <span className="ml-auto text-[11px] text-tertiary">
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
              {signal.nextAction && (
                <p className="mt-2 line-clamp-2 rounded border border-gold/20 bg-gold/10 px-2 py-1.5 text-xs font-medium leading-relaxed text-gold">
                  {signal.nextAction}
                </p>
              )}
              {signal.evidence && (
                <p className="mt-1 text-[11px] text-tertiary">
                  Evidence: {signal.evidence}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onStatusChange(signal.id, "handled")}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-tertiary transition-colors hover:border-success/40 hover:text-success"
                >
                  <CheckCircle2 size={11} />
                  Handled
                </button>
                <button
                  type="button"
                  onClick={() => onStatusChange(signal.id, "deferred")}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-tertiary transition-colors hover:border-frost/40 hover:text-frost"
                >
                  <Clock3 size={11} />
                  Defer
                </button>
                <button
                  type="button"
                  onClick={() => copyText(signal)}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-tertiary transition-colors hover:border-gold/40 hover:text-gold"
                >
                  <Copy size={11} />
                  {copiedId === signal.id ? "Copied" : "Copy"}
                </button>
                <Link
                  to={signal.source === "calendar" ? "/calendar" : signal.source === "slack" ? "/council" : "/connections"}
                  className="ml-auto inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-tertiary transition-colors hover:border-gold/40 hover:text-gold"
                >
                  <ExternalLink size={11} />
                  Open
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

import { Building2 } from "lucide-react"
import type { OperationsSignal } from "@/types/operations"

interface BusinessPulseProps {
  signals: OperationsSignal[]
}

export function BusinessPulse({ signals }: BusinessPulseProps) {
  const pulse = signals
    .filter(
      (signal) =>
        signal.status === "open" &&
        signal.business !== "Personal" &&
        signal.category !== "quiet"
    )
  const groups = pulse.reduce<
    Record<string, { total: number; urgent: number; today: number; waiting: number }>
  >((acc, signal) => {
    const business = signal.business ?? "Personal"
    acc[business] ??= { total: 0, urgent: 0, today: 0, waiting: 0 }
    acc[business].total += 1
    if (signal.category === "urgent") acc[business].urgent += 1
    if (signal.category === "today") acc[business].today += 1
    if (signal.category === "waiting") acc[business].waiting += 1
    return acc
  }, {})
  const rows = Object.entries(groups).slice(0, 3)

  return (
    <section className="glass-card rounded-lg p-4 h-full">
      <header className="mb-3 flex items-center gap-2">
        <Building2 size={15} className="text-frost" />
        <span className="label-track text-foreground">Business Pulse</span>
      </header>

      {pulse.length === 0 ? (
        <p className="rounded-md border border-success/20 bg-success/10 px-3 py-3 text-xs text-success">
          No guest, vendor, owner, or team signal is elevated on the dashboard.
        </p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-3">
          {rows.map(([business, counts]) => (
            <li
              key={business}
              className="rounded-md border border-border/60 bg-background/25 px-3 py-2"
            >
              <p className="text-[10px] font-bold uppercase tracking-wider text-frost">
                {business}
              </p>
              <p className="mt-1 font-mono-data text-xl text-foreground">
                {counts.total}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {counts.urgent} urgent · {counts.today} today · {counts.waiting} waiting
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

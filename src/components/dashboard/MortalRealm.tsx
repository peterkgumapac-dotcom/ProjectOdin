import { useState } from "react"
import { Activity, Check, Loader2 } from "lucide-react"
import type { CalendarEvent } from "@/lib/connectors/calendar"
import type { UseWithingsHealthResult } from "@/hooks/useWithingsHealth"
import {
  connectWithings,
  type WithingsHealthSummary,
} from "@/lib/connectors/withings"
import { Button } from "@/components/ui/button"

interface MortalRealmProps {
  events: CalendarEvent[]
  loading: boolean
  connected: boolean
  withingsHealth: UseWithingsHealthResult
}

interface HealthRecommendation {
  label: string
  text: string
}

function eventStart(event: CalendarEvent): Date | null {
  const raw = event.start?.dateTime ?? event.start?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function timeLabel(date: Date | null): string {
  if (!date) return "All day"
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function shortDateLabel(value?: string | null): string | null {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function formatSleep(minutes?: number | null): string | null {
  if (!minutes) return null
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function relativeCheckedAt(value?: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function buildHealthRecommendations({
  summary,
  connected,
  loading,
}: {
  summary: WithingsHealthSummary | null
  connected: boolean
  loading: boolean
}) {
  if (!connected) {
    return [
      {
        label: "Connect",
        text: "Connect Withings so ODIN can coach recovery, movement, and heart context from real data.",
      },
    ]
  }

  if (loading) {
    return [
      {
        label: "Reading",
        text: "ODIN is pulling the latest health signals. Cached vitals stay visible while the refresh runs.",
      },
    ]
  }

  if (summary?.needsReconnect) {
    return [
      {
        label: "Reconnect",
        text: "Withings authorization expired. Reconnect once, then ODIN can read sleep, steps, calories, and heart again.",
      },
    ]
  }

  if (!summary) {
    return [
      {
        label: "Manual scan",
        text: "Withings is connected. Tap the tiny sync line only when you want ODIN to spend a health read.",
      },
    ]
  }

  if (summary.plan?.actionItems?.length) {
    return [
      {
        label: summary.plan.focus,
        text: `${summary.plan.summary} ${summary.plan.actionItems[0]}`,
      },
      ...summary.plan.actionItems.slice(1).map((item, index) => ({
        label: index === 0 ? "Next" : "Then",
        text: item,
      })),
    ].slice(0, 3)
  }

  const items: HealthRecommendation[] = []
  const sleepMinutes = summary.sleep.durationMinutes
  const steps = summary.steps.count
  const heart = summary.heartRate.bpm
  const calories = summary.calories.total ?? summary.calories.active

  if (typeof sleepMinutes === "number") {
    if (sleepMinutes < 300) {
      items.push({
        label: "Recovery",
        text: `You slept only ${formatSleep(sleepMinutes)}, sir. Keep decisions light and take a 20-minute nap if the day allows.`,
      })
    } else if (sleepMinutes < 420) {
      items.push({
        label: "Recovery",
        text: `${formatSleep(sleepMinutes)} is usable, sir, but not generous. Leave buffer before hard calls and protect bedtime tonight.`,
      })
    } else {
      items.push({
        label: "Recovery",
        text: `You slept ${formatSleep(sleepMinutes)}, sir. Use the clearer energy for focus work before the day gets noisy.`,
      })
    }
  }

  if (typeof steps === "number") {
    if (steps < 2500) {
      items.push({
        label: "Movement",
        text: `Movement is light at ${steps.toLocaleString()} steps. Step away for one quiet walk before the next ops block.`,
      })
    } else if (steps < 7000) {
      items.push({
        label: "Movement",
        text: `${steps.toLocaleString()} steps logged. One longer walk later would round out the day nicely, sir.`,
      })
    } else {
      items.push({
        label: "Movement",
        text: `${steps.toLocaleString()} steps logged. Movement is carrying its weight today; keep the pace steady.`,
      })
    }
  }

  if (typeof heart === "number") {
    const heartText =
      heart >= 100
        ? `Your pulse is elevated if resting, sir. Pause, breathe slowly, and treat symptoms as medical.`
        : heart >= 85
          ? `Your pulse is running high for deep work. Take two quiet minutes before the next heavy task.`
          : `Your pulse looks calm enough for focused work. Watch the trend, not just one reading.`
    items.push({ label: "Pulse", text: heartText })
  }

  if (typeof calories === "number" && items.length < 3) {
    items.push({
      label: "Fuel",
      text: `Fuel is logged. Pair the next push with water and a real meal window, sir.`,
    })
  }

  return items.slice(0, 3)
}

function formatMetric(
  value?: number | null,
  unit?: string,
  digits = 1
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const rounded = Number.isInteger(value) ? value.toString() : value.toFixed(digits)
  return unit ? `${rounded} ${unit}` : rounded
}

export function MortalRealm({
  events,
  loading,
  connected,
  withingsHealth,
}: MortalRealmProps) {
  const withings = withingsHealth
  const [connecting, setConnecting] = useState(false)
  const needsReconnect =
    !!withings.summary?.needsReconnect ||
    /reconnect|refresh_token|authorization expired/i.test(
      withings.error?.message ?? ""
    )
  const sleepDetail = [
    shortDateLabel(withings.summary?.sleep.date),
    typeof withings.summary?.sleep.wakeups === "number"
      ? `${withings.summary.sleep.wakeups} wakeups`
      : null,
  ].filter(Boolean).join(" · ")
  const stepsDetail = shortDateLabel(withings.summary?.steps.date) ?? "Today"
  const caloriesDetail =
    shortDateLabel(withings.summary?.calories?.date) ?? "Today"
  const body = withings.summary?.body
  const plan = withings.summary?.plan
  const syncedAt = relativeCheckedAt(withings.checkedAt)
  const syncStatus = withings.refreshing
    ? "Syncing quietly"
    : needsReconnect
      ? "Reconnect required"
      : withings.error
        ? "Sync needs attention · tap to retry"
        : withings.summary
          ? `Synced ${syncedAt ?? "recently"} · tap to update`
          : "Tap to sync Withings"
  const weightText = formatMetric(body?.weightKg.value, "kg")
  const bmiText = formatMetric(body?.bmi.value, undefined, 1)
  const bodyFatText = formatMetric(body?.fatRatioPct.value, "%")
  const workoutText =
    typeof withings.summary?.workouts?.recentCount === "number" &&
    withings.summary.workouts.recentCount > 0
      ? `${withings.summary.workouts.recentCount} recent`
      : null
  const bodyDetail = [
    bmiText ? `BMI ${bmiText}` : null,
    bodyFatText ? `fat ${bodyFatText}` : null,
    workoutText ? `${workoutText} workout${withings.summary?.workouts?.recentCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ")
  const fallbackRecommendations = buildHealthRecommendations({
    summary: withings.summary,
    connected: !!withings.account,
    loading: withings.loading,
  })
  const recommendations = fallbackRecommendations

  const rituals = [...events]
    .sort((a, b) => {
      const aStart = eventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER
      const bStart = eventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER
      return aStart - bStart
    })
    .slice(0, 5)

  return (
    <aside
      className="h-full min-h-0 w-full overflow-y-auto border-l border-border/60 bg-background/40 px-4 py-5 backdrop-blur-md scrollbar-thin"
      style={{ gridArea: "realm" }}
    >
      <div className="font-display tracking-[0.25em] text-gold text-xs">
        PERSONAL OPS
      </div>

      {/* Rituals */}
      <section className="glass-card rounded-lg p-3">
        <div className="label-track text-tertiary mb-3">Routines</div>
        <ul className="space-y-2">
          {loading ? (
            Array.from({ length: 4 }).map((_, index) => (
              <li key={index} className="flex items-center gap-2 text-xs animate-pulse">
                <span className="w-4 h-4 rounded-full border border-border bg-transparent shrink-0" />
                <span className="h-3 flex-1 rounded bg-tertiary/20" />
                <span className="h-3 w-10 rounded bg-tertiary/10" />
              </li>
            ))
          ) : !connected ? (
            <li className="text-xs text-tertiary">
              Connect Google Calendar to anchor routines to real events.
            </li>
          ) : rituals.length === 0 ? (
            <li className="text-xs text-tertiary">
              No routine is anchored to today yet.
            </li>
          ) : (
            rituals.map((event) => {
              const start = eventStart(event)
              const completed = false
              return (
                <li key={event.id} className="flex items-center gap-2 text-xs">
                  <span
                    className={[
                      "w-4 h-4 rounded-full border flex items-center justify-center shrink-0",
                      completed
                        ? "bg-gold border-gold text-background"
                        : "border-border bg-transparent",
                    ].join(" ")}
                  >
                    {completed && <Check size={10} />}
                  </span>
                  <span
                    className={[
                      "flex-1 truncate",
                      completed
                        ? "line-through text-tertiary"
                        : "text-foreground",
                    ].join(" ")}
                  >
                    {event.summary ?? "Untitled event"}
                  </span>
                  <span className="font-mono-data text-[10px] text-tertiary">
                    {event.sourceAccountLabel
                      ? `${timeLabel(start)} · ${event.sourceAccountLabel}`
                      : timeLabel(start)}
                  </span>
                </li>
              )
            })
          )}
        </ul>
      </section>

      {/* Personal source readiness */}
      <section className="glass-card rounded-lg p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="label-track text-tertiary">Health</div>
          {withings.account && (
            <span className="text-[10px] uppercase tracking-wider text-gold">
              Withings
            </span>
          )}
        </div>

        {withings.account ? (
          <div className="rounded-md border border-gold/30 bg-gold/[0.05] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="label-track text-gold">Withings</div>
                {needsReconnect ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {syncStatus}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void withings.refresh(true)}
                    disabled={withings.refreshing}
                    className="group mt-1 flex items-center gap-1.5 text-left text-[11px] text-muted-foreground transition hover:text-gold disabled:cursor-wait disabled:opacity-80"
                    aria-label="Sync Withings health data"
                    title="Sync Withings health data"
                  >
                    <span
                      className={[
                        "h-1.5 w-1.5 rounded-full transition",
                        withings.refreshing
                          ? "animate-pulse bg-gold"
                          : withings.error
                            ? "bg-destructive/80"
                            : "bg-gold/65 group-hover:bg-gold",
                      ].join(" ")}
                    />
                    <span>{syncStatus}</span>
                  </button>
                )}
              </div>
              {needsReconnect ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={connecting}
                  onClick={async () => {
                    setConnecting(true)
                    try {
                      await connectWithings()
                    } catch {
                      setConnecting(false)
                    }
                  }}
                  className="border border-gold/40 text-gold hover:bg-gold/10"
                >
                  {connecting ? "..." : "Reconnect"}
                </Button>
              ) : withings.refreshing ? (
                <Loader2 size={14} className="shrink-0 animate-spin text-gold/75" />
              ) : (
                <span className="h-2 w-2 shrink-0 rounded-full bg-gold/35" />
              )}
            </div>
            {withings.error && (
              <p className="mt-2 text-[11px] text-destructive">
                {withings.error.message}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-border/60 bg-background/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="label-track text-tertiary">Withings</div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Connect Withings for sleep, steps, calories, and heart rate.
                </p>
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={connecting}
                onClick={async () => {
                  setConnecting(true)
                  try {
                    await connectWithings()
                  } catch {
                    setConnecting(false)
                  }
                }}
                className="border border-gold/40 text-gold hover:bg-gold/10"
              >
                {connecting ? "..." : "Connect"}
              </Button>
            </div>
          </div>
        )}

        <HeartPulseIndicator
          bpm={withings.summary?.heartRate?.bpm ?? null}
          loading={withings.loading}
          refreshing={withings.refreshing}
          connected={!!withings.account}
        />

        <HealthCoach
          recommendations={recommendations}
          plan={plan}
        />

        <div className="grid grid-cols-2 gap-2">
          <HealthTile
            label="Body"
            className="col-span-2"
            connected={!!withings.account}
            loading={withings.loading}
            status={body?.status}
            value={weightText}
            emptyText="No weight/height"
            disconnectedText="Connect source"
            detail={bodyDetail || "Add height and weight in Withings for coaching."}
          />

          <HealthTile
            label="Sleep"
            connected={!!withings.account}
            loading={withings.loading}
            status={withings.summary?.sleep.status}
            value={
              formatSleep(withings.summary?.sleep.durationMinutes)
            }
            emptyText="Not synced"
            disconnectedText="Connect source"
            detail={sleepDetail || undefined}
          />

          <HealthTile
            label="Steps"
            connected={!!withings.account}
            loading={withings.loading}
            status={withings.summary?.steps.status}
            value={
              typeof withings.summary?.steps.count === "number"
                ? withings.summary.steps.count.toLocaleString()
                : null
            }
            emptyText="No steps"
            disconnectedText="Connect source"
            detail={stepsDetail}
          />

          <HealthTile
            label="Calories"
            className="col-span-2"
            connected={!!withings.account}
            loading={withings.loading}
            status={withings.summary?.calories?.status}
            value={
              typeof withings.summary?.calories?.total === "number"
                ? `${Math.round(withings.summary.calories.total).toLocaleString()}`
                : typeof withings.summary?.calories?.active === "number"
                  ? `${Math.round(withings.summary.calories.active).toLocaleString()}`
                : null
            }
            suffix="kcal"
            emptyText="No calories"
            disconnectedText="Connect source"
            detail={caloriesDetail}
          />
        </div>

        {withings.account &&
          !withings.loading &&
          !withings.summary?.sleep.durationMinutes && (
          <p className="rounded-md border border-border/50 bg-background/25 px-3 py-2 text-[11px] leading-relaxed text-tertiary">
            Withings is connected, but its API did not return sleep in the
            recent summary window. I am checking the endpoint shape because the
            app can be synced while this OAuth API still omits sleep data.
          </p>
        )}
      </section>

      {/* Deep work */}
      <section className="glass-card rounded-lg p-3">
        <div className="label-track text-tertiary mb-2">DEEP WORK</div>
        <p className="text-xs text-tertiary leading-relaxed">
          Focus tracking is not wired yet. ODIN will keep this lower priority
          until real personal data exists.
        </p>
      </section>
    </aside>
  )
}

function HeartPulseIndicator({
  bpm,
  loading,
  refreshing,
  connected,
}: {
  bpm: number | null
  loading: boolean
  refreshing: boolean
  connected: boolean
}) {
  const label = !connected
    ? "Health source offline"
    : loading
      ? "Reading Withings"
      : refreshing
        ? "Quiet refresh"
      : bpm
        ? "Heart pulse"
        : "Heart signal pending"

  return (
    <div className="relative overflow-hidden rounded-md border border-gold/25 bg-background/35 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 shrink-0">
          <Activity size={14} className="text-gold" />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gold">
              {label}
            </div>
            <div className="font-mono-data text-lg leading-none text-foreground">
              {bpm ? `${bpm} bpm` : "--"}
            </div>
          </div>
        </div>
        <svg
          viewBox="0 0 168 44"
          className={[
            "h-11 min-w-0 flex-1 text-gold",
            connected && !loading ? "" : "opacity-45",
          ].join(" ")}
          aria-hidden="true"
        >
          <line
            x1="0"
            y1="24"
            x2="168"
            y2="24"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.12"
          />
          <polyline
            className="odin-ecg-base"
            points="0,24 18,24 25,24 31,8 40,36 49,16 58,24 82,24 90,24 97,12 106,33 115,18 124,24 148,24 168,24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <polyline
            className={connected && !loading ? "odin-ecg-runner" : ""}
            points="0,24 18,24 25,24 31,8 40,36 49,16 58,24 82,24 90,24 97,12 106,33 115,18 124,24 148,24 168,24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}

function HealthCoach({
  recommendations,
  plan,
}: {
  recommendations: HealthRecommendation[]
  plan?: WithingsHealthSummary["plan"]
}) {
  const actionItems = plan?.actionItems ?? []
  return (
    <div className="rounded-md border border-frost/20 bg-frost/[0.06] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="label-track text-frost">Coach Plan</div>
        <span className="text-[10px] uppercase tracking-wider text-tertiary">
          {plan?.status === "ready" ? "Withings" : "Local"}
        </span>
      </div>
      <div className="mt-2 space-y-2">
        {recommendations.slice(0, 1).map((item) => (
          <div key={item.label} className="border-l border-gold/35 pl-2">
            <div className="text-[10px] uppercase tracking-wider text-gold">
              {item.label}
            </div>
            <p className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
              {item.text}
            </p>
          </div>
        ))}
        {actionItems.length > 1 ? (
          <ul className="space-y-1">
            {actionItems.slice(1, 3).map((item) => (
              <li key={item} className="text-[10px] leading-relaxed text-muted-foreground">
                {item}
              </li>
            ))}
          </ul>
        ) : recommendations.length > 1 && (
          <p className="text-[10px] uppercase tracking-wider text-tertiary">
            +{recommendations.length - 1} quieter read{recommendations.length === 2 ? "" : "s"}
          </p>
        )}
        {!!plan?.dataUsed?.length && (
          <p className="text-[10px] leading-relaxed text-tertiary">
            Using {plan.dataUsed.slice(0, 5).join(", ")}. Fitness coaching only.
          </p>
        )}
      </div>
    </div>
  )
}

function HealthTile({
  label,
  className,
  connected,
  loading,
  status,
  value,
  suffix,
  emptyText,
  disconnectedText,
  detail,
}: {
  label: string
  className?: string
  connected: boolean
  loading: boolean
  status?: "connected" | "empty" | "error"
  value: string | null
  suffix?: string
  emptyText: string
  disconnectedText: string
  detail?: string
}) {
  const statusText = !connected
    ? "Not connected"
    : loading
      ? "Syncing"
      : value
        ? value
        : status === "error"
          ? "Needs attention"
          : "No data"

  const hasValue = connected && !loading && !!value

  return (
    <div
      className={[
        "min-h-[76px] rounded-md border border-border/60 bg-background/30 p-2.5",
        className,
      ].filter(Boolean).join(" ")}
    >
      <div className="text-[10px] text-tertiary uppercase tracking-wider">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span
          className={[
            "font-mono-data text-lg leading-none",
            hasValue ? "text-foreground" : "text-tertiary",
          ].join(" ")}
        >
          {statusText}
        </span>
        {hasValue && suffix && (
          <span className="text-[10px] uppercase tracking-wider text-tertiary">
            {suffix}
          </span>
        )}
      </div>
      <div className="mt-2 text-[10px] leading-snug text-muted-foreground">
        {!connected ? disconnectedText : value ? detail ?? "Live" : emptyText}
      </div>
    </div>
  )
}

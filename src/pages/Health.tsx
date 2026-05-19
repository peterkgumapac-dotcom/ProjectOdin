import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react"
import {
  Activity,
  Bed,
  ChevronDown,
  Dumbbell,
  Eye,
  FileText,
  Footprints,
  HeartPulse,
  Loader2,
  MoonStar,
  Salad,
  Scale,
  ShieldCheck,
  Target,
  Upload,
} from "lucide-react"
import {
  LightPageHeader,
  LightPageShell,
} from "@/components/dashboard/LightPageChrome"
import { ConnectionStatusChip } from "@/components/shared/ConnectionStatusChip"
import { useAuth } from "@/hooks/useAuth"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import { useWithingsHealth } from "@/hooks/useWithingsHealth"
import {
  connectWithings,
  type WithingsDailyHealthPoint,
  type WithingsHealthSummary,
} from "@/lib/connectors/withings"
import {
  DEFAULT_HEALTH_GOALS,
  extractHealthSignals,
  getHealthProfile,
  summarizeHealthFile,
  upsertHealthProfile,
  type DailyHealthPlan,
  type DietStyle,
  type HealthContextSummary,
  type HealthFocus,
  type HealthGoals,
  type PlanEvidence,
  type PlanItem,
} from "@/lib/healthProfile"

function numberFrom(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatSleep(minutes?: number | null): string {
  if (typeof minutes !== "number") return "--"
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function compactNumber(value?: number | null): string {
  if (typeof value !== "number") return "--"
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`
  return value.toLocaleString()
}

function formatMetric(value?: number | null, unit = "", digits = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--"
  const rounded = Number.isInteger(value) ? value.toString() : value.toFixed(digits)
  return unit ? `${rounded} ${unit}` : rounded
}

function relativeTime(value?: string | null): string {
  if (!value) return "not synced"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "not synced"
  const minutes = Math.max(1, Math.round(Math.abs(Date.now() - date.getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function readinessScore(summary: WithingsHealthSummary | null): number {
  if (!summary) return 52
  let score = 70
  const sleep = summary.sleep.durationMinutes
  const heart = summary.heartRate.bpm
  const steps = summary.steps.count
  const workouts = summary.workouts?.recentCount ?? 0

  if (typeof sleep === "number") {
    if (sleep < 300) score -= 28
    else if (sleep < 390) score -= 15
    else if (sleep >= 450) score += 8
  } else {
    score -= 8
  }

  if (typeof heart === "number") {
    if (heart >= 100) score -= 24
    else if (heart >= 88) score -= 12
    else if (heart <= 70) score += 5
  }

  if (typeof steps === "number") {
    if (steps < 2500) score -= 5
    else if (steps > 7500) score += 4
  }

  if (workouts === 0) score -= 4
  return clamp(Math.round(score), 15, 95)
}

function metricTone(status: PlanEvidence["status"]) {
  if (status === "limit") return "bg-[#fff2e8] text-[#8f3711]"
  if (status === "support") return "bg-[#f1f8eb] text-[#3f6f2c]"
  if (status === "target") return "bg-[#fff7df] text-[#7a5615]"
  return "bg-[#f5ead7] text-[#6d5334]"
}

function percent(value?: number | null, target?: number | null) {
  if (typeof value !== "number" || typeof target !== "number" || target <= 0) return null
  return clamp(Math.round((value / target) * 100), 0, 100)
}

function addStat(current: number | null, next: number | null): number | null {
  if (typeof next !== "number") return current
  return (current ?? 0) + next
}

function formatCalories(value?: number | null): string {
  if (typeof value !== "number") return "--"
  return `${Math.round(value).toLocaleString()} kcal`
}

function formatDistance(value?: number | null): string {
  if (typeof value !== "number") return "--"
  if (value >= 1000) return `${(value / 1000).toFixed(1)} km`
  return `${Math.round(value)} m`
}

function shortDay(value?: string | null): string {
  if (!value) return "No date"
  const date = dateFromInput(value)
  if (!date) return "No date"
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function dateFromInput(value: string): Date | null {
  const date = value.includes("T") ? new Date(value) : new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function latestDailyPoint(summary: WithingsHealthSummary | null): WithingsDailyHealthPoint | null {
  const daily = summary?.daily ?? []
  for (let index = daily.length - 1; index >= 0; index -= 1) {
    const point = daily[index]
    if (
      point.steps !== null ||
      point.sleepMinutes !== null ||
      point.averageHeartRate !== null ||
      point.activeCalories !== null ||
      point.workoutCount > 0
    ) {
      return point
    }
  }
  return null
}

function buildPlan(
  summary: WithingsHealthSummary | null,
  goals: HealthGoals,
  contexts: HealthContextSummary[]
): DailyHealthPlan {
  const score = readinessScore(summary)
  const sleep = summary?.sleep.durationMinutes ?? null
  const heart = summary?.heartRate.bpm ?? null
  const weight = summary?.body?.weightKg.value ?? null
  const steps = summary?.steps.count ?? null
  const workouts = summary?.workouts?.recentCount ?? 0
  const targetWeight = numberFrom(goals.targetWeightKg)
  const targetSteps = numberFrom(goals.dailySteps) ?? 8000
  const targetSleep = numberFrom(goals.sleepHours) ?? 7.5
  const strengthDays = numberFrom(goals.strengthDays) ?? 3
  const manualProtein = numberFrom(goals.proteinGrams)
  const protein = manualProtein ?? (typeof weight === "number" ? Math.round(weight * 1.6) : 140)
  const contextHints = [
    ...contexts.flatMap((context) => context.signals),
    ...extractHealthSignals(goals.notes),
  ].filter((item, index, list) => list.indexOf(item) === index)
  const jointCaution = contextHints.some((item) => /joint|intensity/i.test(item))
  const travelMode = goals.focus === "busy" || contextHints.some((item) => /travel/i.test(item))

  if (!summary) {
    return {
      mode: "Read stats",
      readiness: 0,
      headline: "Read Withings to build today's tracker.",
      decision:
        "No current health read is loaded, so ODIN is holding the recommendation instead of guessing.",
      exercise: [
        {
          label: "Next",
          title: "Read stats",
          detail: "Tap Read stats so ODIN can choose movement intensity from sleep, pulse, steps, and body data.",
        },
      ],
      diet: [
        {
          label: "Baseline",
          title: `${protein}g protein target`,
          detail: "This uses your saved goal settings until body data is available.",
        },
      ],
      recovery: [
        {
          label: "Sleep",
          title: `${targetSleep}h sleep target`,
          detail: "Withings sleep data will decide whether today is strength, fat loss, or recovery.",
        },
      ],
      evidence: [
        {
          label: "Withings",
          value: "Pending",
          status: "info",
          interpretation: "No current stat read is loaded.",
        },
      ],
      dataUsed: [
        goals.focus ? "goal mode" : null,
        goals.notes.trim() ? "Peter notes" : null,
        contexts.length ? "files" : null,
      ].filter(Boolean) as string[],
    }
  }

  const recoveryLimiter =
    score < 55 ||
    (typeof sleep === "number" && sleep < 330) ||
    (typeof heart === "number" && heart >= 95)

  let mode = "Fat-loss day"
  if (recoveryLimiter || goals.focus === "recovery") mode = "Recovery day"
  else if (travelMode) mode = "Travel/busy day"
  else if (goals.focus === "strength") mode = "Strength day"

  const dataUsed = [
    summary?.sleep.durationMinutes ? "sleep" : null,
    summary?.steps.count ? "steps" : null,
    summary?.heartRate.bpm ? "heart rate" : null,
    summary?.body?.weightKg.value ? "weight" : null,
    summary?.body?.bmi.value ? "BMI" : null,
    summary?.workouts ? "workouts" : null,
    targetWeight ? "target weight" : null,
    contexts.length ? "files" : null,
    goals.notes.trim() ? "Peter notes" : null,
  ].filter(Boolean) as string[]
  const evidence: PlanEvidence[] = []

  if (typeof sleep === "number") {
    const sleepTargetMinutes = targetSleep * 60
    evidence.push({
      label: "Sleep",
      value: formatSleep(sleep),
      status: sleep < 330 ? "limit" : sleep >= sleepTargetMinutes ? "support" : "target",
      interpretation:
        sleep < 330
          ? `Below the ${targetSleep}h target, so ODIN caps intensity today.`
          : sleep >= sleepTargetMinutes
            ? "Sleep is supporting harder training."
            : `Short of the ${targetSleep}h target; keep recovery visible.`,
    })
  }

  if (typeof steps === "number") {
    evidence.push({
      label: "Steps",
      value: compactNumber(steps),
      status: steps < Math.round(targetSteps * 0.35) ? "target" : "support",
      interpretation:
        steps < Math.round(targetSteps * 0.35)
          ? `You are early versus the ${targetSteps.toLocaleString()} step target, so the walk is useful.`
          : `You are moving toward the ${targetSteps.toLocaleString()} step target.`,
    })
  }

  if (typeof heart === "number") {
    evidence.push({
      label: "Pulse",
      value: `${heart} bpm`,
      status: heart >= 95 ? "limit" : heart <= 70 ? "support" : "info",
      interpretation:
        heart >= 95
          ? "If this was resting pulse, stay easy and watch symptoms."
          : heart <= 70
            ? "Pulse is calm enough to support normal training."
            : "Pulse is not the blocker; sleep/readiness carry the decision.",
    })
  }

  if (typeof weight === "number") {
    evidence.push({
      label: "Body",
      value: `${Math.round(weight)} kg${summary?.body?.bmi.value ? ` · BMI ${summary.body.bmi.value}` : ""}`,
      status: "target",
      interpretation: `${protein}g protein is set from body weight to protect lean mass.`,
    })
  }

  if (summary?.workouts) {
    evidence.push({
      label: "Workouts",
      value: `${workouts} / 30d`,
      status: workouts >= 8 ? "support" : "target",
      interpretation:
        workouts >= 8
          ? "Training volume exists already; recovery can safely win today."
          : "Training frequency is light, so the plan keeps the streak simple.",
    })
  }

  const exercise: PlanItem[] =
    mode === "Recovery day"
      ? [
          {
            label: "Walk",
            title: "20-30 min easy walk",
            detail:
              typeof sleep === "number"
                ? `Sleep was ${formatSleep(sleep)} and readiness is ${score}/100, so keep this at easy conversation pace.`
                : `Readiness is ${score}/100. Use the walk for circulation and stress, not performance.`,
          },
          {
            label: "Mobility",
            title: "10 min hips, T-spine, hamstrings",
            detail: jointCaution
              ? "Your saved notes mention joint caution; skip loaded ranges that provoke pain."
              : "Smooth reps only. This is a recovery signal, not a workout.",
          },
        ]
      : mode === "Strength day"
        ? [
            {
              label: "Lift",
              title: "45 min full-body strength",
              detail: `Readiness is ${score}/100. Squat or hinge, push, pull, carry, then stop at RPE 7.`,
            },
            {
              label: "Steps",
              title: `${targetSteps.toLocaleString()} step floor`,
              detail: "Use walking to support body composition without stealing recovery from lifting.",
            },
          ]
        : mode === "Travel/busy day"
          ? [
              {
                label: "Minimum",
                title: "12 min movement block",
                detail: "Push-ups, air squats, rows or band pull, brisk walk. Keep the streak alive.",
              },
              {
                label: "Steps",
                title: `${Math.min(targetSteps, 7000).toLocaleString()} steps`,
                detail: "Break into 2-3 short walks around calls or travel windows.",
              },
            ]
          : [
              {
                label: "Zone 2",
                title: "35-45 min walk",
                detail: `You are at ${compactNumber(steps)} steps. Close the gap toward ${targetSteps.toLocaleString()} without turning it into punishment.`,
              },
              {
                label: "Strength",
                title: `${strengthDays} strength sessions this week`,
                detail:
                  workouts > 0
                    ? "Keep the next session moderate and repeatable."
                    : "Start with a short full-body session before adding volume.",
              },
            ]

  const diet: PlanItem[] = [
    {
      label: "Protein",
      title: `${protein}g protein target`,
      detail:
        typeof weight === "number"
          ? `${Math.round(weight)} kg body weight makes this a practical lean-mass anchor across 2-4 meals.`
          : "Split across 2-4 meals. This is the anchor before calories get clever.",
    },
    {
      label: "Plate",
      title:
        goals.dietStyle === "lower_carb"
          ? "Protein, vegetables, controlled carbs"
          : goals.dietStyle === "plant_forward"
            ? "Protein plus fiber-forward meals"
            : "Protein, fiber, simple calorie guardrail",
      detail:
        targetWeight && weight
          ? `Current ${Math.round(weight)} kg, target ${targetWeight} kg. Keep the deficit boring and visible.`
          : "Half plate plants, palm-sized protein, starch around training or earlier in the day.",
    },
    {
      label: "Hydration",
      title:
        typeof weight === "number"
          ? `${Math.round((weight * 35) / 100) / 10}L water baseline`
          : "2.7L water baseline",
      detail: "Add electrolytes if travel, heat, or sweat is high.",
    },
  ]

  const recovery: PlanItem[] = [
    {
      label: "Sleep",
      title: `${targetSleep}h sleep target`,
      detail:
        typeof sleep === "number"
          ? `Last sleep: ${formatSleep(sleep)}. Protect the first 90 minutes of tonight.`
          : "No sleep reading yet. Use bedtime consistency until Withings has a clean signal.",
    },
    {
      label: "Caffeine",
      title: "Caffeine cutoff by 2 PM",
      detail:
        typeof sleep === "number" && sleep < 390
          ? `Last sleep was ${formatSleep(sleep)}, so keep the cutoff hard and protect tonight.`
          : "Move later cravings to water, walk, or food so sleep is not taxed tonight.",
    },
  ]

  if (typeof heart === "number" && heart >= 95) {
    recovery.unshift({
      label: "Pulse",
      title: "Downshift before training",
      detail: "If this is resting pulse, breathe, hydrate, and keep training easy. Symptoms mean clinician, not coaching.",
    })
  }

  const headline =
    mode === "Recovery day" && goals.focus === "strength"
      ? "Strength waits today because sleep and readiness are not giving you the floor for it."
      : mode === "Recovery day" && goals.focus === "busy"
        ? "ODIN is shrinking the day to recovery basics: one easy walk, simple food, protected sleep."
        : mode === "Recovery day"
      ? "Recovery wins today because your body metrics are asking for a lower ceiling."
      : mode === "Strength day"
        ? "ODIN sees enough readiness for strength, with a clean recovery ceiling."
        : mode === "Travel/busy day"
          ? "ODIN is keeping the plan small enough to survive the day."
          : "ODIN is biasing toward steady fat loss: steps, protein, sleep, repeat."
  const decision =
    mode === "Recovery day"
      ? `Decision: cap intensity because readiness is ${score}/100${
          typeof sleep === "number" ? ` and sleep was ${formatSleep(sleep)}` : ""
        }. The useful win is easy movement, protein, and a cleaner sleep runway.`
      : mode === "Strength day"
        ? `Decision: strength is allowed because readiness is ${score}/100 and no recovery limiter is dominating. Keep effort submaximal.`
        : mode === "Travel/busy day"
          ? `Decision: preserve consistency with a minimum plan because the day is constrained.`
          : `Decision: push body composition gently through steps and protein because readiness is ${score}/100.`

  return {
    mode,
    readiness: score,
    headline,
    decision,
    exercise,
    diet,
    recovery: recovery.slice(0, 3),
    evidence: evidence.slice(0, 5),
    dataUsed,
  }
}

function focusLabel(focus: HealthFocus) {
  if (focus === "fat_loss") return "Fat loss"
  if (focus === "busy") return "Busy day"
  return focus[0].toUpperCase() + focus.slice(1)
}

function SettingsField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  step,
  min,
  max,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  step?: string
  min?: string
  max?: string
}) {
  return (
    <label className="grid min-w-0 gap-1">
      <span className="text-[11px] font-semibold text-[#9b815e]">{label}</span>
      <input
        type={type}
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 min-w-0 border-0 border-b border-[#d8c4a5] bg-transparent px-0 text-base font-extrabold text-[#2b1d0f] outline-none transition placeholder:text-[#9b815e]/65 focus:border-[#bd5a18]"
      />
    </label>
  )
}

function PlanCard({
  title,
  items,
  icon: Icon,
}: {
  title: string
  items: PlanItem[]
  icon: typeof Dumbbell
}) {
  return (
    <section className="odin-light-card rounded-[24px] p-5 md:p-6">
      <div className="mb-5 flex items-center justify-between gap-4">
        <p className="label-track text-[#6d5334]">{title}</p>
        <Icon className="text-[#bd5a18]" size={20} />
      </div>
      <div className="grid gap-4">
        {items.map((item) => (
          <article key={`${item.label}-${item.title}`} className="border-l border-[#ead9bd] pl-4">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#bd5a18]">
              {item.label}
            </p>
            <h3 className="mt-1 text-lg font-extrabold leading-tight text-[#2b1d0f]">
              {item.title}
            </h3>
            <p className="mt-1 text-sm font-semibold leading-relaxed text-[#7d644e]">
              {item.detail}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}

function TrackerMetric({
  icon: Icon,
  label,
  value,
  detail,
  progress,
  status,
}: {
  icon: typeof Activity
  label: string
  value: string
  detail: string
  progress?: number | null
  status: PlanEvidence["status"]
}) {
  return (
    <article className="min-w-0 rounded-[20px] border border-[#ead9bd] bg-white/55 p-4">
      <div className="flex items-start justify-between gap-3">
        <span className={["grid h-9 w-9 shrink-0 place-items-center rounded-full", metricTone(status)].join(" ")}>
          <Icon size={17} />
        </span>
        <span className="text-right text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#9b815e]">
          {label}
        </span>
      </div>
      <strong className="mt-4 block truncate text-2xl font-extrabold tracking-[-0.035em] text-[#2b1d0f]">
        {value}
      </strong>
      <p className="mt-1 min-h-[34px] text-xs font-bold leading-snug text-[#7d644e]">{detail}</p>
      {typeof progress === "number" ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#ead9bd]">
          <span
            className="block h-full rounded-full bg-[#b6531c]"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
    </article>
  )
}

function DailyTrackerCard({
  plan,
  summary,
  goals,
  topFitnessMove,
  recommendationBasis,
  selectedPlanAt,
  checkedAt,
  refreshing,
  withingsConnected,
  needsReconnect,
  onFocusChange,
}: {
  plan: DailyHealthPlan
  summary: WithingsHealthSummary | null
  goals: HealthGoals
  topFitnessMove: string
  recommendationBasis: string
  selectedPlanAt: string | null
  checkedAt: string | null
  refreshing: boolean
  withingsConnected: boolean
  needsReconnect: boolean
  onFocusChange: (focus: HealthFocus) => void
}) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const targetSteps = numberFrom(goals.dailySteps) ?? 8000
  const targetSleepHours = numberFrom(goals.sleepHours) ?? 7.5
  const sleepProgress = percent(summary?.sleep.durationMinutes, targetSleepHours * 60)
  const stepProgress = percent(summary?.steps.count, targetSteps)
  const sleepStatus = (plan.evidence ?? []).find((item) => item.label === "Sleep")?.status ?? "info"
  const stepStatus = (plan.evidence ?? []).find((item) => item.label === "Steps")?.status ?? "info"
  const pulseStatus = (plan.evidence ?? []).find((item) => item.label === "Pulse")?.status ?? "info"
  const bodyStatus = (plan.evidence ?? []).find((item) => item.label === "Body")?.status ?? "info"
  const remainingSteps =
    typeof summary?.steps.count === "number"
      ? Math.max(0, targetSteps - summary.steps.count)
      : null
  const evidenceItems = plan.evidence?.length
    ? plan.evidence
    : [
        {
          label: "Withings",
          value: withingsConnected ? "Pending" : "Not connected",
          status: "info" as const,
          interpretation: withingsConnected
            ? "Tap Read stats before trusting today's recommendation."
            : "Connect Withings so ODIN can use live health signals.",
        },
      ]
  const sourceLine = refreshing
    ? "Reading live Withings now"
    : !withingsConnected
      ? "Withings not connected"
      : needsReconnect
        ? "Withings needs reconnect"
        : summary
          ? `Withings read ${relativeTime(checkedAt)}`
          : "Waiting for manual Withings read"
  const confidenceLine = summary
    ? "Stat-based recommendation"
    : withingsConnected
      ? "Goal-based until stats are read"
      : "Setup needed"

  return (
    <section className="odin-light-card rounded-[28px] p-5 md:p-6">
      <div className="grid gap-6 lg:grid-cols-[144px_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-4 sm:flex sm:items-center sm:gap-5 lg:block">
          <div
            className="grid h-28 w-28 shrink-0 place-items-center rounded-full md:h-32 md:w-32"
            style={{
              background: `conic-gradient(#b6531c ${plan.readiness * 3.6}deg, #ead9bd 0deg)`,
            }}
          >
            <div className="grid h-[90px] w-[90px] place-items-center rounded-full bg-[#fffaf1] text-center md:h-[104px] md:w-[104px]">
              <div>
                <strong className="block text-3xl font-extrabold tracking-[-0.05em] text-[#2b1d0f] md:text-4xl">
                  {plan.readiness}
                </strong>
                <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#9b815e]">
                  readiness
                </span>
              </div>
            </div>
          </div>
          <div className="min-w-0 lg:mt-4">
            <p className="label-track text-[#bd5a18]">{plan.mode}</p>
            <h2 className="mt-2 text-2xl font-extrabold leading-[1.02] tracking-[-0.035em] text-[#2b1d0f] md:text-3xl">
              {plan.headline}
            </h2>
          </div>
        </div>

        <div className="min-w-0">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <TrackerMetric
              icon={Bed}
              label="Sleep"
              value={formatSleep(summary?.sleep.durationMinutes)}
              detail={
                typeof sleepProgress === "number"
                  ? `${sleepProgress}% of ${targetSleepHours}h target`
                  : "No sleep read yet"
              }
              progress={sleepProgress}
              status={sleepStatus}
            />
            <TrackerMetric
              icon={Footprints}
              label="Steps"
              value={compactNumber(summary?.steps.count)}
              detail={
                typeof remainingSteps === "number"
                  ? `${compactNumber(remainingSteps)} left to ${targetSteps.toLocaleString()}`
                  : `${targetSteps.toLocaleString()} target`
              }
              progress={stepProgress}
              status={stepStatus}
            />
            <TrackerMetric
              icon={HeartPulse}
              label="Pulse"
              value={`${summary?.heartRate.bpm ?? "--"} bpm`}
              detail={
                summary?.heartRate.bpm
                  ? summary.heartRate.bpm >= 95
                    ? "High if resting"
                    : "Not the limiter"
                  : "Pulse pending"
              }
              status={pulseStatus}
            />
            <TrackerMetric
              icon={Scale}
              label="Body"
              value={formatMetric(summary?.body?.weightKg.value, "kg")}
              detail={summary?.body?.bmi.value ? `BMI ${summary.body.bmi.value}` : "Weight pending"}
              status={bodyStatus}
            />
          </div>

          <div className="mt-4 rounded-[22px] border border-[#ead9bd] bg-white/55 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#9b815e]">
                  Today
                </p>
                <h3 className="mt-1 text-xl font-extrabold tracking-[-0.025em] text-[#2b1d0f]">
                  {topFitnessMove}
                </h3>
              </div>
              <span className="rounded-full bg-[#f5ead7] px-3 py-1 text-xs font-extrabold text-[#7d644e]">
                {summary?.workouts?.recentCount ?? 0} workouts / 30d
              </span>
            </div>
            <p className="mt-3 text-sm font-semibold leading-relaxed text-[#6d5334]">
              {recommendationBasis}
            </p>
            <div className="mt-4 rounded-[18px] border border-[#ead9bd] bg-[#fffaf1]/70">
              <button
                type="button"
                onClick={() => setReasoningOpen((current) => !current)}
                aria-expanded={reasoningOpen}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#f5ead7] text-[#b6531c]">
                    <Eye size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-extrabold text-[#2b1d0f]">
                      Why ODIN chose this
                    </span>
                    <span className="block text-xs font-bold leading-snug text-[#8a7254]">
                      {confidenceLine}
                      <span className="hidden sm:inline"> · {sourceLine}</span>
                    </span>
                  </span>
                </span>
                <ChevronDown
                  size={17}
                  className={[
                    "shrink-0 text-[#8a7254] transition-transform",
                    reasoningOpen ? "rotate-180" : "",
                  ].join(" ")}
                />
              </button>

              {reasoningOpen && (
                <div className="border-t border-[#ead9bd] px-4 pb-4 pt-3">
                  <p className="text-sm font-semibold leading-relaxed text-[#6d5334]">
                    {plan.decision ??
                      "ODIN is waiting for enough live health signal before making a stronger call."}
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {evidenceItems.map((item) => (
                      <article
                        key={`${item.label}-${item.value}`}
                        className="rounded-[16px] border border-[#ead9bd] bg-white/60 p-3"
                      >
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#9b815e]">
                            {item.label}
                          </span>
                          <span
                            className={[
                              "rounded-full px-2.5 py-1 text-xs font-extrabold",
                              metricTone(item.status),
                            ].join(" ")}
                          >
                            {item.value}
                          </span>
                        </div>
                        <p className="text-xs font-semibold leading-relaxed text-[#7d644e]">
                          {item.interpretation}
                        </p>
                      </article>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="rounded-full border border-[#dfcfb1] bg-white/60 px-3 py-1 text-xs font-extrabold text-[#7d644e]">
                      {sourceLine}
                    </span>
                    {(plan.dataUsed.length ? plan.dataUsed : ["goals"]).map((item) => (
                      <span
                        key={item}
                        className="rounded-full border border-[#dfcfb1] bg-white/60 px-3 py-1 text-xs font-extrabold text-[#7d644e]"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {(["fat_loss", "strength", "recovery", "busy"] as HealthFocus[]).map((focus) => (
                <button
                  key={focus}
                  type="button"
                  onClick={() => onFocusChange(focus)}
                  className={[
                    "rounded-full border px-3.5 py-2 text-sm font-extrabold transition",
                    goals.focus === focus
                      ? "border-[#b6531c] bg-[#b6531c] text-white"
                      : "border-[#dfcfb1] bg-white/60 text-[#7d644e] hover:border-[#b6531c]",
                  ].join(" ")}
                >
                  {focusLabel(focus)}
                </button>
              ))}
            </div>
            {selectedPlanAt && (
              <div className="flex items-center gap-2 text-sm font-semibold text-[#9b815e]">
                <ShieldCheck size={15} className="text-[#b6531c]" />
                <span>Selected {relativeTime(selectedPlanAt)}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

type StatsView = "daily" | "weekly"

function HealthStatTile({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string
  value: string
  detail: string
  icon: typeof Activity
}) {
  return (
    <article className="rounded-[20px] border border-[#ead9bd] bg-white/55 p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#f5ead7] text-[#b6531c]">
          <Icon size={17} />
        </span>
        <p className="text-right text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#9b815e]">
          {label}
        </p>
      </div>
      <strong className="mt-4 block truncate text-2xl font-extrabold tracking-[-0.035em] text-[#2b1d0f]">
        {value}
      </strong>
      <p className="mt-1 text-xs font-bold leading-snug text-[#7d644e]">{detail}</p>
    </article>
  )
}

function HealthStatsBoard({
  summary,
  goals,
  view,
  onViewChange,
}: {
  summary: WithingsHealthSummary | null
  goals: HealthGoals
  view: StatsView
  onViewChange: (view: StatsView) => void
}) {
  const daily = latestDailyPoint(summary)
  const weekly = summary?.weekly
  const targetSteps = numberFrom(goals.dailySteps) ?? 8000
  const targetSleep = numberFrom(goals.sleepHours) ?? 7.5
  const strengthDays = numberFrom(goals.strengthDays) ?? 3
  const lastSeven = (summary?.daily ?? []).slice(-7)
  const trackedDays = lastSeven.filter((point) =>
    point.steps !== null || point.sleepMinutes !== null || point.workoutCount > 0
  ).length
  const dailySteps = daily?.steps ?? summary?.steps.count ?? null
  const dailySleep = daily?.sleepMinutes ?? summary?.sleep.durationMinutes ?? null
  const dailyPulse = daily?.averageHeartRate ?? summary?.heartRate.bpm ?? null
  const dailyActiveCalories = daily?.activeCalories ?? summary?.calories.active ?? null
  const dailyTotalCalories = daily?.totalCalories ?? summary?.calories.total ?? null
  const dailyWorkouts = daily?.workoutCount ?? 0
  const dailyWorkoutMinutes = daily?.workoutMinutes ?? summary?.workouts?.latest?.durationMinutes ?? null
  const body = summary?.body
  const dailyTiles = [
    {
      label: "Steps",
      value: compactNumber(dailySteps),
      detail:
        typeof dailySteps === "number"
          ? `${percent(dailySteps, targetSteps) ?? 0}% of ${targetSteps.toLocaleString()} · ${shortDay(daily?.date ?? summary?.steps.date)}`
          : `${targetSteps.toLocaleString()} target`,
      icon: Footprints,
    },
    {
      label: "Sleep",
      value: formatSleep(dailySleep),
      detail:
        typeof dailySleep === "number"
          ? `${percent(dailySleep, targetSleep * 60) ?? 0}% of ${targetSleep}h · ${daily?.wakeups ?? summary?.sleep.wakeups ?? 0} wakeups`
          : `${targetSleep}h target`,
      icon: Bed,
    },
    {
      label: "Pulse",
      value: `${dailyPulse ?? "--"} bpm`,
      detail:
        typeof dailyPulse === "number"
          ? dailyPulse >= 95
            ? "High if resting"
            : "Daily average"
          : "Pending",
      icon: HeartPulse,
    },
    {
      label: "Calories",
      value: formatCalories(dailyActiveCalories),
      detail:
        typeof dailyTotalCalories === "number"
          ? `${formatCalories(dailyTotalCalories)} total`
          : "Active calories",
      icon: Activity,
    },
    {
      label: "Workout",
      value: `${dailyWorkouts}`,
      detail:
        typeof dailyWorkoutMinutes === "number"
          ? `${dailyWorkoutMinutes} min today/latest`
          : "No workout logged today",
      icon: Dumbbell,
    },
    {
      label: "Body",
      value: formatMetric(body?.weightKg.value, "kg"),
      detail: body?.bmi.value ? `BMI ${body.bmi.value}` : "Weight pending",
      icon: Scale,
    },
  ]
  const weeklyTiles = [
    {
      label: "Avg steps",
      value: compactNumber(weekly?.stepsAverage),
      detail:
        typeof weekly?.stepsTotal === "number"
          ? `${compactNumber(weekly.stepsTotal)} / ${compactNumber(targetSteps * 7)} weekly target`
          : "Needs activity history",
      icon: Footprints,
    },
    {
      label: "Avg sleep",
      value: formatSleep(weekly?.sleepAverageMinutes),
      detail:
        typeof weekly?.sleepNights === "number"
          ? `${weekly.sleepNights}/7 nights tracked · ${targetSleep}h target`
          : "Needs sleep history",
      icon: Bed,
    },
    {
      label: "Workouts",
      value: `${weekly?.workoutCount ?? summary?.workouts?.recentCount ?? 0}`,
      detail:
        typeof weekly?.workoutMinutes === "number"
          ? `${weekly.workoutMinutes} min · goal ${strengthDays}/week`
          : `Goal ${strengthDays}/week`,
      icon: Dumbbell,
    },
    {
      label: "Active burn",
      value: formatCalories(weekly?.activeCaloriesTotal),
      detail:
        typeof weekly?.totalCaloriesAverage === "number"
          ? `${formatCalories(weekly.totalCaloriesAverage)} avg total/day`
          : "Needs activity history",
      icon: Activity,
    },
    {
      label: "Consistency",
      value: `${trackedDays}/7`,
      detail: "Days with movement, sleep, or workout signal",
      icon: Target,
    },
    {
      label: "Distance",
      value: formatDistance(lastSeven.reduce<number | null>((sum, point) => addStat(sum, point.distanceMeters), null)),
      detail: "Last 7 days from Withings activity",
      icon: Footprints,
    },
  ]
  const tiles = view === "daily" ? dailyTiles : weeklyTiles

  return (
    <section className="odin-light-card rounded-[24px] p-5 md:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label-track text-[#6d5334]">Stats</p>
          <h2 className="mt-2 text-2xl font-extrabold tracking-[-0.035em] text-[#2b1d0f]">
            {view === "daily" ? "Daily tracker" : "Weekly view"}
          </h2>
        </div>
        <div className="flex rounded-full border border-[#dfcfb1] bg-white/60 p-1">
          {(["daily", "weekly"] as StatsView[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onViewChange(option)}
              className={[
                "rounded-full px-4 py-2 text-sm font-extrabold capitalize transition",
                view === option
                  ? "bg-[#b6531c] text-white shadow-sm"
                  : "text-[#7d644e] hover:text-[#b6531c]",
              ].join(" ")}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((tile) => (
          <HealthStatTile key={`${view}-${tile.label}`} {...tile} />
        ))}
      </div>
      <p className="mt-4 text-xs font-semibold leading-relaxed text-[#8a7254]">
        {view === "daily"
          ? "Daily uses the latest Withings activity, sleep, pulse, body, and workout snapshot."
          : "Weekly uses the last 7 days returned by Withings. If a tile says history is needed, tap Read stats to load the latest series."}
      </p>
    </section>
  )
}

export function HealthPage() {
  const { user } = useAuth()
  const { withings } = useConnectedAccounts()
  const withingsHealth = useWithingsHealth(withings, {
    autoRefreshUnusableCache: false,
  })
  const [goals, setGoals] = useState<HealthGoals>(DEFAULT_HEALTH_GOALS)
  const [contextSummaries, setContextSummaries] = useState<HealthContextSummary[]>([])
  const [selectedPlan, setSelectedPlan] = useState<DailyHealthPlan | null>(null)
  const [selectedPlanAt, setSelectedPlanAt] = useState<string | null>(null)
  const [statsView, setStatsView] = useState<StatsView>("daily")
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileSaving, setProfileSaving] = useState(false)
  const [planSaving, setPlanSaving] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const selectedPlanRef = useRef<DailyHealthPlan | null>(null)
  const selectedPlanAtRef = useRef<string | null>(null)
  const loadedRef = useRef(false)

  const summary = withingsHealth.summary
  const needsReconnect =
    !!summary?.needsReconnect ||
    /reconnect|refresh_token|authorization expired/i.test(
      withingsHealth.error?.message ?? ""
    )
  const plan = useMemo(
    () => buildPlan(summary, goals, contextSummaries),
    [summary, goals, contextSummaries]
  )
  const syncLine = withingsHealth.refreshing
    ? "Reading"
    : needsReconnect
      ? "Reconnect Withings"
      : summary
        ? "Read stats"
        : withings.length
          ? "Read stats"
          : "Connect Withings"
  const topFitnessMove = plan.exercise[0]?.title ?? plan.headline
  const recommendationBasis = withingsHealth.refreshing
    ? "Reading fresh Withings stats now."
    : summary
      ? `${plan.exercise[0]?.detail ?? "This is based on today's Withings read."} Last read ${relativeTime(withingsHealth.checkedAt)}.`
      : withings.length
        ? "Tap Read stats to pull Withings and update this recommendation."
        : "Connect Withings to make this recommendation personal."

  useEffect(() => {
    selectedPlanRef.current = selectedPlan
    selectedPlanAtRef.current = selectedPlanAt
  }, [selectedPlan, selectedPlanAt])

  const persistProfile = useCallback(
    async (next?: {
      goals?: HealthGoals
      contextSummaries?: HealthContextSummary[]
      activePlan?: DailyHealthPlan | null
      activePlanSelectedAt?: string | null
    }, options?: { showSettingsSaving?: boolean }) => {
      if (!user) return null
      const showSettingsSaving = options?.showSettingsSaving ?? true
      if (showSettingsSaving) setProfileSaving(true)
      setProfileError(null)
      const hasActivePlan = Boolean(next && "activePlan" in next)
      const hasActivePlanSelectedAt = Boolean(next && "activePlanSelectedAt" in next)
      const nextActivePlan = hasActivePlan
        ? next?.activePlan ?? null
        : selectedPlanRef.current
      const nextActivePlanSelectedAt = hasActivePlanSelectedAt
        ? next?.activePlanSelectedAt ?? null
        : selectedPlanAtRef.current
      try {
        const saved = await upsertHealthProfile({
          userId: user.id,
          goals: next?.goals ?? goals,
          contextSummaries: next?.contextSummaries ?? contextSummaries,
          activePlan: nextActivePlan,
          activePlanSelectedAt: nextActivePlanSelectedAt,
        })
        setSelectedPlan(saved.activePlan)
        setSelectedPlanAt(saved.activePlanSelectedAt)
        return saved
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not save the health profile."
        setProfileError(message)
        return null
      } finally {
        if (showSettingsSaving) setProfileSaving(false)
      }
    },
    [contextSummaries, goals, user]
  )

  useEffect(() => {
    let cancelled = false
    loadedRef.current = false
    setProfileLoading(true)
    setProfileError(null)

    if (!user) {
      setGoals(DEFAULT_HEALTH_GOALS)
      setContextSummaries([])
      setSelectedPlan(null)
      setSelectedPlanAt(null)
      setProfileLoading(false)
      return () => {
        cancelled = true
      }
    }

    getHealthProfile(user.id)
      .then((profile) => {
        if (cancelled) return
        if (profile) {
          setGoals(profile.goals)
          setContextSummaries(profile.contextSummaries)
          setSelectedPlan(profile.activePlan)
          setSelectedPlanAt(profile.activePlanSelectedAt)
        } else {
          setGoals(DEFAULT_HEALTH_GOALS)
          setContextSummaries([])
          setSelectedPlan(null)
          setSelectedPlanAt(null)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProfileError(error instanceof Error ? error.message : "Could not load the health profile.")
        }
      })
      .finally(() => {
        if (!cancelled) {
          loadedRef.current = true
          setProfileLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [user])

  useEffect(() => {
    if (!user || !loadedRef.current || profileLoading) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void persistProfile()
    }, 700)
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [contextSummaries, goals, persistProfile, profileLoading, user])

  const updateGoals = (patch: Partial<HealthGoals>) => {
    setGoals((current) => ({ ...current, ...patch }))
  }

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setFileBusy(true)
    setFileError(null)
    try {
      if (file.size > 1_000_000) {
        throw new Error("Use a file under 1 MB for now.")
      }
      const text = await file.text()
      if (!text.replace(/\s+/g, "").trim()) throw new Error("That file did not contain readable text.")
      const summaryContext = summarizeHealthFile(file.name, text)
      const nextContexts = [summaryContext, ...contextSummaries].slice(0, 5)
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      setContextSummaries(nextContexts)
      await persistProfile({ contextSummaries: nextContexts })
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not read that file.")
    } finally {
      setFileBusy(false)
      event.target.value = ""
    }
  }

  const savePlan = async () => {
    const now = new Date().toISOString()
    const previousPlan = selectedPlanRef.current
    const previousPlanAt = selectedPlanAtRef.current
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    setSelectedPlan(plan)
    setSelectedPlanAt(now)
    selectedPlanRef.current = plan
    selectedPlanAtRef.current = now
    setPlanSaving(true)
    try {
      const saved = await persistProfile(
        {
          activePlan: plan,
          activePlanSelectedAt: now,
        },
        { showSettingsSaving: false }
      )
      if (!saved) {
        setSelectedPlan(previousPlan)
        setSelectedPlanAt(previousPlanAt)
        selectedPlanRef.current = previousPlan
        selectedPlanAtRef.current = previousPlanAt
      }
    } finally {
      setPlanSaving(false)
    }
  }

  const action = (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <button
        type="button"
        onClick={() => {
          if (!withings.length || needsReconnect) {
            setConnecting(true)
            void connectWithings().catch(() => setConnecting(false))
            return
          }
          void withingsHealth.refresh(true)
        }}
        disabled={withingsHealth.refreshing || connecting}
        className="odin-light-action bg-[#fff9ef]/70 px-5 py-3 disabled:cursor-wait disabled:opacity-70"
      >
        {withingsHealth.refreshing || connecting ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-[#b6531c]/70" />
        )}
        {syncLine}
      </button>
      <button
        type="button"
        onClick={() => void savePlan()}
        disabled={planSaving || profileLoading}
        className="odin-light-action odin-light-action-primary px-6 py-3 disabled:cursor-wait disabled:opacity-75"
      >
        {planSaving ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
        Use This Plan
      </button>
    </div>
  )

  return (
    <LightPageShell mainClassName="!px-5 !py-8 sm:!px-8 lg:!px-12">
      <LightPageHeader title="Health" subtitle="Withings coach" action={action} />
      <div className="-mt-4 mb-5 flex flex-wrap items-center gap-2">
        <ConnectionStatusChip
          label="Withings"
          tone={needsReconnect ? "attention" : withings.length ? "connected" : "disconnected"}
          detail={
            needsReconnect
              ? "reconnect required"
              : withingsHealth.checkedAt
                ? `synced ${relativeTime(withingsHealth.checkedAt)}`
                : withings.length
                  ? "linked"
                  : "not linked"
          }
        />
      </div>

      {profileError && (
        <p className="mb-5 rounded-[22px] border border-[#bd5a18]/25 bg-[#fff2e8] px-5 py-4 text-sm font-semibold text-[#9b3e12]">
          {profileError}
        </p>
      )}

      <div className="grid gap-5">
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <DailyTrackerCard
            plan={plan}
            summary={summary}
            goals={goals}
            topFitnessMove={topFitnessMove}
            recommendationBasis={recommendationBasis}
            selectedPlanAt={selectedPlanAt}
            checkedAt={withingsHealth.checkedAt}
            refreshing={withingsHealth.refreshing}
            withingsConnected={withings.length > 0}
            needsReconnect={needsReconnect}
            onFocusChange={(focus) => updateGoals({ focus })}
          />

          <aside className="odin-light-card rounded-[24px] p-7">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="label-track text-[#9b815e]">Source</p>
                <h2 className="mt-3 text-2xl font-extrabold tracking-[-0.04em] text-[#2b1d0f]">
                  Withings
                </h2>
              </div>
              <span
                className={[
                  "mt-1 h-3 w-3 rounded-full",
                  !withings.length || needsReconnect || withingsHealth.error
                    ? "bg-[#b6531c]"
                    : withingsHealth.refreshing
                      ? "animate-pulse bg-[#c08a2a]"
                      : "bg-[#5c8f3d]",
                ].join(" ")}
              />
            </div>
            <div className="space-y-3 text-sm font-semibold leading-relaxed text-[#7d644e]">
              <p>{withings.length ? withings[0].accountLabel : "No Withings account connected."}</p>
              <p>
                {summary?.accountId
                  ? `Last cached read ${relativeTime(withingsHealth.checkedAt)}.`
                  : "Tap Read stats when you want ODIN to pull fresh Withings data."}
              </p>
              <p>
                {plan.dataUsed.length
                  ? `Used: ${plan.dataUsed.slice(0, 5).join(", ")}.`
                  : "No health signals used yet."}
              </p>
              {withingsHealth.error && (
                <p className="rounded-[18px] border border-[#b6531c]/25 bg-[#fff2e8] px-4 py-3 text-[#9b3e12]">
                  {withingsHealth.error.message}
                </p>
              )}
            </div>
            <p className="mt-5 text-xs font-semibold leading-relaxed text-[#8a7254]">
              Fitness coaching only. Symptoms or abnormal readings still go to a clinician.
            </p>
          </aside>
        </section>

        <HealthStatsBoard
          summary={summary}
          goals={goals}
          view={statsView}
          onViewChange={setStatsView}
        />

        <section className="grid gap-5 xl:grid-cols-3">
          <PlanCard title="Exercise" icon={Dumbbell} items={plan.exercise} />
          <PlanCard title="Diet" icon={Salad} items={plan.diet} />
          <PlanCard title="Recovery" icon={MoonStar} items={plan.recovery} />
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.85fr)]">
          <div className="odin-light-card rounded-[24px] p-7">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-[#f4dfc5] text-[#bd5a18]">
                  <Target size={17} />
                </span>
                <p className="label-track text-[#2b1d0f]">Plan settings</p>
              </div>
              <span className="text-xs font-bold text-[#9b815e]">
                {profileLoading ? "Loading" : profileSaving ? "Saving" : "Saved for ODIN"}
              </span>
            </div>

            <div className="grid gap-x-8 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
              <SettingsField
                label="Target weight"
                type="number"
                min="1"
                value={goals.targetWeightKg}
                onChange={(targetWeightKg) => updateGoals({ targetWeightKg })}
                placeholder={summary?.body?.weightKg.value ? `${Math.round(summary.body.weightKg.value)} kg` : "Optional"}
              />
              <SettingsField
                label="Daily steps"
                type="number"
                min="1000"
                value={goals.dailySteps}
                onChange={(dailySteps) => updateGoals({ dailySteps })}
              />
              <SettingsField
                label="Sleep hours"
                type="number"
                min="1"
                step="0.5"
                value={goals.sleepHours}
                onChange={(sleepHours) => updateGoals({ sleepHours })}
              />
              <SettingsField
                label="Strength days"
                type="number"
                min="0"
                max="7"
                value={goals.strengthDays}
                onChange={(strengthDays) => updateGoals({ strengthDays })}
              />
              <SettingsField
                label="Protein grams"
                type="number"
                min="1"
                value={goals.proteinGrams}
                onChange={(proteinGrams) => updateGoals({ proteinGrams })}
                placeholder="Auto"
              />
              <label className="grid min-w-0 gap-1">
                <span className="text-[11px] font-semibold text-[#9b815e]">Diet style</span>
                <select
                  value={goals.dietStyle}
                  onChange={(event) => updateGoals({ dietStyle: event.target.value as DietStyle })}
                  className="h-9 min-w-0 border-0 border-b border-[#d8c4a5] bg-transparent px-0 text-base font-extrabold text-[#2b1d0f] outline-none transition focus:border-[#bd5a18]"
                >
                  <option value="balanced">Balanced</option>
                  <option value="high_protein">High protein</option>
                  <option value="lower_carb">Lower carb</option>
                  <option value="plant_forward">Plant-forward</option>
                </select>
              </label>
              <label className="grid gap-2 md:col-span-2 xl:col-span-3">
                <span className="text-[11px] font-semibold text-[#9b815e]">
                  Notes, injuries, preferences
                </span>
                <textarea
                  value={goals.notes}
                  onChange={(event) => updateGoals({ notes: event.target.value })}
                  className="min-h-[76px] resize-y rounded-none border-0 border-b border-[#d8c4a5] bg-transparent px-0 py-2 text-sm font-semibold leading-relaxed text-[#2b1d0f] outline-none transition placeholder:text-[#9b815e]/65 focus:border-[#bd5a18]"
                  placeholder="Example: knee pain, gym access, no late caffeine, travel week..."
                />
              </label>
            </div>
          </div>

          <aside className="odin-light-card rounded-[24px] p-7">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-[#f4dfc5] text-[#bd5a18]">
                  <FileText size={17} />
                </span>
                <p className="label-track text-[#2b1d0f]">Files & notes</p>
              </div>
            </div>

            <label className="flex cursor-pointer items-center justify-center gap-3 rounded-[18px] border border-dashed border-[#d7c29d] bg-white/40 px-5 py-4 text-sm font-extrabold text-[#7d644e] transition hover:border-[#b6531c] hover:text-[#b6531c]">
              {fileBusy ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />}
              Add health file
              <input
                type="file"
                accept=".txt,.md,.csv,.json"
                className="sr-only"
                onChange={handleFile}
              />
            </label>

            {fileError && (
              <p className="mt-3 rounded-[18px] border border-[#b6531c]/25 bg-[#fff2e8] px-4 py-3 text-sm font-semibold text-[#9b3e12]">
                {fileError}
              </p>
            )}

            <p className="mt-4 text-sm font-semibold leading-relaxed text-[#7d644e]">
              Use text, markdown, CSV, or JSON for labs, coach notes, meal rules, injuries, or workout history.
            </p>

            {contextSummaries.length > 0 && (
              <div className="mt-5 grid gap-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#9b815e]">
                    Stored summaries
                  </p>
                  <button
                    type="button"
                    onClick={() => setContextSummaries([])}
                    className="text-xs font-extrabold text-[#b6531c]"
                  >
                    Clear
                  </button>
                </div>
                {contextSummaries.slice(0, 3).map((context) => (
                  <article
                    key={`${context.name}-${context.uploadedAt}`}
                    className="rounded-[18px] border border-[#ead9bd] bg-white/45 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-extrabold text-[#2b1d0f]">
                        {context.name}
                      </p>
                      <span className="shrink-0 text-[11px] font-semibold text-[#9b815e]">
                        {relativeTime(context.uploadedAt)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-semibold leading-relaxed text-[#7d644e]">
                      {context.summary}
                    </p>
                  </article>
                ))}
              </div>
            )}

            <div className="mt-5">
              <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#9b815e]">
                Data used
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(plan.dataUsed.length ? plan.dataUsed : ["goals"]).map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-[#dfcfb1] bg-[#fffaf1] px-3 py-1 text-xs font-extrabold text-[#7d644e]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </LightPageShell>
  )
}

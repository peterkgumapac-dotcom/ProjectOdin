import { supabase } from "@/lib/supabaseClient"
import type { Json } from "@/types/database"

export type HealthFocus = "fat_loss" | "strength" | "recovery" | "busy"
export type DietStyle = "balanced" | "high_protein" | "lower_carb" | "plant_forward"

export interface HealthGoals {
  focus: HealthFocus
  targetWeightKg: string
  dailySteps: string
  sleepHours: string
  strengthDays: string
  proteinGrams: string
  dietStyle: DietStyle
  notes: string
}

export interface HealthContextSummary {
  name: string
  uploadedAt: string
  summary: string
  signals: string[]
}

export interface PlanItem {
  label: string
  title: string
  detail: string
}

export interface PlanEvidence {
  label: string
  value: string
  interpretation: string
  status: "limit" | "support" | "target" | "info"
}

export interface DailyHealthPlan {
  mode: string
  readiness: number
  headline: string
  decision?: string
  exercise: PlanItem[]
  diet: PlanItem[]
  recovery: PlanItem[]
  evidence?: PlanEvidence[]
  dataUsed: string[]
}

export interface HealthProfile {
  userId: string
  goals: HealthGoals
  contextSummaries: HealthContextSummary[]
  activePlan: DailyHealthPlan | null
  activePlanSelectedAt: string | null
  updatedAt: string | null
}

export const DEFAULT_HEALTH_GOALS: HealthGoals = {
  focus: "fat_loss",
  targetWeightKg: "",
  dailySteps: "8000",
  sleepHours: "7.5",
  strengthDays: "3",
  proteinGrams: "",
  dietStyle: "high_protein",
  notes: "",
}

type HealthProfileRow = {
  user_id: string
  focus: string
  target_weight_kg: number | string | null
  daily_steps: number
  sleep_hours: number | string
  strength_days: number
  protein_grams: number | null
  diet_style: string
  notes: string | null
  context_summaries: Json
  active_plan: Json
  active_plan_selected_at: string | null
  updated_at: string | null
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function boundedInteger(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function nullableNumber(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function nullableInteger(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null
}

function asFocus(value: string): HealthFocus {
  return value === "strength" || value === "recovery" || value === "busy"
    ? value
    : "fat_loss"
}

function asDietStyle(value: string): DietStyle {
  return value === "balanced" ||
    value === "lower_carb" ||
    value === "plant_forward" ||
    value === "high_protein"
    ? value
    : "high_protein"
}

function numberString(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return ""
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return ""
  return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(1)))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isPlanItem(value: unknown): value is PlanItem {
  if (!isPlainObject(value)) return false
  return (
    typeof value.label === "string" &&
    typeof value.title === "string" &&
    typeof value.detail === "string"
  )
}

function isPlanEvidence(value: unknown): value is PlanEvidence {
  if (!isPlainObject(value)) return false
  return (
    typeof value.label === "string" &&
    typeof value.value === "string" &&
    typeof value.interpretation === "string" &&
    (value.status === "limit" ||
      value.status === "support" ||
      value.status === "target" ||
      value.status === "info")
  )
}

function isDailyHealthPlan(value: unknown): value is DailyHealthPlan {
  if (!isPlainObject(value)) return false
  return (
    typeof value.mode === "string" &&
    typeof value.readiness === "number" &&
    typeof value.headline === "string" &&
    (value.decision === undefined || typeof value.decision === "string") &&
    Array.isArray(value.exercise) &&
    Array.isArray(value.diet) &&
    Array.isArray(value.recovery) &&
    Array.isArray(value.dataUsed) &&
    (value.evidence === undefined || Array.isArray(value.evidence)) &&
    value.exercise.every(isPlanItem) &&
    value.diet.every(isPlanItem) &&
    value.recovery.every(isPlanItem) &&
    (value.evidence === undefined || (value.evidence as unknown[]).every(isPlanEvidence)) &&
    value.dataUsed.every((item) => typeof item === "string")
  )
}

function normalizeContextSummaries(value: unknown): HealthContextSummary[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!isPlainObject(item) || typeof item.name !== "string") return null
      const signals = Array.isArray(item.signals)
        ? item.signals.filter((signal): signal is string => typeof signal === "string")
        : []
      return {
        name: item.name,
        uploadedAt: typeof item.uploadedAt === "string" ? item.uploadedAt : new Date().toISOString(),
        summary: typeof item.summary === "string" ? item.summary : "",
        signals: signals.slice(0, 6),
      }
    })
    .filter((item): item is HealthContextSummary => Boolean(item))
    .slice(0, 5)
}

function rowToHealthProfile(row: HealthProfileRow): HealthProfile {
  return {
    userId: row.user_id,
    goals: {
      focus: asFocus(row.focus),
      targetWeightKg: numberString(row.target_weight_kg),
      dailySteps: numberString(row.daily_steps) || DEFAULT_HEALTH_GOALS.dailySteps,
      sleepHours: numberString(row.sleep_hours) || DEFAULT_HEALTH_GOALS.sleepHours,
      strengthDays: numberString(row.strength_days) || DEFAULT_HEALTH_GOALS.strengthDays,
      proteinGrams: numberString(row.protein_grams),
      dietStyle: asDietStyle(row.diet_style),
      notes: row.notes ?? "",
    },
    contextSummaries: normalizeContextSummaries(row.context_summaries),
    activePlan: isDailyHealthPlan(row.active_plan) ? row.active_plan : null,
    activePlanSelectedAt: row.active_plan_selected_at,
    updatedAt: row.updated_at,
  }
}

function goalsToRow(
  userId: string,
  goals: HealthGoals,
  contextSummaries: HealthContextSummary[],
  activePlan: DailyHealthPlan | null,
  activePlanSelectedAt: string | null
) {
  return {
    user_id: userId,
    focus: goals.focus,
    target_weight_kg: nullableNumber(goals.targetWeightKg),
    daily_steps: boundedInteger(goals.dailySteps, Number(DEFAULT_HEALTH_GOALS.dailySteps), 1, 200_000),
    sleep_hours: positiveNumber(goals.sleepHours, Number(DEFAULT_HEALTH_GOALS.sleepHours)),
    strength_days: boundedInteger(goals.strengthDays, Number(DEFAULT_HEALTH_GOALS.strengthDays), 0, 7),
    protein_grams: nullableInteger(goals.proteinGrams),
    diet_style: goals.dietStyle,
    notes: goals.notes.slice(0, 2000),
    context_summaries: contextSummaries.slice(0, 5) as unknown as Json,
    active_plan: (activePlan ?? {}) as unknown as Json,
    active_plan_selected_at: activePlan ? activePlanSelectedAt : null,
  }
}

export async function getHealthProfile(userId: string): Promise<HealthProfile | null> {
  const { data, error } = await supabase
    .from("health_profiles")
    .select(
      "user_id, focus, target_weight_kg, daily_steps, sleep_hours, strength_days, protein_grams, diet_style, notes, context_summaries, active_plan, active_plan_selected_at, updated_at"
    )
    .eq("user_id", userId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data ? rowToHealthProfile(data as HealthProfileRow) : null
}

export async function upsertHealthProfile(args: {
  userId: string
  goals: HealthGoals
  contextSummaries: HealthContextSummary[]
  activePlan: DailyHealthPlan | null
  activePlanSelectedAt: string | null
}): Promise<HealthProfile> {
  const { data, error } = await supabase
    .from("health_profiles")
    .upsert(
      goalsToRow(
        args.userId,
        args.goals,
        args.contextSummaries,
        args.activePlan,
        args.activePlanSelectedAt
      ),
      { onConflict: "user_id" }
    )
    .select(
      "user_id, focus, target_weight_kg, daily_steps, sleep_hours, strength_days, protein_grams, diet_style, notes, context_summaries, active_plan, active_plan_selected_at, updated_at"
    )
    .single()

  if (error) throw new Error(error.message)
  return rowToHealthProfile(data as HealthProfileRow)
}

export function extractHealthSignals(text: string): string[] {
  const lower = text.toLowerCase()
  const signals: string[] = []
  if (/\binjur|pain|shoulder|knee|back|ankle|sciatica\b/.test(lower)) {
    signals.push("Protect joints and keep intensity conservative.")
  }
  if (/\btravel|flight|jet lag|hotel\b/.test(lower)) {
    signals.push("Use travel mode and minimum viable movement.")
  }
  if (/\blow carb|keto|glucose|a1c|insulin\b/.test(lower)) {
    signals.push("Keep carbohydrate timing intentional and avoid late-night sugar.")
  }
  if (/\bcholesterol|ldl|triglyceride|blood pressure|hypertension\b/.test(lower)) {
    signals.push("Favor fiber, fish, olive oil, walking, and lower sodium meals.")
  }
  if (/\bstrength|muscle|hypertrophy|lift|gym\b/.test(lower)) {
    signals.push("Preserve strength work when readiness is acceptable.")
  }
  if (/\bcut|fat loss|weight loss|deficit|lean\b/.test(lower)) {
    signals.push("Keep the plan focused on a steady deficit, protein, and steps.")
  }
  return [...new Set(signals)].slice(0, 6)
}

export function summarizeHealthFile(name: string, text: string): HealthContextSummary {
  const clean = text.replace(/\s+/g, " ").trim()
  const signals = extractHealthSignals(clean)
  const lower = clean.toLowerCase()
  const topics = [
    /\binjur|pain|shoulder|knee|back|ankle|sciatica\b/.test(lower) ? "injury caution" : null,
    /\btravel|flight|jet lag|hotel\b/.test(lower) ? "travel constraints" : null,
    /\blow carb|keto|glucose|a1c|insulin\b/.test(lower) ? "glucose or carb rules" : null,
    /\bcholesterol|ldl|triglyceride|blood pressure|hypertension\b/.test(lower)
      ? "cardiometabolic markers"
      : null,
    /\bstrength|muscle|hypertrophy|lift|gym\b/.test(lower) ? "strength goals" : null,
    /\bcut|fat loss|weight loss|deficit|lean\b/.test(lower) ? "body composition goal" : null,
  ].filter(Boolean)
  const summary =
    topics.length > 0
      ? `${name}: ${topics.join(", ")} detected for ODIN coaching.`
      : `${name}: no specific health constraints detected; keep Withings-led coaching general.`

  return {
    name,
    uploadedAt: new Date().toISOString(),
    summary: summary.slice(0, 280),
    signals,
  }
}

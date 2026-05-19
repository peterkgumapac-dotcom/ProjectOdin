import { supabase } from "@/lib/supabaseClient"
import type { Json } from "@/types/database"

export type AgentJobType =
  | "slack_browser_scan"
  | "gmail_browser_scan"
  | "combined_doo_scan"
  | "browser_open"
  | "browser_observe"
  | "browser_agent_task"

export type AgentJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "login_required"
  | "awaiting_confirmation"
  | "cancelled"

export interface BrowserFinding {
  title: string
  source: string
  sourceUrl?: string
  snippet?: string
  sender?: string
  timeLabel?: string
  action?: string
}

export interface BrowserScanResult {
  source: "local_browser"
  kind: "slack" | "gmail" | "combined" | "generic"
  scannedAt: string
  summary: string
  items: BrowserFinding[]
  warnings?: string[]
  url?: string
  title?: string
  loginRequired?: boolean
  proposed_actions?: Array<{
    id: string
    type: string
    label: string
    target?: string
    risk?: string
    requires_confirmation?: boolean
  }>
}

export interface AgentJob {
  id: string
  user_id: string
  type: AgentJobType
  status: AgentJobStatus
  input: Record<string, unknown>
  result: BrowserScanResult | null
  error: string | null
  worker_id: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export async function createAgentJob(
  userId: string,
  type: AgentJobType,
  input: Record<string, unknown>
) {
  const { data, error } = await supabase
    .from("agent_jobs")
    .insert({ user_id: userId, type, input: input as Json, status: "queued" })
    .select("*")
    .single()
  return { data: (data as unknown as AgentJob | null) ?? null, error }
}

export async function createAgentJobResult(
  userId: string,
  type: AgentJobType,
  input: Record<string, unknown>,
  result: BrowserScanResult,
  status: AgentJobStatus = result.proposed_actions?.length
    ? "awaiting_confirmation"
    : "completed"
) {
  const { data, error } = await supabase
    .from("agent_jobs")
    .insert({
      user_id: userId,
      type,
      input: input as Json,
      result: result as unknown as Json,
      status,
      completed_at: status === "completed" ? new Date().toISOString() : null,
    })
    .select("*")
    .single()
  return { data: (data as unknown as AgentJob | null) ?? null, error }
}

export async function listAgentJobs(limit = 10) {
  const { data, error } = await supabase
    .from("agent_jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)
  return { data: (data as unknown as AgentJob[] | null) ?? [], error }
}

export async function getAgentJob(jobId: string) {
  const { data, error } = await supabase
    .from("agent_jobs")
    .select("*")
    .eq("id", jobId)
    .single()
  return { data: (data as unknown as AgentJob | null) ?? null, error }
}

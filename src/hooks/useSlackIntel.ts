import { useCallback, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import type { ClassifiedBusiness } from "@/lib/businessClassifier"
import type { OperationsSignalSource } from "@/types/operations"

export type IntelUrgency = "critical" | "high" | "medium" | "low"
export type IntelSource = OperationsSignalSource | "automation"

export interface IntelItem {
  source?: IntelSource
  business?: ClassifiedBusiness
  sourceUrl?: string
  sourceLabel?: string
  workspaceId?: string
  workspaceName?: string
  urgency: IntelUrgency
  workspace: string
  workspace_id?: string
  channel: string
  channel_id?: string
  ts?: string
  permalink?: string
  sent_at: string
  summary: string
  action: string
  evidence?: string
  reply?: string
  person?: string
  why_now?: string
}

export interface SlackIntelResult {
  items: IntelItem[]
  workspacesScanned: number
  channelsScanned: number
  messagesScanned: number
  warnings: string[]
  scannedAt: string | null
}

export interface SlackIntelScanOptions {
  accountId?: string
  channelId?: string
  channelName?: string
  dateFrom?: string
  dateTo?: string
}

export interface UseSlackIntelResult {
  scan: (options?: SlackIntelScanOptions) => Promise<void>
  loadCached: (options?: SlackIntelScanOptions) => void
  clear: () => void
  scanning: boolean
  error: string | null
  result: SlackIntelResult
}

const EMPTY: SlackIntelResult = {
  items: [],
  workspacesScanned: 0,
  channelsScanned: 0,
  messagesScanned: 0,
  warnings: [],
  scannedAt: null,
}

const CACHE_PREFIX = "odin.council.last-scan.v2"

function normalizeSlackIntelError(message: string): string {
  if (/\b(401|invalid_auth|not_authed|account_inactive|token_revoked|unauthorized)\b/i.test(message)) {
    return "Slack reconnect required: ODIN cannot read this workspace with the current token. Reconnect Slack in Connections, then scan again."
  }
  return message
}

function cacheKey(options: SlackIntelScanOptions = {}) {
  const accountId = options.accountId ?? "all"
  const channelId = options.channelId ?? "all"
  const dateFrom = options.dateFrom ?? "any"
  const dateTo = options.dateTo ?? "any"
  return [CACHE_PREFIX, accountId, channelId, dateFrom, dateTo]
    .map((part) => encodeURIComponent(part))
    .join(":")
}

function isIntelResult(value: unknown): value is SlackIntelResult {
  if (!value || typeof value !== "object") return false
  const result = value as Partial<SlackIntelResult>
  return (
    Array.isArray(result.items) &&
    typeof result.workspacesScanned === "number" &&
    typeof result.channelsScanned === "number" &&
    typeof result.messagesScanned === "number" &&
    Array.isArray(result.warnings) &&
    (typeof result.scannedAt === "string" || result.scannedAt === null)
  )
}

function readCachedResult(options: SlackIntelScanOptions = {}): SlackIntelResult {
  if (typeof window === "undefined") return EMPTY
  try {
    const raw = window.localStorage.getItem(cacheKey(options))
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as unknown
    return isIntelResult(parsed)
      ? { ...parsed, warnings: parsed.warnings ?? [] }
      : EMPTY
  } catch {
    return EMPTY
  }
}

function cacheResult(result: SlackIntelResult, options: SlackIntelScanOptions = {}) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(cacheKey(options), JSON.stringify(result))
  } catch {
    // The scan result still renders even when browser storage is unavailable.
  }
}

export async function runSlackIntelScan(
  options: SlackIntelScanOptions = {}
): Promise<SlackIntelResult> {
  const { data, error: fnError } = await supabase.functions.invoke<{
    data?: SlackIntelResult
    error?: string
  }>("slack-intel", { body: options })
  if (fnError) throw new Error(normalizeSlackIntelError(fnError.message))
  if (data?.error) throw new Error(normalizeSlackIntelError(data.error))
  if (!data?.data) throw new Error("Empty response from slack-intel")
  return {
    ...data.data,
    warnings: data.data.warnings ?? [],
  }
}

export function useSlackIntel(): UseSlackIntelResult {
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SlackIntelResult>(EMPTY)

  const scan = useCallback(async (options: SlackIntelScanOptions = {}) => {
    setScanning(true)
    setError(null)
    try {
      const next = await runSlackIntelScan(options)
      setResult(next)
      cacheResult(next, options)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed")
    } finally {
      setScanning(false)
    }
  }, [])

  const loadCached = useCallback((options: SlackIntelScanOptions = {}) => {
    setResult(readCachedResult(options))
    setError(null)
  }, [])

  const clear = useCallback(() => {
    setResult(EMPTY)
    setError(null)
    if (typeof window !== "undefined") {
      try {
        const prefix = `${CACHE_PREFIX}:`
        for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
          const key = window.localStorage.key(i)
          if (key?.startsWith(prefix)) window.localStorage.removeItem(key)
        }
      } catch {
        // Clearing the in-memory result is enough when storage is unavailable.
      }
    }
  }, [])

  return { scan, loadCached, clear, scanning, error, result }
}

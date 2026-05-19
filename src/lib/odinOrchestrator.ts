import { getFreshAuthHeaders, supabase } from "@/lib/supabaseClient"
import type { OperationsSignal } from "@/types/operations"

export type OdinCommandSource = "text" | "voice"
export type OdinTone = "standard" | "witty" | "formal"
export type OdinScanSource = "gmail" | "slack" | "calendar" | "health" | "weather" | "browser"
export type OdinCommandMode =
  | "chat"
  | "brief"
  | "slack"
  | "gmail"
  | "calendar"
  | "health"
  | "weather"
  | "browser"
  | "combined"
  | "research"

export interface OdinCommandRequest {
  query: string
  source: OdinCommandSource
  timezone: "Asia/Manila"
  mode?: OdinCommandMode
  tone?: OdinTone
  conversationId?: string
  turnId?: string
  visiblePage?: string
  recentContext?: string
  conversationHistory?: string
  weatherLocation?: OdinWeatherLocation
  useFreshScan?: boolean
  scanSources?: OdinScanSource[]
  scanWindowDays?: number
  skipSynthesis?: boolean
}

export interface OdinWeatherLocation {
  lat: number
  lon: number
  label: string
  source?: "default" | "browser" | "manual"
}

export interface OdinSourceLink {
  label: string
  url: string
  source: string
}

export interface OdinDraft {
  target: string
  text: string
  sourceUrl?: string
}

export interface OdinToolRun {
  tool: string
  status: "ok" | "partial" | "failed"
}

export interface OdinConversationState {
  activeTopic?: string
  lastSourceScan?: string
  unresolvedQuestion?: string | null
}

export interface OdinSourceFreshnessEntry {
  source: OdinScanSource
  status: "ok" | "partial" | "failed" | "missing"
  lastSuccessfulScanAt: string | null
  lastScanAt: string | null
  signalCount: number
  summary: string
  warnings: string[]
}

export type OdinSourceFreshness = Record<OdinScanSource, OdinSourceFreshnessEntry>

export interface OdinLearningSummary {
  memoriesUpdated: number
  rulesUpdated: number
  pendingUpdated: number
  eventsLogged: number
}

export interface OdinPendingSummary {
  needs_peter: number
  waiting_on_others: number
  today: number
  done_recently: number
}

export interface OdinCommandResponse {
  spokenText: string
  displayText: string
  signals: OperationsSignal[]
  sourceLinks: OdinSourceLink[]
  drafts: OdinDraft[]
  warnings: string[]
  toolRuns: OdinToolRun[]
  suggestions: string[]
  sourceFreshness?: OdinSourceFreshness
  learningSummary?: OdinLearningSummary
  pendingSummary?: OdinPendingSummary
  conversationState?: OdinConversationState
}

export interface OdinVoiceTranscript {
  text: string
  model?: string
}

export interface OdinVoiceSpeech {
  audioBase64: string
  mimeType: string
  voiceId?: string
  model?: string
}

export interface ElevenLabsSessionConfig {
  configured: boolean
  agentId: string | null
  voiceId: string | null
  signedUrl: string | null
  conversationToken: string | null
  widgetScriptUrl: string
  dynamicVariables: Record<string, string | number | boolean>
  error: string | null
}

interface FunctionEnvelope<T> {
  data?: T
  error?: string
}

const WEATHER_LOCATION_STORAGE_KEY = "odin.topbar.weatherLocation.v1"
const DEFAULT_WEATHER_LOCATION: OdinWeatherLocation = {
  lat: 14.1709,
  lon: 121.2437,
  label: "Laguna, PH",
  source: "default",
}

function isLegacyManilaDefault(location: Partial<OdinWeatherLocation>): boolean {
  const label = location.label?.toLowerCase() ?? ""
  const lat = typeof location.lat === "number" ? location.lat : null
  const lon = typeof location.lon === "number" ? location.lon : null
  return (
    label.includes("manila") ||
    (lat !== null &&
      lon !== null &&
      Math.abs(lat - 14.5995) < 0.01 &&
      Math.abs(lon - 120.9842) < 0.01)
  )
}

function readStoredWeatherLocation(): OdinWeatherLocation | undefined {
  if (typeof window === "undefined") return DEFAULT_WEATHER_LOCATION
  try {
    const raw = window.localStorage.getItem(WEATHER_LOCATION_STORAGE_KEY)
    if (!raw) return DEFAULT_WEATHER_LOCATION
    const parsed = JSON.parse(raw) as Partial<OdinWeatherLocation>
    if (
      typeof parsed.lat === "number" &&
      Number.isFinite(parsed.lat) &&
      typeof parsed.lon === "number" &&
      Number.isFinite(parsed.lon) &&
      typeof parsed.label === "string" &&
      parsed.label.trim()
    ) {
      if (isLegacyManilaDefault(parsed)) return DEFAULT_WEATHER_LOCATION
      return {
        lat: parsed.lat,
        lon: parsed.lon,
        label: parsed.label,
        source: parsed.source,
      }
    }
  } catch {
    // Weather location context is helpful, not required.
  }
  return DEFAULT_WEATHER_LOCATION
}

function friendlyFunctionError(message: string, label: string) {
  if (/\b(slack)\b/i.test(message) && /\b(401|unauthorized|invalid_auth|not_authed|token_revoked)\b/i.test(message)) {
    return "Slack reconnect required. Open Connections, reconnect Slack, then ask ODIN to scan again."
  }
  if (/non-2xx status code/i.test(message)) {
    return `${label} hit a backend error. I kept the app steady; try again in a moment, or use the details on screen if a partial result loaded.`
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return `${label} took too long to answer. Try a narrower request, like “calendar today” or “urgent Gmail from 7 days.”`
  }
  return message
}

export async function invokeOdinCommand(
  request: OdinCommandRequest
): Promise<OdinCommandResponse> {
  const body: OdinCommandRequest = {
    ...request,
    weatherLocation: request.weatherLocation ?? readStoredWeatherLocation(),
  }
  const invoke = async () =>
    supabase.functions.invoke<FunctionEnvelope<OdinCommandResponse>>(
      "odin-orchestrator",
      {
        body,
        headers: await getFreshAuthHeaders(),
      }
    )

  let { data, error } = await invoke()
  const shouldRetry =
    Boolean(error) &&
    /401|unauthorized|non-2xx status code/i.test(error?.message ?? "")

  if (shouldRetry) {
    await supabase.auth.refreshSession()
    ;({ data, error } = await invoke())
  }

  if (error) throw new Error(friendlyFunctionError(error.message, "ODIN"))
  if (data?.error) throw new Error(data.error)
  if (!data?.data) throw new Error("Empty response from odin-orchestrator")
  return {
    ...data.data,
    suggestions: Array.isArray(data.data.suggestions) ? data.data.suggestions : [],
    learningSummary: data.data.learningSummary ?? {
      memoriesUpdated: 0,
      rulesUpdated: 0,
      pendingUpdated: 0,
      eventsLogged: 0,
    },
    pendingSummary: data.data.pendingSummary ?? {
      needs_peter: 0,
      waiting_on_others: 0,
      today: 0,
      done_recently: 0,
    },
  }
}

export async function getElevenLabsSession(): Promise<ElevenLabsSessionConfig> {
  const { data, error } = await supabase.functions.invoke<
    FunctionEnvelope<ElevenLabsSessionConfig>
  >("elevenlabs-session", { body: {} })

  if (error) throw new Error(friendlyFunctionError(error.message, "ODIN voice"))
  if (data?.error) throw new Error(data.error)
  if (!data?.data) throw new Error("Empty response from elevenlabs-session")
  return data.data
}

export async function transcribeOdinVoice(
  audio: Blob
): Promise<OdinVoiceTranscript> {
  const audioBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result
      if (typeof result !== "string") {
        reject(new Error("Could not read voice recording"))
        return
      }
      resolve(result.split(",")[1] ?? "")
    }
    reader.onerror = () => reject(new Error("Could not read voice recording"))
    reader.readAsDataURL(audio)
  })

  const { data, error } = await supabase.functions.invoke<
    FunctionEnvelope<OdinVoiceTranscript>
  >("voice-transcribe", {
    body: {
      audioBase64,
      mimeType: audio.type || "audio/webm",
    },
  })

  if (error) throw new Error(friendlyFunctionError(error.message, "Voice transcription"))
  if (data?.error) throw new Error(data.error)
  if (!data?.data) throw new Error("Empty response from voice-transcribe")
  return data.data
}

export async function synthesizeOdinSpeech(
  text: string
): Promise<OdinVoiceSpeech> {
  const { data, error } = await supabase.functions.invoke<
    FunctionEnvelope<OdinVoiceSpeech>
  >("voice-speak", { body: { text } })

  if (error) throw new Error(friendlyFunctionError(error.message, "ODIN voice"))
  if (data?.error) throw new Error(data.error)
  if (!data?.data) throw new Error("Empty response from voice-speak")
  return data.data
}

export function formatOdinResponse(response: OdinCommandResponse): string {
  const lines = [response.displayText.trim()]

  if (response.signals.length > 0) {
    lines.push("", "Signals:")
    response.signals.slice(0, 5).forEach((signal, index) => {
      lines.push(`${index + 1}. ${signal.title}`)
      lines.push(signal.summary)
      if (signal.nextAction) lines.push(`Action: ${signal.nextAction}`)
      if (signal.evidence) lines.push(`Evidence: ${signal.evidence}`)
    })
  }

  if (response.sourceLinks.length > 0) {
    lines.push("", "Source links:")
    response.sourceLinks
      .slice(0, 6)
      .forEach((link) => lines.push(`- ${link.label}: ${link.url}`))
  }

  if (response.drafts.length > 0) {
    lines.push("", "Drafts:")
    response.drafts
      .slice(0, 3)
      .forEach((draft) => lines.push(`- ${draft.target}: ${draft.text}`))
  }

  if (response.suggestions?.length > 0) {
    lines.push("", "Try next:")
    response.suggestions
      .slice(0, 3)
      .forEach((suggestion) => lines.push(`- ${suggestion}`))
  }

  if (response.warnings.length > 0) {
    lines.push("", "Warnings:")
    response.warnings.slice(0, 5).forEach((warning) => lines.push(`- ${warning}`))
  }

  return lines.join("\n").trim()
}

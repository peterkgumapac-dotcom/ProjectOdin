import * as React from "react"
import { lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  Activity,
  Bed,
  CalendarDays,
  Cloud,
  Command,
  Footprints,
  HeartPulse,
  Mail,
  MessageSquare,
  Mic2,
  RefreshCw,
  Settings,
  Volume2,
  X,
  Zap,
} from "lucide-react"
import { useAuth } from "@/hooks/useAuth"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import { useTodayEvents } from "@/hooks/useTodayEvents"
import { useOperationsSignals } from "@/hooks/useOperationsSignals"
import { useOdinResponsibility } from "@/hooks/useOdinResponsibility"
import { useWithingsHealth } from "@/hooks/useWithingsHealth"
import type { UnifiedHubView } from "@/components/dashboard/UnifiedOperationsHub"
import {
  LightPageShell,
  ManilaMeta,
} from "@/components/dashboard/LightPageChrome"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import type { CalendarEvent } from "@/lib/connectors/calendar"
import type {
  OperationsSignal,
  OperationsSignalSource,
  OperationsSignalStatus,
  OperationsSourceHealth,
} from "@/types/operations"
import {
  invokeOdinCommand,
  synthesizeOdinSpeech,
  type OdinCommandResponse,
} from "@/lib/odinOrchestrator"
import {
  formatAgentBriefAge,
  hasAgentBriefAfter,
  summarizePending,
  summarizeAgentFreshness,
  type OdinAgentFreshness,
} from "@/lib/odinResponsibility"
import { queueStayMintyLiveSyncRequest } from "@/lib/agentBriefRequests"
import { publishLiveScanRefreshSignal } from "@/lib/liveScanRefresh"

const ChatPanel = lazy(() => import("@/components/chat/ChatPanel").then((module) => ({ default: module.ChatPanel })))
const MusicBoxWidget = lazy(() => import("@/components/dashboard/MusicBoxWidget").then((module) => ({ default: module.MusicBoxWidget })))
const OdinCommandPalette = lazy(() => import("@/components/dashboard/OdinCommandPalette").then((module) => ({ default: module.OdinCommandPalette })))

let odinVoiceConsoleImport: Promise<typeof import("@/components/dashboard/OdinVoiceConsole")> | null = null

function preloadOdinVoiceConsole() {
  odinVoiceConsoleImport ??= import("@/components/dashboard/OdinVoiceConsole")
  return odinVoiceConsoleImport
}

const OdinVoiceConsole = lazy(() =>
  preloadOdinVoiceConsole().then((module) => ({ default: module.OdinVoiceConsole }))
)

function MusicBoxFallback({ className = "" }: { className?: string }) {
  return (
    <div
      className={[
        "rounded-3xl border border-[#dfcfb1] bg-[#fffaf1]/80 p-5 shadow-[0_12px_34px_rgba(82,47,18,0.08)]",
        className,
      ].join(" ")}
      aria-hidden="true"
    >
      <div className="h-3 w-20 rounded-full bg-[#ead9bd]" />
      <div className="mt-4 h-5 w-36 rounded-full bg-[#dfcfb1]" />
      <div className="mt-5 flex gap-2">
        <span className="h-9 w-9 rounded-full bg-[#f2dfc2]" />
        <span className="h-9 w-9 rounded-full bg-[#b6531c]/70" />
        <span className="h-9 w-9 rounded-full bg-[#f2dfc2]" />
      </div>
    </div>
  )
}

type DashboardMode = "hub" | "operations"
type OdinTimeZoneCard = {
  id: string
  label: string
  timeZone: string
}
type VoiceSurfaceStatus =
  | "idle"
  | "wake"
  | "connecting"
  | "listening"
  | "speaking"
  | "online"
  | "thinking"
  | "error"

type ListenerPhase =
  | "idle"
  | "wake"
  | "connecting"
  | "listening"
  | "speaking"
  | "blocked"

type VoiceInputState =
  | "standby"
  | "wake"
  | "hearing"
  | "captured"
  | "thinking"
  | "speaking"
  | "blocked"

type OdinDigestPhase = "idle" | "received" | "routing" | "digesting" | "ready" | "error"
type OdinSignalState =
  | "idle"
  | "ready"
  | "receiving"
  | "digesting"
  | "responding"
  | "scanning"
  | "blocked"

interface VoiceSurfaceState {
  active: boolean
  status: VoiceSurfaceStatus
  message: string
  latest: OdinCommandResponse | null
  error: string | null
  micLevel: number
  micLive: boolean
  voiceDetected: boolean
  listenerPhase: ListenerPhase
  transcript?: string
  wakeArmed?: boolean
  wakeSupported?: boolean
  wakeTranscript?: string
  wakeLastHeardAt?: string | null
  wakeError?: string | null
  inputState?: VoiceInputState
  digestPhase?: OdinDigestPhase
  digestElapsedMs?: number
}

type AgentBriefRefreshState = {
  state: "idle" | "requesting" | "fresh" | "stale"
  startedAt: string | null
  latestAt: string | null
  message: string
}

type OdinNoticeTone = "default" | "urgent" | "quiet"
type OdinOrbState = "idle" | "listening" | "thinking" | "speaking" | "executing" | "urgent"

interface OdinNotice {
  id: string
  label: string
  title: string
  detail?: string
  tone?: OdinNoticeTone
  to?: string
}

const EYE_CLICK_DRAG_THRESHOLD = 28
const AGENT_BRIEF_WAIT_MS = 25_000
const AGENT_BRIEF_POLL_MS = 1_500
const MORNING_BRIEF_COMMAND =
  "Good morning ODIN. Give Peter a concise executive update, like a personal operations aide. Use the current agent-fed queue first. Say the overall state, the single issue that matters most, why it needs Peter, and one next move. Do not read source-by-source sections, full emails, or full Slack messages. If source data is stale, say that briefly. Max 60 spoken words. No bullets."
const MORNING_BRIEF_SPEECH_LIMIT = 280
const VOICE_START_GUARD_MS = 650
const TIMEZONE_STORAGE_KEY = "odin.timezones.v1"
const DEFAULT_TIME_ZONES: OdinTimeZoneCard[] = [
  { id: "home", label: "Manila", timeZone: "Asia/Manila" },
  { id: "west", label: "San Francisco", timeZone: "America/Los_Angeles" },
  { id: "uk", label: "London", timeZone: "Europe/London" },
]

function portalRequestedFromSearch(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.get("portal") === "open"
}

function portalRequestedFromCurrentLocation(): boolean {
  return (
    typeof window !== "undefined" &&
    portalRequestedFromSearch(window.location.search)
  )
}

const TIMEZONE_OPTIONS = [
  { label: "Manila", timeZone: "Asia/Manila" },
  { label: "Nashville", timeZone: "America/Chicago" },
  { label: "San Francisco", timeZone: "America/Los_Angeles" },
  { label: "London", timeZone: "Europe/London" },
  { label: "Oslo", timeZone: "Europe/Oslo" },
  { label: "New York", timeZone: "America/New_York" },
  { label: "Tokyo", timeZone: "Asia/Tokyo" },
  { label: "Sydney", timeZone: "Australia/Sydney" },
]
const SOURCE_ICON_PATHS: Record<string, string> = {
  slack: "/odin-core/slack.svg",
  gmail: "/odin-core/gmail.svg",
  calendar: "/odin-core/calendar.svg",
  health: "/odin-core/heartbeat.svg",
  weather: "/odin-core/system-pulse.svg",
  system: "/odin-core/system-pulse.svg",
  warning: "/odin-core/warning.svg",
  sleep: "/odin-core/sleep.svg",
  steps: "/odin-core/steps.svg",
}
const SOURCE_HEALTH_LABELS: Record<OperationsSourceHealth["id"], string> = {
  gmail: "Gmail",
  slack: "Slack",
  calendar: "Calendar",
  health: "Withings",
  weather: "Weather",
  browser: "Browser",
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function eventStart(event: CalendarEvent): Date | null {
  const raw = event.start?.dateTime ?? event.start?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function timeLabel(date: Date | null): string {
  if (!date) return "ALL DAY"
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function upcomingEvents(
  events: CalendarEvent[],
  limit: number
): Array<{ event: CalendarEvent; start: Date }> {
  const nowFloor = Date.now() - 15 * 60 * 1000
  return events
    .map((event) => ({ event, start: eventStart(event) }))
    .filter((entry): entry is { event: CalendarEvent; start: Date } => {
      const start = entry.start
      return start instanceof Date && Number.isFinite(start.getTime()) && start.getTime() >= nowFloor
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, limit)
}

function formatSleep(minutes?: number | null): string | null {
  if (!minutes) return null
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function compactNumber(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`
  return value.toLocaleString()
}

function decodeHtmlEntities(value: string): string {
  if (!value) return ""
  if (typeof document === "undefined") {
    return value
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
  }
  const parser = document.createElement("textarea")
  let decoded = value
  for (let pass = 0; pass < 3; pass += 1) {
    parser.innerHTML = decoded
    const next = parser.value
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

function stripMarkup(value?: string | null): string {
  if (!value) return ""
  const decoded = decodeHtmlEntities(value)
  return decodeHtmlEntities(
    decoded
      .replace(/<[^>]+>/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/<[^>]+>/g, " ")
}

function shortText(value?: string | null, max = 96): string {
  const text = stripMarkup(value).replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function isStaleBriefSource(source: OperationsSignalSource): boolean {
  return (
    source === "slack" ||
    source === "gmail" ||
    source === "manual" ||
    source === "browser" ||
    source === "memory" ||
    source === "research"
  )
}

function cleanSpeechText(value?: string | null): string {
  return (value ?? "")
    .replace(/[*_`#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function trimAtSentence(value: string, max = MORNING_BRIEF_SPEECH_LIMIT): string {
  const text = cleanSpeechText(value)
  if (text.length <= max) return text
  const clipped = text.slice(0, max)
  const sentenceEnd = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?")
  )
  if (sentenceEnd > max * 0.55) return clipped.slice(0, sentenceEnd + 1).trim()
  const wordEnd = clipped.lastIndexOf(" ")
  return `${clipped.slice(0, wordEnd > 0 ? wordEnd : max - 1).trim()}.`
}

function morningSignalUrgency(signal?: OperationsSignal): string {
  if (!signal) return "quiet"
  if (signal.category === "urgent") return "urgent"
  if (signal.category === "waiting") return "waiting on Peter"
  if (signal.category === "today") return "today"
  if (signal.category === "follow_up") return "follow-up"
  return "low"
}

function naturalMorningIssue(signal: OperationsSignal): string {
  const title = contextualSignalTitle(signal).replace(/\.$/, "")
  const detail = contextualSignalDetail(signal, 150)
    .replace(/^Needs Peter:\s*/i, "")
    .replace(/^Today:\s*/i, "")
    .replace(/^Follow-up:\s*/i, "")
    .replace(/^Slack:\s*/i, "")
    .replace(/^Gmail:\s*/i, "")
    .replace(/^Calendar:\s*/i, "")
    .replace(/\.$/, "")
  const urgency = morningSignalUrgency(signal)
  const urgencyText =
    urgency === "urgent"
      ? "This is the one I would not let age politely"
      : urgency === "waiting on Peter"
        ? "It appears to be waiting on your call"
        : urgency === "today"
          ? "It belongs in today's lane"
          : "It is the cleanest next item"
  return `${title}: ${detail}. ${urgencyText}.`
}

function conciseMorningBrief(response: OdinCommandResponse): OdinCommandResponse {
  const primarySignal =
    response.signals.find((signal) => signal.category !== "quiet") ?? response.signals[0]
  const openCount = response.pendingSummary?.needs_peter || response.signals.length
  const oneTopicBrief = primarySignal
    ? [
        `Good morning, Peter. ${openCount > 1 ? `${openCount} items are on the board, but one needs the chair.` : "One item needs the chair."}`,
        naturalMorningIssue(primarySignal),
      ].join(" ")
    : response.spokenText ||
      response.displayText ||
      "Good morning, Peter. The board is quiet for now, which is either progress or a well-dressed ambush."
  const spokenText = trimAtSentence(oneTopicBrief)
  return {
    ...response,
    spokenText,
    displayText: primarySignal
      ? [
          spokenText,
          "",
          `Top priority: ${contextualSignalTitle(primarySignal)}`,
          `Why: ${contextualSignalDetail(primarySignal, 220)}`,
          `Next: ${primarySignal.nextAction ?? primarySignal.summary}`,
        ].join("\n")
      : spokenText,
    signals: response.signals.slice(0, 2),
    sourceLinks: response.sourceLinks.slice(0, 3),
    drafts: response.drafts.slice(0, 1),
    warnings: response.warnings.slice(0, 2),
    suggestions: response.suggestions.slice(0, 2),
  }
}

function timeZoneLabel(timeZone: string): string {
  return TIMEZONE_OPTIONS.find((option) => option.timeZone === timeZone)?.label ?? timeZone
}

function loadTimeZones(): OdinTimeZoneCard[] {
  if (typeof window === "undefined") return DEFAULT_TIME_ZONES
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TIMEZONE_STORAGE_KEY) ?? "null")
    if (!Array.isArray(parsed)) return DEFAULT_TIME_ZONES
    const normalized = parsed
      .slice(0, 3)
      .map((item, index) => {
        const timeZone = typeof item?.timeZone === "string" ? item.timeZone : null
        if (!timeZone || !TIMEZONE_OPTIONS.some((option) => option.timeZone === timeZone)) {
          return null
        }
        return {
          id: typeof item?.id === "string" ? item.id : `zone-${index}`,
          label: typeof item?.label === "string" ? item.label : timeZoneLabel(timeZone),
          timeZone,
        }
      })
      .filter(Boolean) as OdinTimeZoneCard[]
    return normalized.length === 3 ? normalized : DEFAULT_TIME_ZONES
  } catch {
    return DEFAULT_TIME_ZONES
  }
}

function zoneClock(timeZone: string): string {
  return new Date().toLocaleTimeString([], {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function nextEvent(events: CalendarEvent[]): CalendarEvent | null {
  const now = Date.now()
  return (
    [...events]
      .sort((a, b) => {
        const aStart = eventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER
        const bStart = eventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER
        return aStart - bStart
      })
      .find((event) => (eventStart(event)?.getTime() ?? now) >= now) ??
    events[0] ??
    null
  )
}

function signalPriorityRank(signal: OperationsSignal): number {
  const categoryRank =
    signal.category === "urgent" ? 0 :
    signal.category === "waiting" || signal.status === "waiting" ? 1 :
    signal.category === "today" ? 2 :
    signal.category === "follow_up" ? 3 :
    signal.category === "routine" ? 4 :
    5
  const businessRank =
    signal.business === "Stay Minty" ? 0 :
    signal.business === "Dinbnb" ? 1 :
    signal.business === "Personal" ? 2 :
    3
  const text = [
    signal.person,
    signal.title,
    signal.summary,
    signal.nextAction,
  ].filter(Boolean).join(" ")
  const ownerRank =
    /\b(meredith|owner|will|millbrig|reveen|kelli|coleene|shiela|peter needs|needs peter)\b/i.test(text)
      ? 0
      : /open gmail threads/i.test(signal.title)
        ? 2
        : 1
  const sourceRank =
    signal.source === "slack" ? 0 :
    signal.source === "gmail" ? 1 :
    signal.source === "calendar" ? 2 :
    3
  return categoryRank * 1000 + businessRank * 100 + ownerRank * 10 + sourceRank
}

function sortSignalsForPeter(signals: OperationsSignal[]): OperationsSignal[] {
  return [...signals].sort((a, b) => signalPriorityRank(a) - signalPriorityRank(b))
}

function signalContextText(signal?: OperationsSignal | null): string {
  return [
    signal?.person,
    signal?.business,
    signal?.title,
    signal?.summary,
    signal?.evidence,
    signal?.nextAction,
  ]
    .filter(Boolean)
    .join(" ")
}

function contextualSignalTitle(signal?: OperationsSignal | null): string {
  if (!signal) return "ODIN is quiet"
  const text = signalContextText(signal)
  const upper = text.toUpperCase()
  const property = upper.match(/\b(NSV|TYS|GDC|STL|HT\d+|SIGB|SIGC|M\d+|CR\d+|[0-9]+-MRD|[0-9]+-NF|[0-9]+-MD)\b/)?.[0]
  const person = signal.person ?? text.match(/\b(Meredith|Reveen|Kelli|Coleene|Shiela|Cha|Jessica|Eric|Eana|Kim)\b/i)?.[0]

  if (/billables?|work orders?|track update|approved column/i.test(text)) {
    return person ? `${person} billables need alignment` : "Billables need alignment"
  }
  if (/last minute|arrival|check.?in|door|code|lock|access/i.test(text)) {
    const issue = property ? `${property} arrival risk` : "arrival/access risk"
    return person ? `${person}: ${issue}` : "Arrival risk needs eyes"
  }
  if (/owner approval|approval|deposit|signature|quote|over \$?250|budget/i.test(text)) {
    return person ? `${person} approval path` : "Owner approval path"
  }
  if (/maintenance|leak|plumb|hvac|repair|vendor/i.test(text)) {
    return property ? `${property} maintenance risk` : "Maintenance risk surfaced"
  }
  if (/lead|stellara|conversion|follow.?up/i.test(text)) {
    return "Stellara follow-up window"
  }
  if (signal.source === "calendar") {
    const cleaned = signal.title
      .replace(/^Weekly Meeting - /i, "")
      .replace(/^Calendar:?\s*/i, "")
    return shortText(cleaned, 42) || "Calendar commitment"
  }
  if (signal.source === "gmail" && person) return `${person} email needs reply`
  if (signal.source === "slack" && person) return `${person} needs attention`
  return shortText(signal.title, 42)
}

function contextualSignalDetail(signal?: OperationsSignal | null, max = 92): string {
  if (!signal) return "No live item is asking for Peter's call."
  const action = signal.nextAction ?? signal.summary
  const source =
    signal.source === "slack"
      ? "Slack"
      : signal.source === "gmail"
        ? "Gmail"
        : signal.source === "calendar"
          ? "Calendar"
          : signal.source
  const urgency =
    signal.category === "urgent" || signal.status === "waiting"
      ? "Needs Peter"
      : signal.category === "today"
        ? "Today"
        : signal.category === "follow_up"
          ? "Follow-up"
          : source
  return shortText(`${urgency}: ${action}`, max)
}

function orbStateFromVoice(
  voiceState: VoiceSurfaceState,
  options: { loading?: boolean; urgent?: boolean; executing?: boolean } = {}
): OdinOrbState {
  if (options.urgent || voiceState.status === "error" || voiceState.listenerPhase === "blocked") {
    return "urgent"
  }
  if (options.executing) return "executing"
  if (voiceState.listenerPhase === "speaking" || voiceState.status === "speaking") return "speaking"
  if (voiceState.status === "thinking" || options.loading) return "thinking"
  if (
    voiceState.voiceDetected ||
    voiceState.listenerPhase === "listening" ||
    voiceState.listenerPhase === "wake" ||
    voiceState.status === "listening" ||
    voiceState.status === "wake" ||
    voiceState.status === "online"
  ) {
    return "listening"
  }
  return "idle"
}

function formatSignalElapsed(ms?: number): string | null {
  if (!ms || ms < 1000) return null
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`
}

function odinSignalFromVoice(
  voiceState: VoiceSurfaceState,
  options: { scanRefreshing?: boolean; morningBriefing?: boolean } = {}
): { state: OdinSignalState; label: string; detail: string | null; active: boolean } {
  if (
    voiceState.status === "error" ||
    voiceState.listenerPhase === "blocked" ||
    voiceState.inputState === "blocked" ||
    voiceState.digestPhase === "error"
  ) {
    return {
      state: "blocked",
      label: "Channel needs attention",
      detail: voiceState.error ? "voice fault" : "mic blocked",
      active: true,
    }
  }

  if (
    voiceState.listenerPhase === "speaking" ||
    voiceState.status === "speaking" ||
    voiceState.inputState === "speaking"
  ) {
    return {
      state: "responding",
      label: options.morningBriefing ? "Briefing aloud" : "ODIN responding",
      detail: null,
      active: true,
    }
  }

  if (options.scanRefreshing) {
    return {
      state: "scanning",
      label: "Live scan running",
      detail: "sources",
      active: true,
    }
  }

  const digesting =
    options.morningBriefing ||
    voiceState.listenerPhase === "connecting" ||
    voiceState.status === "thinking" ||
    voiceState.status === "connecting" ||
    voiceState.inputState === "captured" ||
    voiceState.inputState === "thinking" ||
    voiceState.digestPhase === "received" ||
    voiceState.digestPhase === "routing" ||
    voiceState.digestPhase === "digesting"

  if (digesting) {
    return {
      state: "digesting",
      label:
        voiceState.digestPhase === "received"
          ? "Words received"
          : voiceState.digestPhase === "routing"
            ? "Routing intent"
            : options.morningBriefing
              ? "Preparing brief"
              : "ODIN digesting",
      detail: formatSignalElapsed(voiceState.digestElapsedMs),
      active: true,
    }
  }

  if (voiceState.voiceDetected || voiceState.inputState === "hearing") {
    return {
      state: "receiving",
      label: "Receiving voice",
      detail: null,
      active: true,
    }
  }

  if (
    voiceState.micLive ||
    voiceState.wakeArmed ||
    voiceState.listenerPhase === "listening" ||
    voiceState.listenerPhase === "wake" ||
    voiceState.status === "listening" ||
    voiceState.status === "wake" ||
    voiceState.status === "online"
  ) {
    return {
      state: "ready",
      label: "Channel armed",
      detail: null,
      active: false,
    }
  }

  return {
    state: "idle",
    label: "Channel quiet",
    detail: null,
    active: false,
  }
}

function statusCopy(signal: OperationsSignal): string {
  if (signal.status === "handled") return "done"
  if (signal.status === "deferred") return "deferred"
  if (signal.status === "waiting") return "waiting"
  if (signal.category === "urgent") return "urgent"
  if (signal.category === "today") return "today"
  return signal.source
}

function timeAgo(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return statusCopy({
    id: value,
    source: "system",
    category: "quiet",
    title: value,
    summary: value,
    status: "open",
  })
  const diff = date.getTime() - Date.now()
  const abs = Math.abs(diff)
  const minutes = Math.max(1, Math.round(abs / 60_000))
  const suffix = diff >= 0 ? "in " : ""
  const trail = diff >= 0 ? "" : " ago"
  if (minutes < 60) return `${suffix}${minutes}m${trail}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${suffix}${hours}h${trail}`
  const days = Math.round(hours / 24)
  return `${suffix}${days}d${trail}`
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, a, input, textarea, select, [role='button']"))
  )
}

export function Dashboard() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const {
    google,
    slack,
    withings,
    loading: accountsLoading,
  } = useConnectedAccounts()
  const googleConnected = !accountsLoading && google.length > 0
  const { events, loading: eventsLoading, error: eventsError, checkedAt: eventsCheckedAt, refresh: refreshEvents } =
    useTodayEvents(google)
  const calendarLoading = accountsLoading || eventsLoading
  const calendarDisconnected = !accountsLoading && google.length === 0
  const calendarNeedsAttention = !calendarLoading && googleConnected && Boolean(eventsError)
  const {
    signals = [],
    sourceHealth = [],
    setSignalStatus,
    loading: signalsLoading,
  } = useOperationsSignals({
    googleAccounts: google,
    slackAccounts: slack,
    events,
    eventsLoading,
    eventsError,
    eventsCheckedAt,
  })
  const withingsHealth = useWithingsHealth(withings)
  const odinResponsibility = useOdinResponsibility(user?.id)
  const odinSignalsLoading = signalsLoading || odinResponsibility.loading

  const [mode, setMode] = useState<DashboardMode>(() =>
    portalRequestedFromCurrentLocation() ? "operations" : "hub"
  )
  const [operationsView, setOperationsView] = useState<UnifiedHubView>("priority")
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [portalAnimating, setPortalAnimating] = useState(false)
  const [portalPull, setPortalPull] = useState(() =>
    portalRequestedFromCurrentLocation() ? 1 : 0
  )
  const [chatOpen, setChatOpen] = useState(false)
  const [chatDraft, setChatDraft] = useState<string | undefined>(undefined)
  const [chatAutoSubmitKey, setChatAutoSubmitKey] = useState(0)
  const [voiceInitialCommand, setVoiceInitialCommand] = useState<string | undefined>()
  const [voiceAutoStartKey, setVoiceAutoStartKey] = useState(0)
  const [voiceStopKey, setVoiceStopKey] = useState(0)
  const [voiceControllerKey, setVoiceControllerKey] = useState(0)
  const [voiceControllerMounted, setVoiceControllerMounted] = useState(false)
  const [scanRefreshing, setScanRefreshing] = useState(false)
  const [latestScanResponse, setLatestScanResponse] = useState<OdinCommandResponse | null>(null)
  const [agentBriefRefresh, setAgentBriefRefresh] = useState<AgentBriefRefreshState>({
    state: "idle",
    startedAt: null,
    latestAt: null,
    message: "Fresh source briefs are required for Slack and Gmail.",
  })
  const [morningBriefing, setMorningBriefing] = useState(false)
  const processedDashboardAction = useRef<string | null>(null)
  const [timeZoneCards, setTimeZoneCards] = useState<OdinTimeZoneCard[]>(loadTimeZones)
  const [voiceState, setVoiceState] = useState<VoiceSurfaceState>({
    active: false,
    status: "idle",
    message: "ODIN is standing by.",
    latest: null,
    error: null,
    micLevel: 0,
    micLive: false,
    voiceDetected: false,
    listenerPhase: "idle",
  })
  const [command, setCommand] = useState("")
  const dragStartX = useRef<number | null>(null)
  const dragStartY = useRef<number | null>(null)
  const dragSource = useRef<"page" | "eye" | null>(null)
  const modeRef = useRef<DashboardMode>(mode)
  const suppressNextEyeClick = useRef(false)
  const morningBriefAudio = useRef<HTMLAudioElement | null>(null)
  const morningBriefRequest = useRef(0)
  const lastVoiceStartRequestAt = useRef(0)

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  useEffect(() => {
    if (!portalRequestedFromSearch(location.search)) return
    if (modeRef.current === "operations") return
    modeRef.current = "operations"
    setPortalPull(1)
    setPortalAnimating(false)
    setMode("operations")
  }, [location.search])

  useEffect(() => {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, JSON.stringify(timeZoneCards))
  }, [timeZoneCards])

  // OdinVoiceConsole is loaded lazily on first user interaction. The previous
  // idle-time prewarm forced a 560 KB chunk download in the background of every
  // dashboard mount, which hurt LCP for users who never opened voice.

  const updateTimeZoneCard = useCallback((index: number, timeZone: string) => {
    setTimeZoneCards((cards) =>
      cards.map((card, cardIndex) =>
        cardIndex === index ? { ...card, timeZone, label: timeZoneLabel(timeZone) } : card
      )
    )
  }, [])
  const suppressStaleExternalSignals =
    agentBriefRefresh.state === "stale" || odinResponsibility.agentFreshness.stale
  const displayedSignals = useMemo(() => {
    const merged = new Map<string, OperationsSignal>()
    const liveScanSignals = suppressStaleExternalSignals
      ? []
      : latestScanResponse?.signals ?? []
    const refreshedSources = new Set(liveScanSignals.map((signal) => signal.source))

    for (const signal of signals) {
      if (suppressStaleExternalSignals && isStaleBriefSource(signal.source)) {
        continue
      }
      if (!refreshedSources.has(signal.source)) merged.set(signal.id, signal)
    }
    for (const signal of odinResponsibility.signals) {
      if (suppressStaleExternalSignals) {
        continue
      }
      if (!refreshedSources.has(signal.source)) merged.set(signal.id, signal)
    }
    for (const signal of liveScanSignals) {
      if (suppressStaleExternalSignals && isStaleBriefSource(signal.source)) {
        continue
      }
      merged.set(signal.id, signal)
    }
    return sortSignalsForPeter([...merged.values()])
  }, [
    suppressStaleExternalSignals,
    latestScanResponse?.signals,
    odinResponsibility.signals,
    signals,
  ])
  const responsibilitySignalIds = useMemo(
    () => new Set(odinResponsibility.signals.map((signal) => signal.id)),
    [odinResponsibility.signals]
  )
  const handleSignalStatusChange = useCallback(
    async (id: string, status: OperationsSignalStatus) => {
      if (responsibilitySignalIds.has(id)) {
        await odinResponsibility.setPendingStatus(id, status)
        return
      }
      setSignalStatus(id, status)
    },
    [odinResponsibility, responsibilitySignalIds, setSignalStatus]
  )
  const activeQueueSignals = useMemo(
    () =>
      displayedSignals.filter(
        (signal) => signal.status === "open" || signal.status === "waiting"
      ),
    [displayedSignals]
  )
  const actionSignals = useMemo(
    () =>
      activeQueueSignals.filter(
        (signal) =>
          signal.category !== "quiet" &&
          signal.category !== "routine" &&
          signal.source !== "system" &&
          (!suppressStaleExternalSignals || !isStaleBriefSource(signal.source))
      ),
    [activeQueueSignals, suppressStaleExternalSignals]
  )
  const meeting = nextEvent(events)
  const meetingStart = eventStart(meeting ?? ({} as CalendarEvent))
  const sleep = formatSleep(withingsHealth.summary?.sleep.durationMinutes)
  const heart = withingsHealth.summary?.heartRate.bpm
  const withingsNeedsReconnect =
    !!withingsHealth.summary?.needsReconnect ||
    /reconnect|refresh_token|authorization expired/i.test(
      withingsHealth.error?.message ?? ""
    )
  const vitalsText =
    withings.length === 0
      ? "Connect Withings"
      : withingsNeedsReconnect
        ? "Reconnect Withings"
      : withingsHealth.loading && !withingsHealth.summary
        ? "Reading vitals"
        : `${heart ? `${heart} bpm` : "Pulse quiet"} · ${sleep ?? "sleep pending"}`
  const allSourceHealth = useMemo<OperationsSourceHealth[]>(
    () => {
      const byId = new Map<OperationsSourceHealth["id"], OperationsSourceHealth>()
      for (const source of sourceHealth) byId.set(source.id, source)
      for (const source of odinResponsibility.sourceHealth) byId.set(source.id, source)
      byId.set("health", {
        id: "health",
        label: "Withings",
        state:
          withings.length === 0
            ? "disconnected"
            : withingsHealth.loading
              ? "syncing"
              : withingsNeedsReconnect || withingsHealth.error
                ? "attention"
                : "healthy",
        detail:
          withings.length === 0
            ? "Connect Withings for vitals"
            : withingsHealth.loading
              ? "Reading latest vitals"
              : withingsNeedsReconnect
                ? "Reconnect Withings to restore live vitals"
              : withingsHealth.error
                ? withingsHealth.error.message
                : withingsHealth.summary
                  ? `Cached: ${vitalsText}. Refresh only when you scan.`
                  : "Withings connected; run Scan to read latest vitals",
        checkedAt: withingsHealth.checkedAt ?? byId.get("health")?.checkedAt,
      })
      for (const source of Object.values(latestScanResponse?.sourceFreshness ?? {})) {
        const checkedAt = source.lastSuccessfulScanAt ?? source.lastScanAt ?? undefined
        byId.set(source.source, {
          id: source.source,
          label: SOURCE_HEALTH_LABELS[source.source],
          state:
            source.status === "ok"
              ? "healthy"
              : source.status === "partial"
                ? "attention"
                : source.status === "missing"
                  ? "disconnected"
                  : "attention",
          detail: [
            source.summary || "Last known source brief.",
            checkedAt ? `scanned ${timeAgo(checkedAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          checkedAt,
        })
      }
      const agentHealthState = odinResponsibility.agentFreshness.latestAt && !odinResponsibility.agentFreshness.stale
        ? "healthy"
        : "attention"
      const agentHealthDetail =
        agentBriefRefresh.state === "requesting"
          ? agentBriefRefresh.message
          : agentBriefRefresh.state === "stale"
            ? agentBriefRefresh.message
            : odinResponsibility.agentFreshness.detail
      byId.set("slack", {
        id: "slack",
        label: "Slack agent brief",
        state: agentHealthState,
        detail: agentHealthDetail,
        checkedAt: odinResponsibility.agentFreshness.latestAt ?? undefined,
      })
      byId.set("gmail", {
        id: "gmail",
        label: "Gmail agent brief",
        state: agentHealthState,
        detail: agentHealthDetail,
        checkedAt: odinResponsibility.agentFreshness.latestAt ?? undefined,
      })
      return [...byId.values()]
    },
    [
      agentBriefRefresh.message,
      agentBriefRefresh.state,
      odinResponsibility.agentFreshness,
      latestScanResponse?.sourceFreshness,
      odinResponsibility.sourceHealth,
      sourceHealth,
      vitalsText,
      withings.length,
      withingsHealth.error,
      withingsHealth.checkedAt,
      withingsHealth.loading,
      withingsHealth.summary,
      withingsNeedsReconnect,
    ]
  )
  const refreshHomeScan = useCallback(async () => {
    if (scanRefreshing) return
    const startedAt = new Date()
    const startedIso = startedAt.toISOString()
    publishLiveScanRefreshSignal({
      reason: "dashboard_live_scan",
      requestedAt: startedIso,
      sources: ["all", "calendar", "gmail", "slack", "weather", "health", "council"],
    })
    setScanRefreshing(true)
    setAgentBriefRefresh({
      state: "requesting",
      startedAt: startedIso,
      latestAt: odinResponsibility.agentFreshness.latestAt,
      message: "Requesting a scoped Stay Minty brief from Claude: label:stayminty, Smokies/Nashville, and weekly priority docs.",
    })
    setVoiceState((state) => ({
      ...state,
      status: "thinking",
      message: "Queueing Claude/Codex source scan...",
      error: null,
      listenerPhase: "connecting",
      inputState: "thinking",
      digestPhase: "routing",
      digestElapsedMs: 0,
    }))
    try {
      let scanResponse: OdinCommandResponse | null = null
      if (!user?.id) {
        throw new Error("Live Scan needs an active user session.")
      }
      const agentJob = await queueStayMintyLiveSyncRequest({
        userId: user.id,
        requestedAt: startedIso,
        requestedBy: "dashboard_live_scan",
        scanWindowDays: 7,
      })
      if (agentJob.error) {
        throw new Error(agentJob.error.message)
      }
      setAgentBriefRefresh((state) => ({
        ...state,
        message: agentJob.data?.id
          ? `Stay Minty Claude brief queued (${agentJob.data.id.slice(0, 8)}). Waiting for fresh /ingest results.`
          : "Stay Minty Claude brief queued. Waiting for fresh /ingest results.",
      }))
      setVoiceState((state) => ({
        ...state,
        message: "Stay Minty brief queued. Waiting for fresh ingest...",
      }))
      const scanPromise = user?.id
        ? invokeOdinCommand({
          query: "Refresh ODIN Scan from agent-ingested sources only. Request status for the scoped Stay Minty Claude brief: Gmail label stayminty, Smokies/Nashville focus, and the two weekly Google Docs as priority anchors. Do not run direct Slack or Gmail polling. If no fresh ingest brief arrives, say that clearly and keep old items marked last-known only. Always refresh Calendar, Withings, and weather where available. Keep voice short.",
          source: "text",
          timezone: "Asia/Manila",
          mode: "combined",
          skipSynthesis: true,
          useFreshScan: true,
          scanSources: ["slack", "gmail", "calendar", "health", "weather"],
          scanWindowDays: 7,
          conversationId: `agent-refresh-${startedAt.getTime()}`,
          turnId: crypto.randomUUID(),
          visiblePage: window.location.pathname,
          recentContext:
            `Hall Live Scan started at ${startedIso}. Stay Minty priorities must come from a fresh claude_stayminty /ingest brief created after that time. Scope: label:stayminty Gmail only, Smokies/Nashville focus, and weekly Google Docs as priority sources. If none arrive, report stale/missing agent brief status instead of repeating old pending rows.`,
        })
          .then((response) => {
            scanResponse = response
            setLatestScanResponse(response)
            return response
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : "ODIN backend check failed."
            setAgentBriefRefresh((state) =>
              state.state === "requesting"
                ? {
                    ...state,
                    message:
                      "Claude/Codex scan request is queued. Backend status check failed; waiting for /ingest.",
                  }
                : state
            )
            console.warn("[ODIN] Live Scan backend check failed", message)
            return null
          })
        : Promise.resolve(null)
      const eventRefreshPromise = refreshEvents().catch(() => undefined)

      let snapshot = await odinResponsibility.refreshAndGet()
      let freshAgentBrief = hasAgentBriefAfter(snapshot.items, startedAt, "Stay Minty")
      const deadline = Date.now() + AGENT_BRIEF_WAIT_MS
      while (!freshAgentBrief && Date.now() < deadline) {
        await wait(AGENT_BRIEF_POLL_MS)
        snapshot = await odinResponsibility.refreshAndGet()
        freshAgentBrief = hasAgentBriefAfter(snapshot.items, startedAt, "Stay Minty")
      }
      await eventRefreshPromise

      const freshness = summarizeAgentFreshness(snapshot.items, undefined, "Stay Minty")
      if (!freshAgentBrief) {
        const staleMessage = freshness.latestAt
          ? `No new Stay Minty Claude ingest brief arrived for this scan. Showing last-known queue only (last ingest brief ${formatAgentBriefAge(freshness.latestAt)}).`
          : "No new Stay Minty Claude ingest brief arrived for this scan. No current Slack/Gmail queue is available yet."
        setAgentBriefRefresh({
          state: "stale",
          startedAt: startedIso,
          latestAt: freshness.latestAt,
          message: staleMessage,
        })
        setVoiceState((state) => ({
          ...state,
          status: "online",
          message: "No fresh Stay Minty ingest brief yet. Showing last-known queue only.",
          latest: scanResponse ?? state.latest,
          error: null,
          listenerPhase: "idle",
          inputState: "standby",
          digestPhase: "ready",
        }))
      } else {
        setAgentBriefRefresh({
          state: "fresh",
          startedAt: startedIso,
          latestAt: freshness.latestAt,
          message: freshness.detail,
        })
        const needsPeter = summarizePending(snapshot.items).needs_peter
        setVoiceState((state) => ({
          ...state,
          status: "online",
          message:
            typeof needsPeter === "number"
              ? `Fresh agent brief received: ${needsPeter} item${needsPeter === 1 ? "" : "s"} need Peter.`
              : "Fresh agent brief received. MORNING will use the refreshed queue.",
          latest: scanResponse ?? state.latest,
          error: null,
          listenerPhase: "idle",
          inputState: "standby",
          digestPhase: "ready",
        }))
      }
      void scanPromise
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scan failed."
      setVoiceState((state) => ({
        ...state,
        status: "error",
        message: "Scan needs attention.",
        error: message,
        listenerPhase: "idle",
        inputState: "blocked",
        digestPhase: "error",
      }))
    } finally {
      setScanRefreshing(false)
    }
  }, [odinResponsibility, refreshEvents, scanRefreshing, user?.id])
  const notices = useMemo<OdinNotice[]>(() => {
    const items: OdinNotice[] = []

    if (meeting) {
      items.push({
        id: `meeting-${meeting.id ?? meeting.summary ?? "next"}`,
        label: "Schedule",
        title: `${timeLabel(meetingStart)} · ${shortText(meeting.summary ?? "Calendar commitment", 58)}`,
        detail: "Next calendar item",
        tone: "default",
        to: "/calendar",
      })
    } else if (calendarLoading) {
      items.push({
        id: "calendar-loading",
        label: "Calendar",
        title: "Checking connected calendars",
        detail: "ODIN is reading today’s schedule.",
        tone: "default",
        to: "/calendar",
      })
    } else if (calendarNeedsAttention) {
      items.push({
        id: "calendar-read-attention",
        label: "Calendar",
        title: "Calendar read needs attention",
        detail: "Google is connected, but today’s schedule did not finish cleanly.",
        tone: "default",
        to: "/calendar",
      })
    } else if (calendarDisconnected) {
      items.push({
        id: "calendar-disconnected",
        label: "Calendar",
        title: "Google Calendar needs reconnection",
        detail: "ODIN cannot read calendar events until Google access is repaired.",
        tone: "urgent",
        to: "/connections",
      })
    }

    actionSignals.slice(0, 3).forEach((signal) => {
      items.push({
        id: signal.id,
        label:
          signal.source === "slack"
            ? "Slack"
            : signal.source === "gmail"
              ? "Gmail"
              : signal.source,
        title: contextualSignalTitle(signal),
        detail: contextualSignalDetail(signal, 100),
        tone:
          signal.category === "urgent" || signal.category === "waiting"
            ? "urgent"
            : "default",
        to: signal.source === "slack" ? "/council" : undefined,
      })
    })

    if (withings.length > 0) {
      items.push({
        id: "withings-vitals",
        label: "Vitals",
        title: vitalsText,
        detail: withingsNeedsReconnect
          ? "Reconnect needed"
          : withingsHealth.summary
            ? "Withings live"
            : "Withings is still syncing.",
        tone: withingsNeedsReconnect
          ? "urgent"
          : withingsHealth.summary
            ? "quiet"
            : "default",
        to: "/connections",
      })
    }

    if (items.length === 0) {
      items.push({
        id: "quiet",
        label: "ODIN",
        title: "No elevated notices",
        detail: "The Hall is quiet.",
        tone: "quiet",
      })
    }

    return items
  }, [
    actionSignals,
    calendarDisconnected,
    calendarLoading,
    calendarNeedsAttention,
    meeting,
    meetingStart,
    vitalsText,
    withings.length,
    withingsHealth.summary,
    withingsNeedsReconnect,
  ])

  const openOdin = (draft?: string, autoSubmit = false) => {
    setChatDraft(draft)
    if (autoSubmit && draft?.trim()) {
      setChatAutoSubmitKey((key) => key + 1)
    }
    setChatOpen(true)
  }

  const openVoice = (initialCommand?: string) => {
    setChatOpen(false)
    setVoiceControllerMounted(true)
    setVoiceControllerKey((key) => key + 1)
    setVoiceState((state) => ({
      ...state,
      active: true,
      status: "connecting",
      message: "ODIN is waking. Checking the voice channel...",
      error: null,
      micLevel: 0,
      micLive: false,
      voiceDetected: false,
      listenerPhase: "connecting",
      inputState: "wake",
      digestPhase: "idle",
      digestElapsedMs: 0,
    }))
    setVoiceInitialCommand(initialCommand)
    setVoiceAutoStartKey((key) => key + 1)
  }

  const startVoice = (initialCommand?: string) => {
    const now = Date.now()
    if (now - lastVoiceStartRequestAt.current < VOICE_START_GUARD_MS) {
      return
    }
    lastVoiceStartRequestAt.current = now

    if (voiceState.active) {
      setVoiceState((state) => ({
        ...state,
        message:
          state.listenerPhase === "speaking"
            ? "ODIN is responding."
            : "ODIN is listening. Speak naturally.",
      }))
      return
    }
    if (voiceState.listenerPhase === "connecting" || voiceState.status === "thinking") {
      setVoiceState((state) => ({
        ...state,
        message: "ODIN is waking. One moment.",
      }))
      return
    }
    openVoice(initialCommand)
  }

  const stopVoice = () => {
    lastVoiceStartRequestAt.current = 0
    setVoiceState((state) => ({
      ...state,
      active: false,
      status: "idle",
      message: "ODIN is standing by.",
      error: null,
      micLevel: 0,
      micLive: false,
      voiceDetected: false,
      listenerPhase: "idle",
      inputState: "standby",
      digestPhase: "idle",
      digestElapsedMs: 0,
    }))
    setVoiceStopKey((key) => key + 1)
  }

  useEffect(() => {
    const detach = window.odinDesktop?.onVoiceCommand?.((payload) => {
      const command = payload?.command
      if (command === "stop") {
        stopVoice()
        return
      }
      // Start a live listening session when the desktop voice shortcut fires.
      startVoice()
    })
    return () => {
      if (detach) detach()
    }
  }, [startVoice, stopVoice])

  const stopMorningBriefAudio = useCallback(() => {
    const audio = morningBriefAudio.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    morningBriefAudio.current = null
  }, [])

  const playMorningBrief = useCallback(async () => {
    if (morningBriefing) return
    const requestId = morningBriefRequest.current + 1
    morningBriefRequest.current = requestId
    stopMorningBriefAudio()
    if (voiceState.active || voiceState.listenerPhase === "connecting") {
      stopVoice()
    }
    setMorningBriefing(true)
    setVoiceState((state) => ({
      ...state,
      active: false,
      status: "thinking",
      message: "Preparing your morning briefing...",
      error: null,
      micLevel: 0,
      micLive: false,
      voiceDetected: false,
      listenerPhase: "connecting",
      inputState: "thinking",
      digestPhase: "digesting",
      digestElapsedMs: 0,
    }))

    try {
      const response = await invokeOdinCommand({
        query: MORNING_BRIEF_COMMAND,
        source: "text",
        timezone: "Asia/Manila",
        mode: "brief",
        tone: "standard",
        conversationId: `morning-brief-${Date.now()}`,
        turnId: crypto.randomUUID(),
        visiblePage: window.location.pathname,
      })
      if (morningBriefRequest.current !== requestId) return

      const conciseResponse = conciseMorningBrief(response)

      setVoiceState((state) => ({
        ...state,
        active: false,
        status: "thinking",
        message: "ODIN is rendering the briefing voice...",
        latest: conciseResponse,
        error: null,
        listenerPhase: "connecting",
        inputState: "thinking",
        digestPhase: "digesting",
      }))

      const speech = await synthesizeOdinSpeech(conciseResponse.spokenText)
      if (morningBriefRequest.current !== requestId) return

      const audio = new Audio(`data:${speech.mimeType};base64,${speech.audioBase64}`)
      morningBriefAudio.current = audio
      audio.onplay = () => {
        setVoiceState((state) => ({
          ...state,
          active: false,
          status: "speaking",
          message: "Morning briefing is playing.",
          latest: conciseResponse,
          error: null,
          listenerPhase: "speaking",
          inputState: "speaking",
          digestPhase: "ready",
        }))
      }
      audio.onended = () => {
        if (morningBriefRequest.current !== requestId) return
        morningBriefAudio.current = null
        setVoiceState((state) => ({
          ...state,
          active: false,
          status: "idle",
          message: "Morning brief complete.",
          latest: conciseResponse,
          error: null,
          listenerPhase: "idle",
          inputState: "standby",
          digestPhase: "idle",
          digestElapsedMs: 0,
        }))
      }
      await audio.play()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "ODIN could not play the morning brief."
      setVoiceState((state) => ({
        ...state,
        active: false,
        status: "error",
        message: "Morning brief needs attention.",
        error: message,
        micLevel: 0,
        micLive: false,
        voiceDetected: false,
        listenerPhase: "blocked",
        inputState: "blocked",
        digestPhase: "error",
      }))
    } finally {
      if (morningBriefRequest.current === requestId) {
        setMorningBriefing(false)
      }
    }
  }, [
    morningBriefing,
    stopMorningBriefAudio,
    voiceState.active,
    voiceState.listenerPhase,
  ])

  useEffect(() => {
    return () => stopMorningBriefAudio()
  }, [stopMorningBriefAudio])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const action = params.get("action")
    if (!action) {
      processedDashboardAction.current = null
      return
    }
    if (processedDashboardAction.current === action) return
    processedDashboardAction.current = action

    if (action === "scan") {
      if (!portalRequestedFromSearch(location.search)) {
        navigate("/dashboard?portal=open", { replace: true })
      }
      void refreshHomeScan()
    } else if (action === "brief") {
      if (!portalRequestedFromSearch(location.search)) {
        navigate("/dashboard?portal=open", { replace: true })
      }
      void playMorningBrief()
    } else {
      processedDashboardAction.current = null
    }

    params.delete("action")
    const query = params.toString()
    navigate(`${location.pathname}${query ? `?${query}` : ""}`, { replace: true })
  }, [
    location.pathname,
    location.search,
    navigate,
    playMorningBrief,
    refreshHomeScan,
  ])

  useEffect(() => {
    const hash = typeof window !== "undefined" ? window.location.hash : ""
    const hashQueryStart = hash.indexOf("?")
    const hashQuery = hashQueryStart >= 0 ? hash.slice(hashQueryStart + 1) : ""
    const params = new URLSearchParams(location.search || hashQuery)
    const voiceAction = params.get("voice")
    if (!voiceAction) return

    if (voiceAction === "start") {
      startVoice()
    } else if (voiceAction === "stop") {
      stopVoice()
    }

    params.delete("voice")
    const query = params.toString()
    const pathnameOnly = (location.pathname.split("?")[0] || "/dashboard").trim() || "/dashboard"
    navigate(`${pathnameOnly}${query ? `?${query}` : ""}`, { replace: true })
  }, [location.pathname, location.search, navigate])

  const handleVoiceStateChange = useCallback((state: VoiceSurfaceState) => {
    setVoiceState(state)
  }, [])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setCommandPaletteOpen(true)
      }
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [])

  const submitCommand = (event?: FormEvent) => {
    event?.preventDefault()
    const trimmed = command.trim()
    if (!trimmed) return
    setCommand("")
    openOdin(trimmed, true)
  }

  useEffect(() => {
    if (!portalAnimating) return
    const timeout = window.setTimeout(() => {
      setPortalAnimating(false)
      setPortalPull(0)
    }, 1250)
    return () => window.clearTimeout(timeout)
  }, [portalAnimating])

  useEffect(() => {
    const handlePopState = () => {
      if (modeRef.current !== "operations") return
      modeRef.current = "hub"
      setPortalPull(0)
      setPortalAnimating(true)
      setMode("hub")
    }

    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  const openOperations = () => {
    if (!portalRequestedFromSearch(window.location.search)) {
      navigate("/dashboard?portal=open", {
        replace: modeRef.current === "operations",
      })
    }
    if (modeRef.current !== "operations" && !window.history.state?.odinPortal) {
      window.history.replaceState(
        { ...(window.history.state ?? {}), odinPortal: true },
        "",
        window.location.href
      )
    }
    setPortalPull(1)
    setPortalAnimating(true)
    setMode("operations")
  }

  const returnToHub = () => {
    if (portalRequestedFromSearch(window.location.search)) {
      navigate("/dashboard", { replace: true })
    }
    if (window.history.state?.odinPortal) {
      window.history.replaceState(
        { ...(window.history.state ?? {}), odinPortal: false },
        "",
        window.location.href
      )
    }
    setPortalPull(0)
    setPortalAnimating(true)
    setMode("hub")
  }

  const closeOdin = () => {
    if (voiceState.active || voiceState.listenerPhase === "connecting" || voiceState.status === "thinking") {
      stopVoice()
    }
    returnToHub()
  }

  const beginPortalDrag = (
    clientX: number,
    clientY: number,
    source: "page" | "eye"
  ) => {
    dragStartX.current = clientX
    dragStartY.current = clientY
    dragSource.current = source
    suppressNextEyeClick.current = false
  }

  const updatePortalDrag = (clientX: number, clientY: number) => {
    const start = dragStartY.current
    if (start === null) return
    if (mode === "operations") {
      setPortalPull(0)
      return
    }
    const startX = dragStartX.current ?? clientX
    const verticalPull = start - clientY
    const distance = Math.hypot(clientX - startX, verticalPull)
    const isEyeDrag = dragSource.current === "eye"

    if (isEyeDrag && distance > EYE_CLICK_DRAG_THRESHOLD) {
      suppressNextEyeClick.current = true
    }

    if (mode === "hub") {
      const pull = isEyeDrag ? distance / 240 : verticalPull / 260
      setPortalPull(Math.max(0, Math.min(1, pull)))
    } else {
      setPortalPull(Math.max(0, Math.min(1, -verticalPull / 260)))
    }
  }

  const endPortalDrag = (clientX: number, clientY: number) => {
    const start = dragStartY.current
    const startX = dragStartX.current
    const source = dragSource.current
    dragStartX.current = null
    dragStartY.current = null
    dragSource.current = null
    if (start === null) return
    const verticalPull = start - clientY
    const distance = Math.hypot(clientX - (startX ?? clientX), verticalPull)
    const openedFromHub =
      mode === "hub" &&
      (source === "eye"
        ? distance > 64 || portalPull > 0.16
        : verticalPull > 36 || (verticalPull > 12 && distance > 84) || portalPull > 0.16)

    if (source === "eye" && (distance > EYE_CLICK_DRAG_THRESHOLD || openedFromHub)) {
      suppressNextEyeClick.current = true
    }

    if (openedFromHub) {
      openOperations()
    } else {
      setPortalPull(0)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (mode === "operations") return
    if (isInteractiveTarget(event.target)) return
    beginPortalDrag(event.clientX, event.clientY, "page")
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    updatePortalDrag(event.clientX, event.clientY)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    endPortalDrag(event.clientX, event.clientY)
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    dragStartX.current = null
    dragStartY.current = null
    dragSource.current = null
    setPortalPull(0)
    if (event.currentTarget.releasePointerCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleEyePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (mode === "operations") return
    beginPortalDrag(event.clientX, event.clientY, "eye")
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  const handleEyePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    updatePortalDrag(event.clientX, event.clientY)
  }

  const handleEyePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    endPortalDrag(event.clientX, event.clientY)
    if (event.currentTarget.releasePointerCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleEyePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    dragStartX.current = null
    dragStartY.current = null
    dragSource.current = null
    suppressNextEyeClick.current = false
    setPortalPull(0)
    if (event.currentTarget.releasePointerCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleEyePress = () => {
    if (suppressNextEyeClick.current) {
      suppressNextEyeClick.current = false
      return
    }

    startVoice()
  }

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (mode === "hub" && event.deltaY > 18) openOperations()
  }

  const handleKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      if (mode === "hub") startVoice(MORNING_BRIEF_COMMAND)
    }
    if (event.key === "Escape" && mode === "operations") returnToHub()
  }

  const portalProgress = mode === "operations" ? 1 : portalPull
  const portalEdgeProgress = portalAnimating ? 1 : portalPull
  const portalClip =
    mode === "operations" && !portalAnimating
      ? "none"
      : `circle(${portalProgress * 112}% at 50% 49%)`
  const portalEdgeSize = `${portalEdgeProgress * 220}vmax`
  return (
    <div
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      onKeyDown={handleKey}
      className="odin-hall relative h-screen w-screen overflow-hidden bg-[#030608] text-[#f7f2e8] outline-none"
    >
      <div className="odin-stars" />
      <div className="odin-corners" />
      <div
        hidden={mode === "operations" && !portalAnimating}
        className={[
          "pointer-events-none absolute inset-0 z-10 transition-all duration-700 ease-out",
          mode === "operations" && !portalAnimating ? "invisible" : "visible",
          mode === "hub"
            ? "translate-y-0 opacity-100"
            : portalAnimating
              ? "-translate-y-[1%] scale-110 opacity-70 pointer-events-none"
              : "-translate-y-[3%] scale-105 opacity-0 pointer-events-none",
        ].join(" ")}
        aria-hidden={mode === "operations"}
      >
        <HubScreen
          portalPull={portalAnimating ? 1 : portalPull}
          voiceState={voiceState}
          vitalsText={vitalsText}
          command={command}
          onCommandChange={setCommand}
          onCommandSubmit={submitCommand}
          onEyePress={handleEyePress}
          onEyePointerDown={handleEyePointerDown}
          onEyePointerMove={handleEyePointerMove}
          onEyePointerUp={handleEyePointerUp}
          onEyePointerCancel={handleEyePointerCancel}
          onVoiceStart={() => startVoice()}
          notices={notices}
          onNavigate={(path) => navigate(path)}
          onOpenOperations={openOperations}
          scanRefreshing={scanRefreshing}
          agentFreshness={odinResponsibility.agentFreshness}
          agentBriefStatus={agentBriefRefresh}
          onRefreshScan={refreshHomeScan}
          onMorningBrief={playMorningBrief}
          morningBriefing={morningBriefing}
          signals={displayedSignals}
          signalsLoading={odinSignalsLoading}
          events={events}
          eventsLoading={eventsLoading}
          onSignalStatusChange={handleSignalStatusChange}
        />
      </div>

      <div
        hidden={mode === "hub" && portalPull <= 0.02 && !portalAnimating}
        className={[
          "odin-portal-layer absolute inset-0 z-30",
          mode === "operations" ? "is-open" : "",
          portalAnimating ? "is-animating" : "",
          portalPull > 0 && !portalAnimating ? "is-pulling" : "",
          mode === "hub" && portalPull <= 0.02 && !portalAnimating
            ? "pointer-events-none"
            : "pointer-events-auto",
        ].join(" ")}
        aria-hidden={mode === "hub" && portalPull <= 0.02 && !portalAnimating}
        style={{
          clipPath: portalClip,
          WebkitClipPath: portalClip,
        }}
      >
        <OperationsDashboardScreen
          withingsHealth={withingsHealth}
          voiceState={voiceState}
          events={events}
          signals={displayedSignals}
          sourceHealth={allSourceHealth}
          signalsLoading={odinSignalsLoading}
          view={operationsView}
          onViewChange={setOperationsView}
          onAwaken={() => {
            startVoice()
          }}
          onTextCommand={openOdin}
          onOpenSearch={() => setCommandPaletteOpen(true)}
          onOpenMusic={() => navigate("/music")}
          onLock={closeOdin}
          onHallClick={() => navigate("/dashboard?portal=open", { replace: true })}
          pendingSummary={latestScanResponse?.pendingSummary ?? odinResponsibility.pendingSummary}
          scanRefreshing={scanRefreshing}
          onRefreshScan={refreshHomeScan}
          agentBriefStatus={agentBriefRefresh}
          agentFreshness={odinResponsibility.agentFreshness}
          onSignalStatusChange={handleSignalStatusChange}
          timeZoneCards={timeZoneCards}
          onTimeZoneChange={updateTimeZoneCard}
        />
        <div
          className="odin-portal-edge"
          aria-hidden="true"
          style={
            portalEdgeProgress > 0
              ? {
                  width: portalEdgeSize,
                  height: portalEdgeSize,
                  opacity: 0.82,
                }
              : undefined
          }
        >
          <div />
        </div>
      </div>

      <Dialog open={chatOpen} onOpenChange={setChatOpen}>
        <DialogContent
          className="w-[min(1080px,calc(100vw-48px))] max-w-none gap-0 border-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-none"
          showCloseButton={true}
        >
          <DialogTitle className="sr-only">ODIN Chat</DialogTitle>
          <DialogDescription className="sr-only">
            Text command panel for ODIN.
          </DialogDescription>
          <React.Suspense fallback={<div className="rounded-3xl bg-[#fffaf1] p-6 text-sm font-semibold text-[#6d5334]">Loading command panel...</div>}>
            <ChatPanel initialDraft={chatDraft} autoSubmitKey={chatAutoSubmitKey} />
          </React.Suspense>
        </DialogContent>
      </Dialog>

      {voiceControllerMounted && (
        <React.Suspense fallback={null}>
          <OdinVoiceConsole
            key={voiceControllerKey}
            variant="controller"
            autoStartKey={voiceAutoStartKey}
            stopKey={voiceStopKey}
            initialCommand={voiceInitialCommand}
            onStateChange={handleVoiceStateChange}
          />
        </React.Suspense>
      )}

      <React.Suspense fallback={null}>
        <OdinCommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          signals={displayedSignals}
          sourceHealth={allSourceHealth}
          onViewChange={(nextView) => {
            setOperationsView(nextView)
            if (mode !== "operations") openOperations()
          }}
          onOpenTextCommand={openOdin}
          onAwaken={() => {
            startVoice()
          }}
          onStatusChange={handleSignalStatusChange}
        />
      </React.Suspense>
    </div>
  )
}

function HubScreen({
  portalPull,
  voiceState,
  vitalsText,
  command,
  onCommandChange,
  onCommandSubmit,
  onEyePress,
  onEyePointerDown,
  onEyePointerMove,
  onEyePointerUp,
  onEyePointerCancel,
  onVoiceStart,
  notices,
  onNavigate,
  onOpenOperations,
  scanRefreshing,
  agentFreshness,
  agentBriefStatus,
  onRefreshScan,
  onMorningBrief,
  morningBriefing,
  signals,
  signalsLoading,
  events,
  eventsLoading,
  onSignalStatusChange,
}: {
  portalPull: number
  voiceState: VoiceSurfaceState
  vitalsText: string
  command: string
  onCommandChange: (value: string) => void
  onCommandSubmit: (event?: FormEvent) => void
  onEyePress: () => void
  onEyePointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void
  onEyePointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void
  onEyePointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void
  onEyePointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => void
  onVoiceStart: () => void
  notices: OdinNotice[]
  onNavigate: (path: string) => void
  onOpenOperations: () => void
  scanRefreshing: boolean
  agentFreshness: OdinAgentFreshness
  agentBriefStatus: AgentBriefRefreshState
  onRefreshScan: () => void
  onMorningBrief: () => void
  morningBriefing: boolean
  signals: OperationsSignal[]
  signalsLoading: boolean
  events: CalendarEvent[]
  eventsLoading: boolean
  onSignalStatusChange: (id: string, status: OperationsSignalStatus) => void
}) {
  const [filter] = useState<"all" | "priority" | "today" | "waiting" | "done">("all")
  const [priorityPeekOpen, setPriorityPeekOpen] = useState(false)
  const staleExternalSignals =
    agentBriefStatus.state === "stale" || agentFreshness.stale
  const hallSignals = staleExternalSignals
    ? signals.filter((signal) => !isStaleBriefSource(signal.source))
    : signals
  const openSignals = hallSignals.filter(
    (signal) => signal.status === "open" || signal.status === "waiting"
  )
  const prioritySignals = sortSignalsForPeter(
    openSignals.filter(
      (signal) =>
        signal.category === "urgent" ||
        signal.category === "follow_up" ||
        signal.status === "waiting"
    )
  )
  const todaySignals = openSignals.filter((signal) => signal.category === "today")
  const waitingSignals = hallSignals.filter(
    (signal) => signal.status === "waiting" || signal.category === "waiting"
  )
  const doneSignals = hallSignals.filter((signal) => signal.status === "handled")
  const filteredSignals =
    filter === "priority"
      ? prioritySignals
      : filter === "today"
        ? todaySignals
        : filter === "waiting"
          ? waitingSignals
          : filter === "done"
            ? doneSignals
            : hallSignals
  const displaySignals = filteredSignals.slice(0, 3)
  const nextEvents = upcomingEvents(events, 5)
  const agentBriefLine =
    agentBriefStatus.state === "requesting"
      ? agentBriefStatus.message
      : agentBriefStatus.state === "fresh"
        ? agentBriefStatus.message
        : agentBriefStatus.state === "stale"
          ? agentBriefStatus.message
          : staleExternalSignals
            ? agentFreshness.latestAt
              ? `Source brief stale (${formatAgentBriefAge(agentFreshness.latestAt)}). Run Live Scan.`
              : "No source brief available yet. Run Live Scan."
            : agentFreshness.detail
  const leadSignal = displaySignals.find(
    (signal) => signal.status === "open" || signal.status === "waiting"
  )
  const activeNotices = notices.filter((notice) => notice.id !== "quiet")
  const urgentNotices = activeNotices.filter((notice) => notice.tone === "urgent")
  const leadNotice = urgentNotices[0] ?? activeNotices[0]
  const waitCount = Math.max(prioritySignals.length + todaySignals.length, displaySignals.length)
  const hallHeadline =
    waitCount > 0
      ? `${waitCount} ${waitCount === 1 ? "thing waits" : "things wait"} on you today.`
      : "All quiet for now."
  const hallSubline =
    leadSignal?.summary ??
    leadSignal?.nextAction ??
    "No live item is asking for Peter's call. Suspicious, but useful."
  const heartMatch = vitalsText.match(/\b(\d{2,3})\s*bpm\b/i)
  const heartLabel = heartMatch?.[1] ?? "—"
  const sleepPart = vitalsText.includes("·")
    ? vitalsText.split("·")[1]?.trim()
    : null
  const sleepLabel =
    sleepPart && !/pending|quiet|unavailable/i.test(sleepPart) ? sleepPart : "—"
  const sphereSignals = [
    leadSignal,
    displaySignals.find((signal) => signal.id !== leadSignal?.id),
  ].filter(Boolean) as OperationsSignal[]
  const ambientOrbState = orbStateFromVoice(voiceState, {
    loading: signalsLoading,
    urgent: prioritySignals.length > 0 || urgentNotices.length > 0,
    executing: scanRefreshing || morningBriefing,
  })
  const voiceSignal = odinSignalFromVoice(voiceState, {
    scanRefreshing,
    morningBriefing,
  })
  const sphereStatus = morningBriefing
    ? "Briefing..."
    : scanRefreshing
    ? "Scanning..."
    : voiceState.voiceDetected
    ? "Listening..."
    : voiceState.status === "speaking"
      ? "Speaking..."
      : voiceState.status === "thinking" || voiceState.status === "connecting"
        ? "Waking..."
        : "Listening..."
  const spherePrompt = morningBriefing
    ? "Reading the current brief."
    : scanRefreshing
    ? "Checking fresh source briefs."
    : voiceState.voiceDetected
    ? "I can hear you. Continue naturally."
    : "Ask anything. Give a command."
  const leadAlertTitle = leadNotice?.title ?? (leadSignal ? contextualSignalTitle(leadSignal) : hallHeadline)
  const leadAlertDetail =
    leadNotice?.detail ??
    (leadSignal ? contextualSignalDetail(leadSignal, 90) : shortText(hallSubline, 90))
  const secondaryAlert = activeNotices.find((notice) => notice.id !== leadNotice?.id)
  const secondarySignal = displaySignals.find((signal) => signal.id !== leadSignal?.id)
  const priorityPeekSignals =
    (prioritySignals.length > 0 ? prioritySignals : sortSignalsForPeter(openSignals)).slice(0, 3)

  return (
    <LightPageShell showSidebar={false}>
      <div className="relative min-h-[calc(100vh-120px)] overflow-hidden rounded-[28px] px-0 py-1">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-[28%] top-[11%] h-1.5 w-1.5 rounded-full bg-[#b18455]/35" />
          <div className="absolute left-[34%] top-[29%] h-2 w-2 rounded-full bg-[#b18455]/65" />
          <div className="absolute right-[27%] top-[25%] h-2 w-2 rounded-full bg-[#b18455]/65" />
          <div className="absolute bottom-[14%] right-[18%] h-1.5 w-1.5 rounded-full bg-[#b18455]/45" />
          <div className="fixed left-1/2 top-[48vh] h-[34rem] w-[34rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[#d9b98c]/45" />
          <div className="fixed left-1/2 top-[48vh] h-[24rem] w-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[#d9b98c]/35" />
          <div className="fixed left-[20%] right-[20%] top-[48vh] h-px bg-[#d8b98c]/35" />
          <svg
            viewBox="0 0 1100 120"
            className="fixed left-[15%] right-[15%] top-[43vh] hidden h-28 w-[70%] text-[#d6b98b]/50 xl:block"
            fill="none"
          >
            <path
              d="M0 63 C70 54 92 73 142 62 S236 48 312 62 422 72 503 60 597 45 682 62 784 74 850 56 946 50 1002 63 1044 74 1100 60"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <header className="relative z-10 flex items-start justify-between gap-8">
          <div className="flex items-center gap-5">
            <span className="font-display text-2xl tracking-[0.42em] text-[#2b1d0f]">
              ODIN
            </span>
            <span className="h-1 w-1 rounded-full bg-[#d6b98b]" />
            <span className="inline-flex items-center gap-2 font-mono-data text-sm font-bold uppercase tracking-[0.14em] text-[#b6531c]">
              <span className="h-2.5 w-2.5 rounded-full bg-[#b6531c]" />
              Active
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenOperations}
              className="inline-flex items-center gap-2 rounded-full border border-[#ead9bd] bg-[#fffaf1]/85 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#6d5334] transition hover:border-[#b6531c]/50 hover:bg-[#f2dfc2]"
            >
              <Command size={13} />
              Open controls
            </button>
            <ManilaMeta />
          </div>
        </header>

        <div className="relative z-10 min-h-[640px]">
          <section className="absolute left-8 top-1/2 z-20 hidden w-full max-w-[330px] -translate-y-1/2 xl:block">
            <h1 className="sr-only text-5xl font-extrabold tracking-[-0.05em] text-[#2b1d0f] md:text-6xl">
              The Pulse
            </h1>
            <p className="sr-only mt-6 text-2xl font-medium leading-snug text-[#6d5334]">
              Feel the pulse.
              <br />
              Stay in control.
            </p>

            <div className="mt-12 space-y-5">
              <button
                type="button"
                onClick={() => onNavigate("/calendar")}
                className="w-full rounded-3xl bg-[#fffaf1]/84 p-5 text-left shadow-[0_24px_60px_-48px_rgba(72,45,14,0.7)] ring-1 ring-[#ead9bd]/80 backdrop-blur transition hover:-translate-y-0.5 hover:ring-[#b6531c]/45"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-3 font-mono-data text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                    <CalendarDays size={17} />
                    Today · Schedule
                  </span>
                  <span className="text-[#b6531c]">›</span>
                </div>
                <h2 className="mt-5 text-base font-extrabold leading-snug text-[#2b1d0f]">
                  {nextEvents[0]
                    ? `${timeLabel(nextEvents[0].start)} · ${shortText(nextEvents[0].event.summary ?? "Calendar event", 38)}`
                    : eventsLoading
                      ? "Checking calendar…"
                      : "No fixed event found"}
                </h2>
                <p className="mt-4 text-sm font-medium leading-relaxed text-[#6d5334]">
                  {nextEvents[0]
                    ? shortText(nextEvents[0].event.location ?? nextEvents[0].event.description ?? "Open calendar for the day plan.", 92)
                    : "Pull calendar when you unlock the portal."}
                </p>
              </button>

              <div
                className="relative"
                onMouseEnter={() => setPriorityPeekOpen(true)}
                onMouseLeave={() => setPriorityPeekOpen(false)}
              >
                <button
                  type="button"
                  onClick={() => setPriorityPeekOpen(true)}
                  onFocus={() => setPriorityPeekOpen(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setPriorityPeekOpen(false)
                  }}
                  aria-expanded={priorityPeekOpen}
                  aria-controls="odin-priority-peek"
                  className="w-full rounded-3xl bg-[#fffaf1]/84 p-5 text-left shadow-[0_24px_60px_-48px_rgba(72,45,14,0.7)] ring-1 ring-[#ead9bd]/80 backdrop-blur transition hover:-translate-y-0.5 hover:ring-[#b6531c]/45"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-3 font-mono-data text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                      <Zap size={17} />
                      {leadNotice ? leadNotice.label : "Ravens"} · Signals
                    </span>
                    <span
                      className={[
                        "h-2.5 w-2.5 rounded-full",
                        urgentNotices.length > 0 || prioritySignals.length > 0
                          ? "bg-[#b6531c]"
                          : "bg-[#d6b98b]",
                      ].join(" ")}
                    />
                  </div>
                  <h2 className="mt-5 text-base font-extrabold leading-snug text-[#2b1d0f]">
                    {leadAlertTitle}
                  </h2>
                  <p className="mt-4 text-sm font-medium leading-relaxed text-[#6d5334]">
                    {leadAlertDetail}
                  </p>
                  <p
                    className={[
                      "mt-4 text-[11px] font-bold uppercase tracking-[0.14em]",
                      agentBriefStatus.state === "stale"
                        ? "text-[#b6531c]"
                        : agentFreshness.stale
                          ? "text-[#9b6c42]"
                          : "text-[#5f7d3b]",
                    ].join(" ")}
                  >
                    {agentBriefLine}
                  </p>
                  <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[#b6531c]">
                    Hover or click for priority list
                  </p>
                </button>

                {priorityPeekOpen && (
                  <PriorityPeekPanel
                    signals={priorityPeekSignals}
                    agentLine={agentBriefLine}
                    onOpenOperations={() => onNavigate("/council")}
                    onSignalStatusChange={onSignalStatusChange}
                  />
                )}
              </div>
            </div>
          </section>

          <section className="pointer-events-none absolute inset-0 text-center">
            <button
              type="button"
              onClick={onEyePress}
              onPointerDown={onEyePointerDown}
              onPointerMove={onEyePointerMove}
              onPointerUp={onEyePointerUp}
              onPointerCancel={onEyePointerCancel}
              className="group pointer-events-auto fixed left-1/2 top-[48vh] z-10 flex h-[220px] w-[220px] items-center justify-center rounded-full outline-none transition hover:scale-[1.025] focus-visible:ring-2 focus-visible:ring-[#b6531c] md:h-[260px] md:w-[260px]"
              style={{
                transform: `translate(-50%, -50%) scale(${1 + portalPull * 0.16})`,
                boxShadow:
                  "0 32px 110px -44px rgba(181,83,28,0.55)",
              }}
              aria-label="Press ODIN to talk, drag to open dashboard"
            >
              <PulseSphere
                active={
                  voiceSignal.active ||
                  voiceState.active ||
                  voiceState.voiceDetected ||
                  scanRefreshing
                }
                state={ambientOrbState}
                level={voiceState.micLevel}
                signalState={voiceSignal.state}
                signals={sphereSignals}
              />
            </button>

            <div className="fixed left-1/2 top-[63vh] z-10 -translate-x-1/2">
              <p className="text-base font-extrabold uppercase tracking-[0.58em] text-[#2b1d0f]">
              {sphereStatus}
            </p>
              <p className="mt-3 text-lg font-medium text-[#9b815e]">{spherePrompt}</p>
            </div>

            <form
              onSubmit={onCommandSubmit}
              data-odin-signal={voiceSignal.state}
              className="odin-command-bar pointer-events-auto fixed left-1/2 top-[84vh] z-40 flex w-[min(620px,calc(100vw-80px))] -translate-x-1/2 items-center gap-4 rounded-full border border-[#dfcfb1] bg-[#fffaf1]/90 p-3 text-left shadow-[0_18px_40px_-32px_rgba(72,45,14,0.6)] backdrop-blur"
            >
              <div
                className="odin-command-signal pointer-events-none absolute bottom-[calc(100%+10px)] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[#dfcfb1]/80 bg-[#fffaf1]/84 px-3 py-1.5 shadow-[0_14px_32px_-28px_rgba(72,45,14,0.55)] backdrop-blur"
                data-state={voiceSignal.state}
                aria-hidden={voiceSignal.state === "idle" ? "true" : "false"}
              >
                <span className="odin-command-signal__dot" />
                <span className="odin-command-signal__bars" aria-hidden="true">
                  {Array.from({ length: 8 }, (_, index) => (
                    <span
                      key={index}
                      style={{ animationDelay: `${index * -70}ms` }}
                    />
                  ))}
                </span>
                <span className="font-mono-data text-[10px] font-bold uppercase tracking-[0.18em] text-[#6d5334]">
                  {voiceSignal.label}
                </span>
                {voiceSignal.detail && (
                  <span className="font-mono-data text-[10px] font-bold uppercase tracking-[0.14em] text-[#b6531c]">
                    {voiceSignal.detail}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={onVoiceStart}
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#b6531c] text-white shadow-[0_14px_26px_-18px_rgba(181,83,28,0.65)] transition hover:bg-[#9d4517]"
                aria-label="Start ODIN voice"
              >
                <Mic2 size={22} />
              </button>
              <input
                value={command}
                onChange={(event) => onCommandChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  onCommandSubmit()
                }}
                placeholder="Press to talk to Odin..."
                className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-[#2b1d0f] outline-none placeholder:text-[#6d5334]"
              />
              <button
                type="button"
                onClick={onMorningBrief}
                disabled={morningBriefing}
                title="Play concise morning brief"
                className="hidden shrink-0 items-center gap-2 rounded-full border border-[#dfcfb1] px-3 py-2 font-mono-data text-[10px] font-bold uppercase tracking-[0.16em] text-[#9b6c42] transition hover:border-[#b6531c]/45 hover:bg-[#f2dfc2] disabled:cursor-wait disabled:opacity-60 md:inline-flex"
                aria-label="Play morning briefing without using the microphone"
              >
                <Volume2 size={13} className={morningBriefing ? "animate-pulse" : ""} />
                {morningBriefing ? "Briefing" : "Brief"}
              </button>
              <button
                type="button"
                onClick={onRefreshScan}
                disabled={scanRefreshing}
                title="Live scan connected sources"
                className="hidden shrink-0 items-center gap-2 rounded-full border border-[#dfcfb1] px-3 py-2 font-mono-data text-[10px] font-bold uppercase tracking-[0.16em] text-[#9b6c42] transition hover:border-[#b6531c]/45 hover:bg-[#f2dfc2] disabled:cursor-wait disabled:opacity-60 sm:inline-flex"
                aria-label="Live Scan connected sources"
              >
                <RefreshCw size={13} className={scanRefreshing ? "animate-spin" : ""} />
                {scanRefreshing ? "Scanning" : "Live scan"}
              </button>
              <button
                type="button"
                onClick={() => onCommandSubmit()}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#b6531c] transition hover:bg-[#f2dfc2]"
                aria-label="Send command"
              >
                <Activity size={20} />
              </button>
            </form>
          </section>

          <aside className="absolute right-8 top-1/2 z-20 hidden w-full max-w-[330px] -translate-y-1/2 space-y-5 xl:block">
            <button
              type="button"
              onClick={onOpenOperations}
              className="w-full rounded-3xl bg-[#fffaf1]/84 p-5 text-left shadow-[0_24px_60px_-48px_rgba(72,45,14,0.7)] ring-1 ring-[#ead9bd]/80 backdrop-blur transition hover:-translate-y-0.5 hover:ring-[#b6531c]/45"
            >
              <p className="font-mono-data text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                Vitals
              </p>
              <div className="mt-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-2xl font-extrabold text-[#2b1d0f]">
                    {heartLabel !== "—" ? `${heartLabel} bpm` : "Health quiet"}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#6d5334]">
                    {sleepLabel !== "—" ? sleepLabel : "Sleep pending"}
                  </p>
                  <p className="text-sm font-semibold text-[#6d5334]">
                    Withings source
                  </p>
                </div>
                <HeartbeatLine className="h-9 w-24" />
              </div>
            </button>

            <React.Suspense fallback={<MusicBoxFallback />}>
              <MusicBoxWidget onOpen={() => onNavigate("/music")} />
            </React.Suspense>

            <button
              type="button"
              onClick={onOpenOperations}
              className="w-full rounded-3xl bg-[#fffaf1]/84 p-5 text-left shadow-[0_24px_60px_-48px_rgba(72,45,14,0.7)] ring-1 ring-[#ead9bd]/80 backdrop-blur transition hover:-translate-y-0.5 hover:ring-[#b6531c]/45"
            >
              <p className="font-mono-data text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                Counsel
              </p>
              <div className="mt-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-base font-extrabold leading-snug text-[#2b1d0f]">
                    {secondaryAlert?.title ??
                      (secondarySignal ? contextualSignalTitle(secondarySignal) : hallHeadline)}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#6d5334]">
                    {agentBriefStatus.state === "stale"
                      ? shortText(agentBriefStatus.message, 92)
                      : secondaryAlert?.detail ??
                        (secondarySignal
                          ? contextualSignalDetail(secondarySignal, 76)
                          : shortText(hallSubline, 76))}
                  </p>
                </div>
                <span className="text-[#b6531c]">›</span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onOpenOperations()}
              className="hidden w-full rounded-3xl bg-[#fffaf1]/84 p-5 text-left shadow-[0_24px_60px_-48px_rgba(72,45,14,0.7)] ring-1 ring-[#ead9bd]/80 backdrop-blur transition hover:-translate-y-0.5 hover:ring-[#b6531c]/45"
            >
              <p className="font-mono-data text-xs font-bold uppercase tracking-[0.16em] text-[#6d5334]">
                Pulse
              </p>
              <div className="mt-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-base font-extrabold text-[#2b1d0f]">
                    {voiceState.status === "error" ? "Voice needs attention" : "System calm"}
                  </p>
                  <p className="text-sm font-semibold text-[#6d5334]">
                    {voiceState.status === "error" ? "Text still works" : "Everything on track"}
                  </p>
                </div>
                <HeartbeatLine className="h-9 w-24" />
              </div>
            </button>
          </aside>
          </div>
      </div>
    </LightPageShell>
  )

}

function PriorityPeekPanel({
  signals,
  agentLine,
  onOpenOperations,
  onSignalStatusChange,
}: {
  signals: OperationsSignal[]
  agentLine: string
  onOpenOperations: () => void
  onSignalStatusChange: (id: string, status: OperationsSignalStatus) => void
}) {
  const previewSignals = signals.slice(0, 4)

  return (
    <div
      id="odin-priority-peek"
      className="absolute left-0 top-[calc(100%+14px)] z-50 max-h-[min(54vh,520px)] w-[min(440px,calc(100vw-96px))] overflow-y-auto rounded-3xl border border-[#dfcfb1] bg-[#fffaf1]/95 p-4 text-left shadow-[0_28px_80px_-42px_rgba(72,45,14,0.75)] backdrop-blur-xl xl:left-[calc(100%+16px)] xl:top-0 xl:max-h-[min(62vh,560px)]"
    >
      <div className="flex items-start justify-between gap-4 border-b border-[#ead9bd] pb-3">
        <div>
          <p className="font-mono-data text-[10px] font-bold uppercase tracking-[0.18em] text-[#b6531c]">
            Priority list
          </p>
          <p className="mt-1 text-xs font-semibold text-[#8f714d]">
            {agentLine}
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenOperations}
          className="shrink-0 rounded-full border border-[#dfcfb1] px-3 py-1.5 text-[11px] font-bold text-[#2b1d0f] transition hover:border-[#b6531c]/50 hover:bg-[#f2dfc2]"
        >
          Open queue
        </button>
      </div>

      {previewSignals.length > 0 ? (
        <div className="mt-3 space-y-2">
          {previewSignals.map((signal) => (
            <article
              key={signal.id}
              className="rounded-2xl border border-[#ead9bd] bg-white/45 p-3"
            >
              <div className="flex items-start gap-3">
                <SourceGlyph source={signal.source} className="h-8 w-8 shrink-0" />
                <button
                  type="button"
                  onClick={onOpenOperations}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block text-sm font-extrabold leading-snug text-[#2b1d0f]">
                    {contextualSignalTitle(signal)}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-xs font-semibold leading-relaxed text-[#6d5334]">
                    {contextualSignalDetail(signal, 150)}
                  </span>
                  <span className="mt-2 block truncate font-mono-data text-[10px] font-bold uppercase tracking-[0.12em] text-[#9b815e]">
                    {signal.business ?? signal.source}
                    {signal.person ? ` · ${signal.person}` : ""}
                  </span>
                </button>
                <span className="shrink-0 rounded-full bg-[#f2dfc2] px-2 py-1 font-mono-data text-[10px] font-bold uppercase tracking-[0.12em] text-[#b6531c]">
                  {statusCopy(signal)}
                </span>
              </div>
              {signal.status !== "handled" && (
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void onSignalStatusChange(signal.id, "handled")}
                    className="rounded-full border border-[#dfcfb1] px-3 py-1 text-[11px] font-bold text-[#2b1d0f] transition hover:border-[#b6531c]/50 hover:bg-[#f2dfc2]"
                  >
                    Mark handled
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-[#ead9bd] bg-white/45 p-4">
          <p className="text-sm font-extrabold text-[#2b1d0f]">No priority items in the current queue.</p>
          <p className="mt-1 text-xs font-semibold leading-relaxed text-[#6d5334]">
            Run Live Scan, or post a fresh source brief. ODIN will not pretend last-known rows are new.
          </p>
        </div>
      )}
    </div>
  )
}

function SourceGlyph({
  source,
  className = "",
}: {
  source: OperationsSignalSource | OperationsSourceHealth["id"] | string
  className?: string
}) {
  const [iconFailed, setIconFailed] = useState(false)
  const normalized = source.toLowerCase()
  const iconPath = SOURCE_ICON_PATHS[normalized] ?? SOURCE_ICON_PATHS.system
  const label = normalized === "gmail" ? "Gmail" : normalized === "slack" ? "Slack" : normalized

  if (iconPath && !iconFailed) {
    return (
      <span
        className={[
          "inline-grid h-7 w-7 place-items-center overflow-hidden rounded-xl bg-[#fffaf0] shadow-[0_10px_22px_-16px_rgba(43,29,15,0.7)] ring-1 ring-[#ead9bd]/70",
          className,
        ].join(" ")}
        aria-label={label}
      >
        <img
          src={iconPath}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setIconFailed(true)}
        />
      </span>
    )
  }

  const icon =
    normalized === "gmail" ? (
      <Mail size={15} />
    ) : normalized === "calendar" ? (
      <CalendarDays size={15} />
    ) : normalized === "health" ? (
      <Activity size={15} />
    ) : normalized === "weather" ? (
      <Activity size={15} />
    ) : (
      <MessageSquare size={15} />
    )

  return (
    <span
      className={[
        "inline-grid h-6 w-6 place-items-center rounded-lg bg-[#f2dfc2] text-[#b6531c] shadow-[0_8px_18px_-14px_rgba(43,29,15,0.65)]",
        className,
      ].join(" ")}
      aria-label={normalized}
    >
      {icon}
    </span>
  )
}

function HeartbeatLine({ className = "" }: { className?: string }) {
  const points =
    "0,42 34,42 45,22 58,57 70,38 116,42 142,42 154,17 169,60 183,39 230,42 255,42 268,20 284,57 298,40 360,42"

  return (
    <svg
      viewBox="0 0 360 74"
      className={["odin-heartbeat-line text-[#b6531c]", className].join(" ")}
      fill="none"
      aria-hidden="true"
    >
      <polyline
        className="odin-heartbeat-line__base"
        points={points}
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        className="odin-heartbeat-line__live"
        points={points}
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PulseSphere({
  active,
  state = "idle",
  level = 0,
  signalState = "idle",
  signals = [],
}: {
  active: boolean
  state?: OdinOrbState
  level?: number
  signalState?: OdinSignalState
  signals?: OperationsSignal[]
}) {
  const scale =
    state === "speaking"
      ? 1.04
      : state === "listening"
        ? 1.035
        : state === "thinking"
          ? 1.025
          : 1
  const micBoost = Math.min(level, 1) * 0.035
  const hasUrgentSignals = signals.some((signal) => signal.category === "urgent")
  const visualState = hasUrgentSignals && state === "idle" ? "urgent" : state
  const normalizedLevel = Math.max(0.08, Math.min(1, level || (active ? 0.42 : 0.12)))

  return (
    <span
      className="odin-pulse-sphere pointer-events-none relative block h-full w-full rounded-full"
      data-orb-state={visualState}
      data-voice-state={signalState}
      data-active={active}
      style={
        {
          "--voice-level": normalizedLevel,
          transform: `scale(${scale + micBoost})`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      <span className="absolute -inset-[88%] rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.72)_0%,rgba(248,218,164,0.26)_23%,rgba(181,83,28,0.16)_42%,transparent_69%)]" />
      <span className="odin-pulse-sphere__orbit odin-pulse-sphere__orbit--outer absolute -inset-[82%] rounded-full border border-dashed border-[#d8b98c]/50" />
      <span className="odin-pulse-sphere__orbit odin-pulse-sphere__orbit--inner absolute -inset-[52%] rounded-full border border-dashed border-[#d8b98c]/38" />
      <span className="absolute -inset-[28%] rounded-full border border-[#d8b98c]/24" />
      <span className="odin-pulse-sphere__reception-ring absolute -inset-[62%] rounded-full border border-[#b6531c]/0" />
      <span className="odin-pulse-sphere__processing-ring absolute -inset-[44%] rounded-full border border-[#d8b98c]/0" />
      <span
        className={[
          "absolute -inset-12 rounded-full bg-[#d99a45]/15 blur-3xl",
          active ? "animate-pulse" : "",
        ].join(" ")}
      />

      <span
        className="odin-pulse-sphere__core relative block h-full w-full overflow-hidden rounded-full border border-[#fff6dc]/80 shadow-[inset_0_0_34px_rgba(255,241,200,0.74),inset_0_-20px_48px_rgba(130,59,12,0.52),0_0_28px_rgba(255,236,180,0.9),0_0_90px_rgba(205,125,35,0.36),0_32px_70px_rgba(92,52,17,0.18)]"
        style={{
          background:
            "radial-gradient(circle at 32% 24%, rgba(255,255,255,.82) 0%, rgba(255,255,255,.18) 8%, transparent 17%), radial-gradient(circle at 68% 70%, rgba(252,202,112,.58) 0%, rgba(197,111,27,.34) 28%, transparent 48%), radial-gradient(circle at 50% 50%, #1e1712 0%, #3c2a19 43%, #c57a2a 75%, #fff4c7 100%)",
        }}
      >
        <span className="odin-pulse-sphere__input-glow absolute inset-[8%] rounded-full" />
        <span className="absolute left-[16%] top-[13%] h-[28%] w-[36%] rounded-full bg-white/20 blur-[8px]" />
        <span className="absolute bottom-[18%] right-[13%] h-[32%] w-[52%] rounded-full bg-[#f0ac4f]/20 blur-[10px]" />
        <span className="odin-pulse-sphere__voice-line absolute left-[12%] right-[12%] top-1/2 z-20 flex -translate-y-1/2 items-center justify-center gap-1 opacity-70">
          {Array.from({ length: 22 }, (_, index) => (
            <span
              key={index}
              style={{
                height: `${6 + Math.abs(11 - index) * 1.4 + normalizedLevel * 18}px`,
                animationDelay: `${index * -48}ms`,
              }}
            />
          ))}
        </span>
        <span className="absolute inset-[-2px] rounded-full border-2 border-[#fff6dc]/80 shadow-[inset_0_0_22px_rgba(255,255,255,0.54)]" />
      </span>
    </span>
  )
}

function OperationsDashboardScreen({
  withingsHealth,
  voiceState,
  events,
  signals,
  sourceHealth,
  signalsLoading,
  view,
  onViewChange,
  onAwaken,
  onTextCommand,
  onOpenSearch,
  onOpenMusic,
  onLock,
  onHallClick,
  pendingSummary,
  scanRefreshing,
  onRefreshScan,
  agentBriefStatus,
  agentFreshness,
  onSignalStatusChange,
  timeZoneCards,
  onTimeZoneChange,
}: {
  withingsHealth: ReturnType<typeof useWithingsHealth>
  voiceState: VoiceSurfaceState
  events: CalendarEvent[]
  signals: OperationsSignal[]
  sourceHealth: OperationsSourceHealth[]
  signalsLoading: boolean
  view: UnifiedHubView
  onViewChange: (view: UnifiedHubView) => void
  onAwaken: () => void
  onTextCommand: (draft?: string) => void
  onOpenSearch: () => void
  onOpenMusic: () => void
  onLock: () => void
  onHallClick: () => void
  pendingSummary: ReturnType<typeof useOdinResponsibility>["pendingSummary"]
  scanRefreshing: boolean
  onRefreshScan: () => void
  agentBriefStatus: AgentBriefRefreshState
  agentFreshness: OdinAgentFreshness
  onSignalStatusChange: (id: string, status: OperationsSignalStatus) => void
  timeZoneCards: OdinTimeZoneCard[]
  onTimeZoneChange: (index: number, timeZone: string) => void
}) {
  const staleExternalSignals =
    agentBriefStatus.state === "stale" || agentFreshness.stale
  const panelSignals = staleExternalSignals
    ? signals.filter((signal) => !isStaleBriefSource(signal.source))
    : signals
  const openSignals = panelSignals.filter(
    (signal) => signal.status === "open" || signal.status === "waiting"
  )
  const sortedSignals = sortSignalsForPeter(openSignals)
  const prioritySignals = sortedSignals.filter(
    (signal) =>
      signal.category === "urgent" ||
      signal.category === "follow_up" ||
      signal.status === "waiting"
  )
  const nextEvents = upcomingEvents(events, 3)
  const health = withingsHealth.summary
  const heart = health?.heartRate.bpm ?? null
  const sleep = formatSleep(health?.sleep.durationMinutes) ?? "—"
  const steps = health?.steps.count
  const stepsCompact = typeof steps === "number" ? compactNumber(steps) : "—"
  const opsOrbState = orbStateFromVoice(voiceState, {
    loading: signalsLoading,
    urgent: prioritySignals.length > 0,
    executing: scanRefreshing,
  })
  const voiceSignal = odinSignalFromVoice(voiceState, {
    scanRefreshing,
  })

  const priorityCount = prioritySignals.length
  const calendarCount = staleExternalSignals
    ? nextEvents.length
    : nextEvents.length || pendingSummary.today
  const messageCount = sortedSignals.filter(
    (signal) => signal.source === "slack" || signal.source === "gmail"
  ).length
  const focusState = scanRefreshing
    ? "Refreshing scan"
    : voiceState.active
      ? "Voice active"
      : "Deep work"
  const agentBriefLine =
    agentBriefStatus.state === "requesting"
      ? agentBriefStatus.message
      : agentBriefStatus.state === "fresh"
        ? agentBriefStatus.message
      : agentBriefStatus.state === "stale"
          ? agentBriefStatus.message
          : staleExternalSignals
            ? agentFreshness.latestAt
              ? `Source brief stale (${formatAgentBriefAge(agentFreshness.latestAt)}). Run Live Scan.`
              : "No source brief available yet. Run Live Scan."
            : agentFreshness.detail
  const agentBriefTone =
    agentBriefStatus.state === "fresh" && !agentFreshness.stale
      ? "fresh"
      : agentBriefStatus.state === "requesting"
        ? "requesting"
        : "stale"
  const sphereSignals = sortedSignals.slice(0, 4)
  const leadPriority = prioritySignals[0] ?? null
  const secondaryPriority = prioritySignals[1] ?? null
  const weatherState = sourceHealth.find((source) => source.id === "weather")
  const withingsNeedsReconnectPortal =
    !!health?.needsReconnect ||
    /reconnect|refresh_token|authorization expired/i.test(
      withingsHealth.error?.message ?? ""
    )
  const healthLabel = withingsHealth.loading
    ? "Syncing"
    : withingsNeedsReconnectPortal || withingsHealth.error
      ? "Needs attention"
      : "Withings"
  const healthSyncLine = withingsHealth.refreshing
    ? "Syncing quietly"
    : withingsNeedsReconnectPortal
      ? "Reconnect in Accounts"
      : withingsHealth.error
        ? "Sync needs attention · tap to retry"
        : health
          ? `Synced ${withingsHealth.checkedAt ? timeAgo(withingsHealth.checkedAt) : "recently"} · tap to update`
          : "Tap to sync Withings"
  const focusOperationsPanel = () => {
    window.setTimeout(() => {
      document
        .querySelector("[data-operations-panel='true']")
        ?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, 60)
  }
  const handleQuickView = (nextView: UnifiedHubView) => {
    onViewChange(nextView)
    focusOperationsPanel()
  }
  const [portalCommand, setPortalCommand] = useState("")
  const submitPortalCommand = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = portalCommand.trim()
    if (!trimmed) return
    setPortalCommand("")
    onTextCommand(trimmed)
  }
  return (
    <LightPageShell mainClassName="odin-portal-main">
      <div className="mx-auto flex h-full max-w-[1780px] flex-col overflow-hidden">
        <header className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            onClick={onHallClick}
            className="group inline-flex items-center gap-4"
            aria-label="ODIN dashboard"
          >
            <span className="font-display text-2xl tracking-[0.36em] text-[#b6531c] transition group-hover:text-[#8f3b12]">
              ODIN
            </span>
            <span className="font-mono-data text-sm font-bold tracking-[0.1em] text-[#8a7058]">
              <ManilaMeta />
            </span>
          </button>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={onOpenSearch}
              className="odin-light-action bg-[#fff9ef]/55 px-5 py-3"
            >
              <Command size={16} />
              Command
            </button>
            <button
              type="button"
              onClick={onRefreshScan}
              disabled={scanRefreshing}
              className="odin-light-action odin-light-action-primary px-6 py-3 disabled:cursor-wait disabled:opacity-65"
            >
              <Zap size={16} className={scanRefreshing ? "animate-pulse" : ""} />
              Live Scan
            </button>
            <button
              type="button"
              onClick={onLock}
              className="odin-light-action bg-[#fff9ef]/55 px-5 py-3"
            >
              <X size={16} />
              Close portal
            </button>
          </div>
        </header>

        <section
          data-operations-panel="true"
          className="relative min-h-0 flex-1 overflow-hidden rounded-[32px] border border-white/70 bg-[#fff9ef]/35 shadow-[0_24px_70px_rgba(82,47,18,0.13)]"
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_42%_37%,rgba(255,255,255,0.9),transparent_34%),radial-gradient(circle_at_52%_54%,rgba(217,150,69,0.13),transparent_42%)]" />

          <div className="relative z-10 grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-6 px-10 py-8 xl:grid-cols-[minmax(0,1fr)_400px] xl:px-14">
            <div className="relative grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
              <div className="pl-[8%] pt-4">
                <h1 className="text-4xl font-semibold tracking-[-0.04em] text-[#2b1d0f]">
                  Good morning, Peter.
                </h1>
                <p className="mt-3 text-lg font-medium text-[#7d644e]">
                  Here's your control hub.
                </p>
                <div
                  className={[
                    "mt-4 max-w-[680px] rounded-2xl border px-4 py-3 text-sm font-semibold leading-relaxed shadow-[0_14px_34px_rgba(82,47,18,0.06)]",
                    agentBriefTone === "fresh"
                      ? "border-[#b7c99a]/70 bg-[#fbfff4]/72 text-[#506831]"
                      : agentBriefTone === "requesting"
                        ? "border-[#dfcfb1]/80 bg-white/65 text-[#7d644e]"
                        : "border-[#dc9d75]/70 bg-[#fff7ee]/75 text-[#9b4a1b]",
                  ].join(" ")}
                  data-agent-brief-status={agentBriefStatus.state}
                >
                  {agentBriefLine}
                </div>
              </div>

              <div className="relative min-h-0">
                <svg
                  className="pointer-events-none absolute left-[-9%] top-1/2 h-28 w-[104%] -translate-y-1/2 text-[#bd7a37]/35"
                  viewBox="0 0 900 120"
                  preserveAspectRatio="none"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M0 60 C55 63 80 49 115 60 S170 78 215 60 S270 43 322 60 S400 74 462 60 S540 44 590 60 S662 81 715 60 S780 42 835 60 S880 69 900 60"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>

                <div className="absolute left-[27%] top-1/2 grid h-[min(44vh,380px)] w-[min(44vh,380px)] -translate-x-1/2 -translate-y-1/2 place-items-center">
                  <button
                    type="button"
                    onClick={onAwaken}
                    className="relative grid h-[min(24vh,184px)] w-[min(24vh,184px)] place-items-center rounded-full outline-none transition hover:scale-[1.025] focus-visible:ring-2 focus-visible:ring-[#b6531c]"
                    aria-label="Talk to ODIN"
                  >
                    <PulseSphere
                      active={
                        voiceSignal.active ||
                        voiceState.active ||
                        voiceState.voiceDetected ||
                        signalsLoading
                      }
                      state={opsOrbState}
                      level={voiceState.micLevel}
                      signalState={voiceSignal.state}
                      signals={sphereSignals}
                    />
                  </button>
                </div>

                <div className="absolute left-[56%] top-1/2 grid min-w-[270px] -translate-y-1/2 gap-5">
                  <button
                    type="button"
                    onClick={() => handleQuickView("priority")}
                    className={[
                      "group grid grid-cols-[58px_1fr] items-center gap-5 rounded-3xl px-3 py-2 text-left transition hover:translate-x-1 hover:bg-white/60 hover:shadow-[0_10px_24px_rgba(82,47,18,0.07)]",
                      view === "priority" ? "bg-white/55 shadow-[0_10px_24px_rgba(82,47,18,0.06)]" : "",
                    ].join(" ")}
                  >
                    <span className="inline-grid h-[58px] w-[58px] place-items-center rounded-full bg-white/80 text-[#bd5a18] shadow-[0_12px_34px_rgba(82,47,18,0.09)]">
                      <Zap size={22} />
                    </span>
                    <span>
                      <span className="block text-xl font-extrabold text-[#2b1d0f]">Priority</span>
                      <span className="text-lg font-bold text-[#7d644e]">
                        {priorityCount} {priorityCount === 1 ? "item" : "items"}
                      </span>
                      {leadPriority && (
                        <span className="mt-1 block max-w-[220px] truncate text-xs font-semibold text-[#9b6c42]">
                          {contextualSignalTitle(leadPriority)}
                        </span>
                      )}
                    </span>
                  </button>
                  <Link
                    to="/calendar"
                    className="group grid grid-cols-[58px_1fr] items-center gap-5 rounded-3xl px-3 py-2 text-left transition hover:translate-x-1 hover:bg-white/60 hover:shadow-[0_10px_24px_rgba(82,47,18,0.07)]"
                  >
                    <span className="inline-grid h-[58px] w-[58px] place-items-center rounded-full bg-white/80 text-[#bd5a18] shadow-[0_12px_34px_rgba(82,47,18,0.09)]">
                      <CalendarDays size={22} />
                    </span>
                    <span>
                      <span className="block text-xl font-extrabold text-[#2b1d0f]">Calendar</span>
                      <span className="text-lg font-bold text-[#7d644e]">
                        {calendarCount} today
                      </span>
                    </span>
                  </Link>
                  <Link
                    to="/council"
                    className="group grid grid-cols-[58px_1fr] items-center gap-5 rounded-3xl px-3 py-2 text-left transition hover:translate-x-1 hover:bg-white/60 hover:shadow-[0_10px_24px_rgba(82,47,18,0.07)]"
                  >
                    <span className="inline-grid h-[58px] w-[58px] place-items-center rounded-full bg-white/80 text-[#bd5a18] shadow-[0_12px_34px_rgba(82,47,18,0.09)]">
                      <MessageSquare size={22} />
                    </span>
                    <span>
                      <span className="block text-xl font-extrabold text-[#2b1d0f]">Messages</span>
                      <span className="text-lg font-bold text-[#7d644e]">
                        {messageCount} unread
                      </span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => onTextCommand("Start a deep work focus plan for Peter. Be concise and give one next step.")}
                    className="group grid grid-cols-[58px_1fr] items-center gap-5 rounded-3xl px-3 py-2 text-left transition hover:translate-x-1 hover:bg-white/60 hover:shadow-[0_10px_24px_rgba(82,47,18,0.07)]"
                  >
                    <span className="inline-grid h-[58px] w-[58px] place-items-center rounded-full bg-white/80 text-[#bd5a18] shadow-[0_12px_34px_rgba(82,47,18,0.09)]">
                      <Settings size={22} />
                    </span>
                    <span>
                      <span className="block text-xl font-extrabold text-[#2b1d0f]">Focus</span>
                      <span className="text-lg font-bold text-[#7d644e]">{focusState}</span>
                    </span>
                  </button>
                </div>
              </div>

              <form
                onSubmit={submitPortalCommand}
                data-odin-signal={voiceSignal.state}
                className="odin-command-bar relative mx-auto mb-1 grid h-[66px] w-[min(620px,92%)] shrink-0 grid-cols-[48px_minmax(0,1fr)_44px] items-center gap-4 rounded-full border border-[#7a532d]/20 bg-white/78 px-3 py-2 shadow-[0_12px_34px_rgba(82,47,18,0.09)] backdrop-blur"
              >
                <div
                  className="odin-command-signal pointer-events-none absolute bottom-[calc(100%+10px)] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[#dfcfb1]/80 bg-[#fffaf1]/84 px-3 py-1.5 shadow-[0_14px_32px_-28px_rgba(72,45,14,0.55)] backdrop-blur"
                  data-state={voiceSignal.state}
                  aria-hidden={voiceSignal.state === "idle" ? "true" : "false"}
                >
                  <span className="odin-command-signal__dot" />
                  <span className="odin-command-signal__bars" aria-hidden="true">
                    {Array.from({ length: 8 }, (_, index) => (
                      <span
                        key={index}
                        style={{ animationDelay: `${index * -70}ms` }}
                      />
                    ))}
                  </span>
                  <span className="font-mono-data text-[10px] font-bold uppercase tracking-[0.18em] text-[#6d5334]">
                    {voiceSignal.label}
                  </span>
                  {voiceSignal.detail && (
                    <span className="font-mono-data text-[10px] font-bold uppercase tracking-[0.14em] text-[#b6531c]">
                      {voiceSignal.detail}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onAwaken}
                  className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-[#aa4611] to-[#ca6e20] text-white shadow-[0_12px_24px_rgba(189,90,24,0.25)]"
                  aria-label="Press to talk to ODIN"
                >
                  <Mic2 size={20} />
                </button>
                <input
                  value={portalCommand}
                  onChange={(event) => setPortalCommand(event.target.value)}
                  placeholder="Type to ODIN, or press the mic..."
                  className="min-w-0 bg-transparent text-base font-semibold text-[#2b1d0f] outline-none placeholder:text-[#7d644e]"
                  aria-label="Type a command to ODIN"
                />
                <button
                  type="submit"
                  className="grid h-11 w-11 place-items-center rounded-full text-[#bd5a18] transition hover:bg-[#f4dfc5]"
                  aria-label="Send ODIN command"
                >
                  <Activity size={22} />
                </button>
              </form>
            </div>

            <aside
              data-dashboard-right-rail="true"
              className="relative z-10 flex min-h-0 flex-col gap-3 overflow-hidden"
            >
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1 scrollbar-thin">
                <section className="rounded-[20px] border border-white/70 bg-[#fffaf1]/75 p-3.5 shadow-[0_12px_30px_rgba(82,47,18,0.08)] backdrop-blur">
                  <p className="label-track mb-2 text-[#9a7252]">Weather</p>
                  <div className="grid grid-cols-[42px_1fr] items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[#f4dfc5] text-[#bd5a18]">
                      <Cloud size={24} />
                    </span>
                    <div>
                      <div className="text-3xl font-semibold leading-none tracking-[-0.05em] text-[#2b1d0f]">
                        32°
                      </div>
                      <p className="mt-1 text-[11px] font-medium leading-snug text-[#7d644e]">
                        {weatherState?.state === "attention" || weatherState?.state === "disconnected"
                          ? "Weather needs reconnect"
                          : "Partly cloudy"}
                        <span className="ml-2 text-[#9b815e]">H 33° · L 26°</span>
                      </p>
                    </div>
                  </div>
                </section>

                <section className="rounded-[20px] border border-white/70 bg-[#fffaf1]/75 p-4 shadow-[0_12px_34px_rgba(82,47,18,0.09)] backdrop-blur">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <p className="label-track text-[#9a7252]">Priority signal</p>
                      <p
                        className={[
                          "mt-1 text-[11px] font-bold uppercase tracking-[0.14em]",
                          agentBriefTone === "fresh" ? "text-[#5f7d3b]" : "text-[#b6531c]",
                        ].join(" ")}
                      >
                        {agentBriefTone === "fresh" ? "Fresh agent brief" : "Last-known queue"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleQuickView("priority")}
                      className="rounded-full border border-[#dfcfb1] px-3 py-1.5 text-[11px] font-bold text-[#2b1d0f] transition hover:border-[#b6531c]/50 hover:bg-[#f2dfc2]"
                    >
                      Open list
                    </button>
                  </div>
                  {leadPriority ? (
                    <div className="rounded-2xl border border-[#dfcfb1]/55 bg-white/45 p-3">
                      <div className="flex items-start gap-3">
                        <SourceGlyph source={leadPriority.source} className="h-8 w-8 shrink-0" />
                        <div className="min-w-0">
                          <p className="line-clamp-2 text-sm font-extrabold leading-snug text-[#2b1d0f]">
                            {contextualSignalTitle(leadPriority)}
                          </p>
                          <p className="mt-1 line-clamp-3 text-xs font-semibold leading-relaxed text-[#6d5334]">
                            {contextualSignalDetail(leadPriority, 170)}
                          </p>
                          <p className="mt-2 truncate font-mono-data text-[10px] font-bold uppercase tracking-[0.12em] text-[#9b815e]">
                            {leadPriority.business ?? leadPriority.source}
                            {leadPriority.person ? ` · ${leadPriority.person}` : ""}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => handleQuickView("priority")}
                          className="rounded-full border border-[#dfcfb1] px-3 py-1 text-[11px] font-bold text-[#2b1d0f] transition hover:border-[#b6531c]/50 hover:bg-[#f2dfc2]"
                        >
                          Details
                        </button>
                        {leadPriority.status !== "handled" && (
                          <button
                            type="button"
                            onClick={() => void onSignalStatusChange(leadPriority.id, "handled")}
                            className="rounded-full border border-[#dfcfb1] px-3 py-1 text-[11px] font-bold text-[#2b1d0f] transition hover:border-[#b6531c]/50 hover:bg-[#f2dfc2]"
                          >
                            Handled
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="rounded-2xl border border-[#dfcfb1]/55 bg-white/45 p-3 text-sm font-semibold text-[#7d644e]">
                      No fresh priority item is loaded. Run Live Scan, then post a Claude/Codex brief to refresh this queue.
                    </p>
                  )}
                </section>

                <section className="rounded-[20px] border border-white/70 bg-[#fffaf1]/75 p-4 shadow-[0_12px_34px_rgba(82,47,18,0.09)] backdrop-blur">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="label-track text-[#9a7252]">Time zones</p>
                    <span className="text-[11px] font-semibold text-[#9b815e]">editable</span>
                  </div>
                  <div className="grid gap-1.5">
                    {timeZoneCards.map((zone, index) => (
                      <label
                        key={zone.id}
                        className="grid grid-cols-[minmax(0,1fr)_64px] items-center gap-3 rounded-2xl border border-[#dfcfb1]/60 bg-white/45 px-3 py-1.5"
                      >
                        <select
                          value={zone.timeZone}
                          onChange={(event) => onTimeZoneChange(index, event.target.value)}
                          className="min-w-0 bg-transparent text-sm font-extrabold text-[#2b1d0f] outline-none"
                          aria-label={`Timezone slot ${index + 1}`}
                        >
                          {TIMEZONE_OPTIONS.map((option) => (
                            <option key={option.timeZone} value={option.timeZone}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <span className="text-right font-mono-data text-[13px] font-extrabold text-[#7d644e]">
                          {zoneClock(zone.timeZone)}
                        </span>
                      </label>
                    ))}
                  </div>
                </section>

                <section className="rounded-[20px] border border-white/70 bg-[#fffaf1]/75 p-4 shadow-[0_12px_34px_rgba(82,47,18,0.09)] backdrop-blur">
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <div>
                      <p className="label-track text-[#9a7252]">Health · {healthLabel}</p>
                      <button
                        type="button"
                        onClick={() => {
                          if (!withingsNeedsReconnectPortal) void withingsHealth.refresh(true)
                        }}
                        disabled={withingsHealth.refreshing || withingsNeedsReconnectPortal}
                        className="group mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#9b815e] transition hover:text-[#b6531c] disabled:cursor-default disabled:opacity-70"
                        aria-label="Sync Withings health data"
                        title="Sync Withings health data"
                      >
                        <span
                          className={[
                            "h-1.5 w-1.5 rounded-full transition",
                            withingsHealth.refreshing
                              ? "animate-pulse bg-[#b6531c]"
                              : withingsHealth.error
                                ? "bg-destructive/80"
                                : "bg-[#b6531c]/55 group-hover:bg-[#b6531c]",
                          ].join(" ")}
                        />
                        <span>{healthSyncLine}</span>
                      </button>
                    </div>
                    <Link
                      to="/health"
                      className="label-track text-[#9a7252] transition hover:text-[#b6531c]"
                      aria-label="Open health"
                    >
                      ›
                    </Link>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="rounded-2xl border border-[#dfcfb1]/55 bg-white/45 p-2.5">
                      <span className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-[#f4dfc5] text-[#bd5a18]">
                        <HeartPulse size={16} />
                      </span>
                      <span className="text-xs font-semibold text-[#7d644e]">Heart</span>
                      <strong className="mt-1 block text-lg tracking-[-0.04em] text-[#2b1d0f]">
                        {typeof heart === "number" ? `${heart} bpm` : "—"}
                      </strong>
                    </div>
                    <div className="rounded-2xl border border-[#dfcfb1]/55 bg-white/45 p-2.5">
                      <span className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-[#f4dfc5] text-[#bd5a18]">
                        <Bed size={16} />
                      </span>
                      <span className="text-xs font-semibold text-[#7d644e]">Sleep</span>
                      <strong className="mt-1 block text-lg tracking-[-0.04em] text-[#2b1d0f]">
                        {sleep}
                      </strong>
                    </div>
                    <div className="rounded-2xl border border-[#dfcfb1]/55 bg-white/45 p-2.5">
                      <span className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-[#f4dfc5] text-[#bd5a18]">
                        <Footprints size={16} />
                      </span>
                      <span className="text-xs font-semibold text-[#7d644e]">Steps</span>
                      <strong className="mt-1 block text-lg tracking-[-0.04em] text-[#2b1d0f]">
                        {stepsCompact}
                      </strong>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-[1fr_72px] items-center gap-3">
                    <HeartbeatLine className="h-7 w-full opacity-80" />
                    <div className="flex h-8 items-end justify-end gap-1" aria-label="Step activity bar">
                      {[6, 12, 8, 20, 28, 16].map((height, index) => (
                        <span
                          key={index}
                          className="w-1 rounded-full bg-[#bd5a18]/75"
                          style={{ height }}
                        />
                      ))}
                    </div>
                  </div>
                </section>
              </div>
              <React.Suspense fallback={<MusicBoxFallback className="shrink-0 border-white/70 bg-[#fffaf1]/88" />}>
                <MusicBoxWidget
                  size="mini"
                  onOpen={onOpenMusic}
                  className="shrink-0 border-white/70 bg-[#fffaf1]/88"
                />
              </React.Suspense>

              {secondaryPriority && (
                <section className="shrink-0 rounded-[20px] border border-white/70 bg-[#fffaf1]/75 p-4 shadow-[0_12px_34px_rgba(82,47,18,0.08)] backdrop-blur">
                  <p className="label-track text-[#9a7252]">Next in queue</p>
                  <button
                    type="button"
                    onClick={() => handleQuickView("priority")}
                    className="mt-3 flex w-full items-start gap-3 text-left"
                  >
                    <SourceGlyph source={secondaryPriority.source} className="h-8 w-8 shrink-0" />
                    <span className="min-w-0">
                      <span className="line-clamp-2 block text-sm font-extrabold leading-snug text-[#2b1d0f]">
                        {contextualSignalTitle(secondaryPriority)}
                      </span>
                      <span className="mt-1 line-clamp-2 block text-xs font-semibold leading-relaxed text-[#6d5334]">
                        {contextualSignalDetail(secondaryPriority, 120)}
                      </span>
                    </span>
                  </button>
                </section>
              )}

            </aside>
          </div>
        </section>
      </div>
    </LightPageShell>
  )

}

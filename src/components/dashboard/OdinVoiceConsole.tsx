import { useEffect, useRef, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { ConversationProvider, useConversation } from "@elevenlabs/react"
import {
  ExternalLink,
  Loader2,
  Mic,
  Power,
  Send,
  Shield,
  Volume2,
  X,
  Zap,
} from "lucide-react"
import {
  getElevenLabsSession,
  invokeOdinCommand,
  type OdinCommandMode,
  type OdinCommandResponse,
  type OdinScanSource,
} from "@/lib/odinOrchestrator"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import {
  listSpotifyDevices,
  pauseSpotify,
  playSpotify,
  searchSpotify,
} from "@/lib/connectors/spotify"
import {
  spotifyReadinessFromError,
  spotifyReadinessMessage,
} from "@/lib/spotifyReadiness"
import { loadMusicState, saveMusicState, type MusicState, type MusicTrack } from "@/lib/musicState"
import { localConversationResponse, toneForMode } from "@/lib/odinPersona"
import {
  isLocalBrowserCommand,
  runLocalBrowserCommand,
} from "@/lib/localBrowserCommand"
import { useAuth } from "@/hooks/useAuth"
import { resolveWeatherLocationForOdin } from "@/lib/weatherLocation"
import { saveOdinSurfaceHandoff } from "@/lib/odinSurfaceState"

export type ListenerPhase =
  | "idle"
  | "wake"
  | "connecting"
  | "listening"
  | "speaking"
  | "blocked"

type OdinDigestPhase = "idle" | "received" | "routing" | "digesting" | "ready" | "error"

type SpeechRecognitionAlternativeLike = {
  transcript: string
  confidence?: number
}

type SpeechRecognitionResultLike = {
  isFinal: boolean
  length: number
  [index: number]: SpeechRecognitionAlternativeLike | undefined
}

type SpeechRecognitionEventLike = Event & {
  resultIndex: number
  results: {
    length: number
    [index: number]: SpeechRecognitionResultLike | undefined
  }
}

type SpeechRecognitionErrorEventLike = Event & {
  error?: string
  message?: string
}

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onend: ((event: Event) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onstart: ((event: Event) => void) | null
  abort: () => void
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

type WindowWithSpeechRecognition = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }

type ElevenLabsMessageEvent = {
  user_transcription_event?: {
    user_transcript?: unknown
  }
  user_transcript?: unknown
  agent_response_event?: {
    agent_response?: unknown
  }
  agent_response?: unknown
  message?: unknown
  role?: unknown
  source?: unknown
}

type ElevenLabsModeEvent =
  | string
  | {
      mode?: unknown
    }

type ElevenLabsDisconnectDetails = {
  reason?: "agent" | "user" | "error" | string
  message?: string
  closeCode?: number
  closeReason?: string
}

export type OdinVoiceSurfaceState = {
  active: boolean
  status: "idle" | "wake" | "connecting" | "listening" | "speaking" | "online" | "thinking" | "error"
  message: string
  latest: OdinCommandResponse | null
  error: string | null
  micLevel: number
  micLive: boolean
  voiceDetected: boolean
  listenerPhase: ListenerPhase
  transcript: string
  wakeArmed: boolean
  wakeSupported: boolean
  wakeTranscript: string
  wakeLastHeardAt: string | null
  wakeError: string | null
  inputState: "standby" | "wake" | "hearing" | "captured" | "thinking" | "speaking" | "blocked"
  digestPhase?: OdinDigestPhase
  digestElapsedMs?: number
}

function modeForCommand(command: string): OdinCommandMode {
  const lower = command.toLowerCase()
  const mentionsSlack = /\b(slack|dm|dms|channel|council)\b/.test(lower)
  const mentionsGmail = /\b(gmail|email|emails|inbox|mail)\b/.test(lower)
  const mentionsCalendar = /\b(calendar|schedule|meeting|agenda|event|events)\b/.test(lower)
  const mentionsHealth = /\b(vital|vitals|health|withings|heart|pulse|bpm|steps|calories|sleep|resting|watch)\b/.test(lower)
  const mentionsWeather = /\b(weather|forecast|temperature|rain|raining|storm|hot|cold|humidity|outside|umbrella)\b/.test(lower)
  const mentionsBrowser =
    /\b(browser|browse|web browser|computer-use|computer use|visible page)\b/.test(lower) ||
    /https?:\/\/\S+/i.test(command)
  if (/\b(research|investigate|analyze|analyse|process|summari[sz]e|compare|strategy|think through|break down)\b/.test(lower)) {
    return "research"
  }
  const sourceCount = [mentionsSlack, mentionsGmail, mentionsCalendar, mentionsHealth, mentionsWeather, mentionsBrowser].filter(Boolean).length
  if (sourceCount > 1) return "combined"
  if (mentionsSlack) return "slack"
  if (mentionsGmail) return "gmail"
  if (mentionsCalendar) return "calendar"
  if (mentionsHealth) return "health"
  if (mentionsWeather) return "weather"
  if (mentionsBrowser) return "browser"
  if (/\b(brief|scan|what needs|attention|priority|priorities|today|now|daily|my day|operations|ops|anything urgent|what matters|wake up|good morning)\b/.test(lower)) {
    return "brief"
  }
  return "chat"
}

function commandNeedsWeather(command: string): boolean {
  return /\b(weather|forecast|temperature|rain|raining|storm|hot|cold|humidity|outside|umbrella)\b/i.test(command)
}

function commandRequestsFreshSource(command: string): boolean {
  return /\b(read|check|scan|refresh|pull|look at|priority|priorities|what matters|needs attention|urgent|vitals|health|calendar|schedule)\b/i.test(command)
}

function shouldUseRecentContext(command: string) {
  return /\b(first|second|third|that|this|more|explain|why|draft|reply|tell me more|yes|no|continue|go on|keep going|what about|how about|okay|ok|sure|details|more details|do it|sounds good|what do you mean)\b/i.test(
    command
  )
}

function scanSourcesForCommand(mode: OdinCommandMode, command: string): OdinScanSource[] | undefined {
  if (mode === "weather") return ["weather"]
  if (!commandRequestsFreshSource(command)) return undefined

  const lower = command.toLowerCase()
  const sources = new Set<OdinScanSource>()
  if (mode === "gmail" || /\b(gmail|email|emails|inbox|mail)\b/.test(lower)) sources.add("gmail")
  if (mode === "slack" || /\b(slack|dm|dms|channel|council)\b/.test(lower)) sources.add("slack")
  if (mode === "calendar" || /\b(calendar|schedule|meeting|agenda|event|events)\b/.test(lower)) sources.add("calendar")
  if (mode === "health" || /\b(vital|vitals|health|withings|heart|pulse|bpm|steps|calories|sleep|resting|watch)\b/.test(lower)) sources.add("health")
  if (mode === "browser") sources.add("browser")
  if (mode === "combined") {
    if (/\b(gmail|email|emails|inbox|mail)\b/.test(lower)) sources.add("gmail")
    if (/\b(slack|dm|dms|channel|council)\b/.test(lower)) sources.add("slack")
    if (/\b(calendar|schedule|meeting|agenda|event|events)\b/.test(lower)) sources.add("calendar")
    if (/\b(vital|vitals|health|withings|heart|pulse|bpm|steps|calories|sleep|resting|watch)\b/.test(lower)) sources.add("health")
  }

  return sources.size ? [...sources] : undefined
}

type SpotifyVoiceAction = "play" | "pause" | "next" | "previous"
type SpotifyVoiceIntent = {
  action: SpotifyVoiceAction
  query: string | null
}

function isMusicSurfaceCommand(command: string) {
  return /\b(open|show|launch|go to)\b[\s\w-]*\b(music|spotify|music box)\b/i.test(command)
}

function parseSpotifyVoiceIntent(command: string): SpotifyVoiceIntent | null {
  const cleaned = command.trim()
  const lower = cleaned.toLowerCase()
  const mentionsMusic = /\b(spotify|music|song|songs|track|playlist)\b/.test(lower)

  if (/\b(next|skip)\b/.test(lower) && mentionsMusic) {
    return { action: "next", query: null }
  }
  if (/\b(previous|prev|back)\b/.test(lower) && mentionsMusic) {
    return { action: "previous", query: null }
  }
  if (/\b(pause|stop)\b/.test(lower) && mentionsMusic) {
    return { action: "pause", query: null }
  }

  const playMatch = cleaned.match(/\b(?:play|resume|start)\b\s*(.*)$/i)
  if (!playMatch) return null
  let query = (playMatch[1] ?? "").trim()
  query = query
    .replace(/\bon spotify\b/gi, "")
    .replace(/\bfor me\b/gi, "")
    .replace(/\bplease\b/gi, "")
    .replace(/^[\s,:-]+|[\s,:-]+$/g, "")
  if (!query) return { action: "play", query: null }
  if (/^(?:some\s+music|music|something)$/.test(query.toLowerCase())) {
    return { action: "play", query: null }
  }
  return { action: "play", query }
}

function playableQueueTracks(state: MusicState): MusicTrack[] {
  const seen = new Set<string>()
  return [state.current, ...state.queue].filter((track) => {
    const uri = track.uri ?? ""
    if (!uri) return false
    if (seen.has(uri)) return false
    seen.add(uri)
    return true
  })
}

function queueNeighborTrack(
  queue: MusicTrack[],
  current: MusicTrack,
  direction: "next" | "previous"
): MusicTrack | null {
  if (queue.length < 2) return null
  const currentIndex = queue.findIndex((track) => track.uri && track.uri === current.uri)
  const safeIndex = currentIndex >= 0 ? currentIndex : 0
  const nextIndex =
    direction === "next"
      ? (safeIndex + 1) % queue.length
      : (safeIndex - 1 + queue.length) % queue.length
  return queue[nextIndex] ?? null
}

function pageToRoute(page: string): { route: string; label: string } | null {
  if (!/\b(open|show|go to|take me to)\b/i.test(page)) return null
  const lower = page.toLowerCase()
  if (/\b(council|slack|dm|dms)\b/.test(lower)) return { route: "/council", label: "Council" }
  if (/\b(calendar|schedule|agenda|events)\b/.test(lower)) return { route: "/calendar", label: "Calendar" }
  if (/\b(browser|browse|web browser|computer-use|computer use)\b/.test(lower)) return { route: "/browser", label: "Browser" }
  if (/\b(raven|ravens|connection|connections|account|accounts)\b/.test(lower)) return { route: "/connections", label: "Ravens" }
  if (/\b(setting|settings|profile|memory)\b/.test(lower)) return { route: "/settings", label: "Settings" }
  if (/\b(hall|dashboard|home)\b/.test(lower)) return { route: "/dashboard?portal=open", label: "Hall" }
  return null
}

function responsePreview(response: OdinCommandResponse | null) {
  if (!response) return ""
  const parts = [
    response.displayText,
    ...response.signals.slice(0, 3).map((signal) =>
      [signal.title, signal.summary, signal.nextAction].filter(Boolean).join(" | ")
    ),
  ]
  return parts.join("\n").slice(0, 1800)
}

interface LocalTurn {
  role: "user" | "assistant"
  text: string
}

function compactTurnText(value: string, max = 700) {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function turnHistoryPreview(turns: LocalTurn[]) {
  if (!turns.length) return ""
  return turns
    .slice(-8)
    .map((turn) => `${turn.role === "user" ? "Peter" : "ODIN"}: ${compactTurnText(turn.text)}`)
    .join("\n")
}

function emptyResponse(message: string): OdinCommandResponse {
  return {
    spokenText: message,
    displayText: message,
    signals: [],
    sourceLinks: [],
    drafts: [],
    warnings: [],
    toolRuns: [{ tool: "odin-local", status: "ok" }],
    suggestions: ["What needs me today?", "Read my calendar.", "What can you do?"],
    conversationState: {
      activeTopic: "local_voice",
      unresolvedQuestion: null,
    },
  }
}

function scrubUrlsForVoice(text: string): string {
  if (!text) return text
  return text
    .replace(/https?:\/\/\S+/gi, "that link")
    .replace(/\bwww\.\S+/gi, "that link")
}

const ODIN_VOICE_TOOL_ENFORCEMENT_PROMPT = [
  "You are ODIN voice for Peter.",
  "For every user request, call the client tool askOdin first and wait for its result before speaking.",
  "Do not answer from your own knowledge when askOdin is available.",
  "Never invoke the end_call tool. Keep the channel open unless Peter explicitly says stop.",
  "Never read URLs, never spell links, and never include raw links in spoken output.",
  "For music commands (play, pause, next, previous, open music), rely on askOdin result only.",
  "If askOdin returns a failure message, read it exactly and keep it short.",
].join(" ")

function voiceSafeResponse(response: OdinCommandResponse): OdinCommandResponse {
  return {
    ...response,
    spokenText: scrubUrlsForVoice(response.spokenText),
    displayText: scrubUrlsForVoice(response.displayText),
    sourceLinks: [],
  }
}

function currentDashboardUrl() {
  return `${window.location.origin}${window.location.pathname}`
}

function waitForMicRelease() {
  return new Promise((resolve) => window.setTimeout(resolve, 220))
}

function disconnectReasonCopy(details: ElevenLabsDisconnectDetails): string {
  if (details.reason === "user") return "ODIN voice session closed."
  if (details.reason === "agent") {
    if (details.closeReason) return `Voice session ended: ${details.closeReason}`
    return "ODIN ended the last voice turn."
  }
  if (details.reason === "error") {
    if (details.message) return `Voice link dropped: ${details.message}`
    return "Voice link dropped."
  }
  return "ODIN voice session closed."
}

function digestPhaseLabel(phase: OdinDigestPhase) {
  if (phase === "received") return "received"
  if (phase === "routing") return "routing"
  if (phase === "digesting") return "digesting"
  if (phase === "ready") return "answer ready"
  if (phase === "error") return "needs attention"
  return "standby"
}

function formatDigestElapsed(ms: number) {
  if (ms <= 0) return "0.0s"
  return `${(ms / 1000).toFixed(1)}s`
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as WindowWithSpeechRecognition
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null
}

function commandAfterWakePhrase(transcript: string): string | null {
  const cleaned = transcript.replace(/\s+/g, " ").trim()
  if (!cleaned) return null

  const wakePattern =
    /\b(?:hey\s+odin|hi\s+odin|okay\s+odin|ok\s+odin|odin\s+wake\s+up|wake\s+up\s+odin)\b/i
  if (!wakePattern.test(cleaned)) return null

  const followUp = cleaned
    .replace(wakePattern, "")
    .replace(/^[\s,.:;-]+/, "")
    .trim()

  return followUp
}

async function copyDashboardUrl() {
  await navigator.clipboard?.writeText(currentDashboardUrl())
}

interface OdinVoiceConsoleProps {
  autoStartKey?: number
  stopKey?: number
  enableWakeKey?: number
  initialCommand?: string
  onClose?: () => void
  variant?: "panel" | "controller"
  onStateChange?: (state: OdinVoiceSurfaceState) => void
}

export function OdinVoiceConsole({
  autoStartKey = 0,
  stopKey = 0,
  enableWakeKey = 0,
  initialCommand,
  onClose,
  variant = "panel",
  onStateChange,
}: OdinVoiceConsoleProps) {
  return (
    <ConversationProvider>
      <OdinVoiceConsoleInner
        autoStartKey={autoStartKey}
        stopKey={stopKey}
        enableWakeKey={enableWakeKey}
        initialCommand={initialCommand}
        onClose={onClose}
        variant={variant}
        onStateChange={onStateChange}
      />
    </ConversationProvider>
  )
}

function OdinVoiceConsoleInner({
  autoStartKey,
  stopKey,
  enableWakeKey,
  initialCommand,
  onClose,
  variant,
  onStateChange,
}: {
  autoStartKey: number
  stopKey: number
  enableWakeKey: number
  initialCommand?: string
  onClose?: () => void
  variant: "panel" | "controller"
  onStateChange?: OdinVoiceConsoleProps["onStateChange"]
}) {
  const { user } = useAuth()
  const { spotify } = useConnectedAccounts()
  const navigate = useNavigate()
  const pendingMessageRef = useRef<string | null>(null)
  const latestRef = useRef<OdinCommandResponse | null>(null)
  const turnHistoryRef = useRef<LocalTurn[]>([])
  const textInputRef = useRef<HTMLInputElement | null>(null)
  const conversationIdRef = useRef(`odin-${crypto.randomUUID()}`)
  const micMonitorRef = useRef<{
    analyser: AnalyserNode
    context: AudioContext
    data: Uint8Array
    frame: number
    source: MediaStreamAudioSourceNode
    stream: MediaStream
  } | null>(null)
  const smoothedMicLevelRef = useRef(0)
  const voiceHoldUntilRef = useRef(0)
  const voiceDetectedRef = useRef(false)
  const silenceTimerRef = useRef<number | null>(null)
  const lastVadSignalRef = useRef(0)
  const userSpeechActiveRef = useRef(false)
  const turnPendingRef = useRef(false)
  const startInFlightRef = useRef(false)
  const manualStopRef = useRef(false)
  const sessionStartAtRef = useRef(0)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const activeStateRef = useRef({
    active: false,
    busy: false,
    connected: false,
    connecting: false,
  })
  const wakeRecognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const wakeShouldRunRef = useRef(false)
  const wakeRestartTimerRef = useRef<number | null>(null)
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [latest, setLatest] = useState<OdinCommandResponse | null>(null)
  const [voiceMessage, setVoiceMessage] = useState("ODIN voice standby")
  const [transcript, setTranscript] = useState("")
  const [voicePulseKey, setVoicePulseKey] = useState(0)
  const [wakeArmed, setWakeArmed] = useState(false)
  const [wakeSupported, setWakeSupported] = useState(false)
  const [wakeTranscript, setWakeTranscript] = useState("")
  const [wakeLastHeardAt, setWakeLastHeardAt] = useState<string | null>(null)
  const [wakeError, setWakeError] = useState<string | null>(null)
  const [wakeOptIn, setWakeOptIn] = useState(false)
  const [micPermission, setMicPermission] = useState<PermissionState | "unknown">("unknown")
  const [audioInputCount, setAudioInputCount] = useState<number | null>(null)
  const [elevenStatus, setElevenStatus] = useState<"unknown" | "ok" | "error">("unknown")
  const [micLevel, setMicLevel] = useState(0)
  const [micLive, setMicLive] = useState(false)
  const [voiceDetected, setVoiceDetected] = useState(false)
  const [digestPhase, setDigestPhase] = useState<OdinDigestPhase>("idle")
  const [digestStartedAt, setDigestStartedAt] = useState<number | null>(null)
  const [digestElapsedMs, setDigestElapsedMs] = useState(0)

  const conversation = useConversation({
    clientTools: {
      askOdin: async (params: Record<string, unknown>) => {
        const command = String(params.query ?? params.command ?? "").trim()
        if (!command) return "I need the actual command, Peter. Even I require a sentence."
        return await runOdinTool(command, "voice")
      },
    },
    onConnect: () => {
      startInFlightRef.current = false
      reconnectAttemptsRef.current = 0
      setVoiceMessage("ODIN is online. Speak naturally.")
      setError(null)
    },
    onDisconnect: (payload: unknown) => {
      const details =
        payload && typeof payload === "object"
          ? (payload as ElevenLabsDisconnectDetails)
          : ({ reason: "agent" } as ElevenLabsDisconnectDetails)
      startInFlightRef.current = false
      resetVoiceActivity()
      if (manualStopRef.current || details.reason === "user") {
        setVoiceMessage("ODIN voice session closed.")
        return
      }

      const isTransportError =
        details.reason === "error" ||
        (typeof details.closeCode === "number" && details.closeCode !== 1000)

      if (isTransportError && reconnectAttemptsRef.current < 2) {
        reconnectAttemptsRef.current += 1
        setVoiceMessage("Voice link dropped. Reconnecting.")
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current)
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          void startSession()
        }, 360)
        return
      }

      setVoiceMessage(disconnectReasonCopy(details))
    },
    onError: (_message: unknown) => {
      startInFlightRef.current = false
      const message =
        typeof _message === "string"
          ? _message
          : "ODIN voice session could not connect."
      setError(message)
      setVoiceMessage("Voice core needs attention; text command still works.")
      resetVoiceActivity()
    },
    onInterruption: () => {
      setVoiceMessage("Interrupted. Listening.")
    },
    onVadScore: (event: { vadScore?: number }) => {
      const score = typeof event.vadScore === "number" ? event.vadScore : 0
      const level = Math.max(0, Math.min(1, score))
      setMicLive(true)
      setMicLevel((previous) => {
        const next = previous + (level - previous) * (level > previous ? 0.45 : 0.18)
        return Math.abs(next - previous) > 0.015 ? next : previous
      })

      if (level > 0.18) {
        lastVadSignalRef.current = performance.now()
        userSpeechActiveRef.current = true
        turnPendingRef.current = false
        markVoiceDetected(1100)
        setVoiceMessage("Hearing you.")
        scheduleSpeechFinalization()
        return
      }

      if (userSpeechActiveRef.current) scheduleSpeechFinalization()
    },
    onMessage: (payload: unknown) => {
      const event = payload as ElevenLabsMessageEvent
      const userText =
        event?.user_transcription_event?.user_transcript ??
        event?.user_transcript ??
        (event?.role === "user" || event?.source === "user" ? event?.message : "") ??
        ""
      const agentText =
        event?.agent_response_event?.agent_response ??
        event?.agent_response ??
        (event?.role === "agent" || event?.source === "ai" ? event?.message : "") ??
        ""

      if (typeof userText === "string" && userText.trim()) {
        const cleaned = userText.trim()
        setTranscript(cleaned)
        appendTurn("user", cleaned)
        clearSilenceTimer()
        userSpeechActiveRef.current = false
        turnPendingRef.current = true
        beginDigest("Words captured. Routing to ODIN.")
        setVoiceMessage("Got it. ODIN is thinking.")
        markVoiceDetected()
        setVoicePulseKey((value) => value + 1)
        return
      }

      if (typeof agentText === "string" && agentText.trim()) {
        clearSilenceTimer()
        userSpeechActiveRef.current = false
        turnPendingRef.current = false
        appendTurn("assistant", agentText.trim())
        finishDigest("ready", "Answer ready. ODIN is speaking.")
        setVoiceMessage("ODIN responding.")
        setVoicePulseKey((value) => value + 1)
      }
    },
    onModeChange: (event: ElevenLabsModeEvent) => {
      const mode = typeof event === "string" ? event : event?.mode
      if (mode === "speaking") {
        clearSilenceTimer()
        userSpeechActiveRef.current = false
        turnPendingRef.current = false
        setVoiceMessage("ODIN responding.")
        return
      }
      if (turnPendingRef.current) {
        setVoiceMessage("Got it. ODIN is thinking.")
        return
      }
      setVoiceMessage(userSpeechActiveRef.current ? "Listening for your pause." : "Listening.")
    },
  })

  const connected = conversation.status === "connected"
  const connecting = conversation.status === "connecting"
  const active = connected || connecting
  const speaking = connected && conversation.isSpeaking
  const listening = connected && conversation.isListening

  useEffect(() => {
    if (!digestStartedAt || !["received", "routing", "digesting"].includes(digestPhase)) {
      return
    }
    setDigestElapsedMs(Date.now() - digestStartedAt)
    const timer = window.setInterval(() => {
      setDigestElapsedMs(Date.now() - digestStartedAt)
    }, 160)
    return () => window.clearInterval(timer)
  }, [digestPhase, digestStartedAt])

  useEffect(() => {
    activeStateRef.current = { active, busy, connected, connecting }
  }, [active, busy, connected, connecting])

  useEffect(() => {
    setWakeSupported(Boolean(speechRecognitionConstructor()))
  }, [])

  useEffect(() => {
    latestRef.current = latest
  }, [latest])

  function appendTurn(role: LocalTurn["role"], text: string) {
    if (!text.trim()) return
    turnHistoryRef.current = [
      ...turnHistoryRef.current,
      { role, text: compactTurnText(text, 900) },
    ].slice(-12)
  }

  async function runSpotifyVoiceCommand(command: string): Promise<OdinCommandResponse | null> {
    const intent = parseSpotifyVoiceIntent(command)
    if (!intent) return null
    navigate("/music")

    const currentState = loadMusicState()
    const activeAccount =
      spotify.find((account) => account.id === currentState.activeAccountId) ??
      spotify[0]
    if (!activeAccount?.id) {
      return emptyResponse("Connect Spotify first.")
    }

    try {
      const accountId = activeAccount.id
      const playbackNow = Date.now()
      let workingState = currentState

      if (intent.action === "play") {
        let fallbackTrack: MusicTrack | null = null
        if (intent.query) {
          const match = await searchSpotify(intent.query, accountId)
          const firstPlayable = match.tracks.find((track) => Boolean(track.uri))
          if (!firstPlayable) {
            return emptyResponse(`I couldn't find a playable Spotify match for "${intent.query}".`)
          }
          fallbackTrack = {
            title: firstPlayable.title,
            artist: firstPlayable.artist,
            album: firstPlayable.album,
            url: firstPlayable.url,
            uri: firstPlayable.uri,
            imageUrl: firstPlayable.imageUrl,
            durationMs: firstPlayable.durationMs,
          }
        } else {
          const queueTracks = playableQueueTracks(currentState)
          fallbackTrack =
            queueTracks.find((track) => Boolean(track.uri)) ??
            null
          if (!fallbackTrack?.uri) {
            const seed = await searchSpotify("top hits", accountId)
            const firstPlayable = seed.tracks.find((track) => Boolean(track.uri))
            if (firstPlayable) {
              fallbackTrack = {
                title: firstPlayable.title,
                artist: firstPlayable.artist,
                album: firstPlayable.album,
                url: firstPlayable.url,
                uri: firstPlayable.uri,
                imageUrl: firstPlayable.imageUrl,
                durationMs: firstPlayable.durationMs,
              }
            }
          }
        }
        workingState = fallbackTrack
          ? {
            ...currentState,
            current: fallbackTrack,
          }
          : currentState
        if (fallbackTrack?.title && fallbackTrack.artist) {
          const deviceResult = await listSpotifyDevices(accountId)
          const deviceId =
            deviceResult.devices.find((device) => device.isActive)?.id ??
            deviceResult.devices.find((device) => device.id && !device.isRestricted)?.id ??
            null
          if (!workingState.current.uri) {
            return emptyResponse("Pick a Spotify track first.")
          }
          await playSpotify(accountId, workingState.current.uri, deviceId)
          saveMusicState({
            ...workingState,
            activeAccountId: accountId,
            playback: {
              ...workingState.playback,
              isPlaying: true,
              startedAt: playbackNow,
              positionMs: 0,
            },
          })
          return emptyResponse(`Playing ${fallbackTrack.title} by ${fallbackTrack.artist}.`)
        }
      }

      const deviceResult = await listSpotifyDevices(accountId)
      const deviceId =
        deviceResult.devices.find((device) => device.isActive)?.id ??
        deviceResult.devices.find((device) => device.id && !device.isRestricted)?.id ??
        null

      if (intent.action === "play") {
        if (!workingState.current.uri) {
          return emptyResponse("Pick a Spotify track first.")
        }
        await playSpotify(accountId, workingState.current.uri, deviceId)
        saveMusicState({
          ...workingState,
          activeAccountId: accountId,
          playback: {
            ...workingState.playback,
            isPlaying: true,
            startedAt: playbackNow,
            positionMs: 0,
          },
        })
        return emptyResponse("Playing music now.")
      }

      if (intent.action === "pause") {
        await pauseSpotify(accountId, deviceId)
        saveMusicState({
          ...workingState,
          activeAccountId: accountId,
          playback: {
            ...workingState.playback,
            isPlaying: false,
            startedAt: null,
          },
        })
        return emptyResponse("Paused music.")
      }

      if (intent.action === "next") {
        const queue = playableQueueTracks(workingState)
        const target = queueNeighborTrack(queue, workingState.current, "next")
        if (!target?.uri || queue.length < 2) {
          return emptyResponse("Browse more Spotify tracks first.")
        }
        await playSpotify(accountId, target.uri, deviceId)
        saveMusicState({
          ...workingState,
          activeAccountId: accountId,
          current: target,
          playback: {
            ...workingState.playback,
            isPlaying: true,
            startedAt: playbackNow,
            positionMs: 0,
          },
        })
        return emptyResponse("Skipped to the next track.")
      }

      const queue = playableQueueTracks(workingState)
      const target = queueNeighborTrack(queue, workingState.current, "previous")
      if (!target?.uri || queue.length < 2) {
        return emptyResponse("Browse more Spotify tracks first.")
      }
      await playSpotify(accountId, target.uri, deviceId)
      saveMusicState({
        ...workingState,
        activeAccountId: accountId,
        current: target,
        playback: {
          ...workingState.playback,
          isPlaying: true,
          startedAt: playbackNow,
          positionMs: 0,
        },
      })
      return emptyResponse("Playing the previous track.")
    } catch (err) {
      const readiness = spotifyReadinessFromError(err)
      if (readiness === "no_device") {
        return emptyResponse(spotifyReadinessMessage("no_device"))
      }
      if (readiness === "policy_blocked") {
        return emptyResponse(spotifyReadinessMessage("policy_blocked"))
      }
      if (readiness === "needs_reconnect") {
        return emptyResponse(spotifyReadinessMessage("needs_reconnect"))
      }
      return emptyResponse("Spotify playback failed.")
    }
  }

  function beginDigest(message: string) {
    setDigestPhase("received")
    setDigestStartedAt(Date.now())
    setDigestElapsedMs(0)
    setVoiceMessage(message)
  }

  function updateDigest(phase: OdinDigestPhase, message: string) {
    if (!digestStartedAt) {
      setDigestStartedAt(Date.now())
      setDigestElapsedMs(0)
    }
    setDigestPhase(phase)
    setVoiceMessage(message)
  }

  function finishDigest(phase: "ready" | "error", message: string) {
    setDigestPhase(phase)
    if (digestStartedAt) setDigestElapsedMs(Date.now() - digestStartedAt)
    setVoiceMessage(message)
  }

  useEffect(() => {
    if (!("permissions" in navigator)) return
    let mounted = true
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (!mounted) return
        setMicPermission(status.state)
        status.onchange = () => setMicPermission(status.state)
      })
      .catch(() => setMicPermission("unknown"))
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    void refreshAudioInputs()
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshAudioInputs)
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshAudioInputs)
    }
  }, [])

  useEffect(() => {
    if (!connected || !pendingMessageRef.current) return
    const message = pendingMessageRef.current
    pendingMessageRef.current = null
    window.setTimeout(() => conversation.sendUserMessage(message), 160)
  }, [connected, conversation])

  useEffect(() => {
    if (!autoStartKey || active || busy) return
    void startSession(initialCommand)
    // This effect intentionally responds only to the explicit parent start key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartKey])

  useEffect(() => {
    if (!stopKey || !active) return
    stopSession()
    // This effect intentionally responds only to the explicit parent stop key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopKey])

  useEffect(() => {
    if (!wakeOptIn) return
    if (active || busy || connected || connecting || startInFlightRef.current) return
    if (micPermission === "denied") {
      wakeShouldRunRef.current = false
      setWakeArmed(false)
      setWakeError("Mic blocked in browser settings.")
      setVoiceMessage("Mic blocked. Allow microphone access for 127.0.0.1, then retry.")
      return
    }
    if (micPermission !== "granted") {
      wakeShouldRunRef.current = false
      setWakeArmed(false)
      setWakeError(null)
      setVoiceMessage("Tap Enable wake once so ODIN can request the microphone.")
      return
    }
    void startWakeListener()
    // Wake listener functions are intentionally stable enough for this lifecycle effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, busy, connected, connecting, micPermission, wakeOptIn])

  useEffect(() => {
    if (!enableWakeKey || active || busy || connecting || startInFlightRef.current) return
    setWakeOptIn(true)
    void enableWakeDetection()
    // This effect intentionally responds only to the explicit parent enable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableWakeKey])

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      clearSilenceTimer()
      stopWakeListener()
      stopMicMonitor()
      conversation.endSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runOdinTool(command: string, source: "text" | "voice") {
    const spotifyResponse = await runSpotifyVoiceCommand(command)
    if (spotifyResponse) {
      const response = source === "voice" ? voiceSafeResponse(spotifyResponse) : spotifyResponse
      finishDigest("ready", "Spotify command executed.")
      setLatest(response)
      appendTurn("user", command)
      appendTurn("assistant", response.spokenText)
      return JSON.stringify({
        spokenText: response.spokenText,
        displayText: response.displayText,
        suggestions: response.suggestions,
      })
    }

    if (isMusicSurfaceCommand(command)) {
      navigate("/music")
      const response = source === "voice"
        ? voiceSafeResponse(emptyResponse("Opening Music controls."))
        : emptyResponse("Opening Music controls.")
      finishDigest("ready", "Music controls ready.")
      setLatest(response)
      appendTurn("user", command)
      appendTurn("assistant", response.spokenText)
      return JSON.stringify({
        spokenText: response.spokenText,
        displayText: response.displayText,
        suggestions: response.suggestions,
      })
    }

    const local = localConversationResponse(command)
    if (local) {
      const response = source === "voice" ? voiceSafeResponse(local) : local
      finishDigest("ready", "Handled locally.")
      setLatest(response)
      appendTurn("user", command)
      appendTurn("assistant", response.spokenText)
      return JSON.stringify({
        spokenText: response.spokenText,
        displayText: response.displayText,
        suggestions: response.suggestions,
      })
    }

    if (isLocalBrowserCommand(command)) {
      beginDigest("Routing browser command.")
      const browserResult = await runLocalBrowserCommand(command, { userId: user?.id })
      navigate(browserResult.route)
      const response = source === "voice"
        ? voiceSafeResponse(browserResult.response)
        : browserResult.response
      finishDigest("ready", "Browser command ready.")
      setLatest(response)
      appendTurn("user", command)
      appendTurn("assistant", response.spokenText)
      return JSON.stringify({
        spokenText: response.spokenText,
        displayText: response.displayText,
        suggestions: response.suggestions,
        ...(source === "text"
          ? {
            sourceLinks: response.sourceLinks.slice(0, 4),
            warnings: response.warnings,
            conversationState: response.conversationState,
          }
          : {}),
      })
    }

    const navigation = pageToRoute(command)
    if (navigation) {
      navigate(navigation.route)
      const response = source === "voice"
        ? voiceSafeResponse(emptyResponse(`Opening ${navigation.label}, Peter.`))
        : emptyResponse(`Opening ${navigation.label}, Peter.`)
      finishDigest("ready", `Opening ${navigation.label}.`)
      setLatest(response)
      appendTurn("user", command)
      appendTurn("assistant", response.spokenText)
      return JSON.stringify({
        spokenText: response.spokenText,
        displayText: response.displayText,
        suggestions: response.suggestions,
      })
    }

    const isFollowUp = Boolean(latestRef.current && shouldUseRecentContext(command))
    const rawMode = modeForCommand(command)
    const conversationHistory = turnHistoryPreview(turnHistoryRef.current)
    const mode = isFollowUp && rawMode === "chat" ? "chat" : rawMode
    const scanSources = scanSourcesForCommand(mode, command)
    const weatherLocation = commandNeedsWeather(command)
      ? await resolveWeatherLocationForOdin({ requestPermission: true })
      : null
    beginDigest(source === "voice" ? "Heard you. Routing to ODIN." : "Sending command to ODIN.")
    updateDigest("digesting", "ODIN is digesting live context.")
    let response: OdinCommandResponse
    try {
      response = await invokeOdinCommand({
        query: command,
        source,
        timezone: "Asia/Manila",
        mode,
        tone: toneForMode(mode),
        conversationId: conversationIdRef.current,
        turnId: crypto.randomUUID(),
        visiblePage: window.location.pathname,
        recentContext: isFollowUp ? responsePreview(latestRef.current) : undefined,
        conversationHistory: isFollowUp ? conversationHistory : undefined,
        weatherLocation: weatherLocation?.location,
        useFreshScan: scanSources?.length ? true : undefined,
        scanSources,
      })
      if (weatherLocation?.warning) {
        response = {
          ...response,
          warnings: [weatherLocation.warning, ...response.warnings],
        }
      }
      if (source === "voice") {
        response = voiceSafeResponse(response)
      }
      finishDigest("ready", source === "voice" ? "Answer ready. Speaking now." : "Answer ready.")
    } catch (err) {
      finishDigest("error", "ODIN hit a backend fault.")
      throw err
    }
    setLatest(response)
    appendTurn("user", command)
    appendTurn("assistant", response.spokenText)
    return JSON.stringify({
      spokenText: response.spokenText,
      displayText: response.displayText,
      suggestions: response.suggestions,
      ...(source === "text"
        ? {
          // Keep links on-screen only; avoid voice agent reading raw URLs out loud.
          sourceLinks: response.sourceLinks.slice(0, 4),
          drafts: response.drafts.slice(0, 3),
          warnings: response.warnings,
          conversationState: response.conversationState,
        }
        : {}),
    })
  }

  async function refreshAudioInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setAudioInputCount(0)
      return 0
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const count = devices.filter((device) => device.kind === "audioinput").length
      setAudioInputCount(count)
      return count
    } catch {
      setAudioInputCount(null)
      return null
    }
  }

  function friendlyMicrophoneError(error: unknown) {
    const name = error instanceof DOMException ? error.name : ""
    const message = error instanceof Error ? error.message : ""
    if (name === "NotFoundError" || /requested device not found/i.test(message)) {
      return window.odinDesktop?.isDesktop
        ? "ODIN Desktop cannot see a microphone. Check macOS Privacy & Security → Microphone, then allow ODIN or Electron."
        : "ODIN cannot see a microphone in this browser. Open this dashboard in Chrome or Safari, then allow microphone access for 127.0.0.1."
    }
    if (name === "NotAllowedError" || name === "SecurityError") {
      return window.odinDesktop?.isDesktop
        ? "Microphone access is blocked for ODIN Desktop. Allow ODIN or Electron in macOS Privacy & Security → Microphone."
        : "Microphone access is blocked for this browser. Allow microphone access for 127.0.0.1 in the browser's site settings, or open ODIN in Chrome or Safari."
    }
    if (name === "NotReadableError") {
      return "The microphone is already in use by another app. Close the other voice app or meeting, then start ODIN again."
    }
    if (name === "NotSupportedError" || /not supported/i.test(message)) {
      return "Microphone probing is not supported in this audio setup. Keep a default input selected in macOS Sound settings, then retry."
    }
    return message || "ODIN could not open the microphone."
  }

  async function ensureMicrophoneReady() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose microphone access. Open ODIN in Chrome or Safari for voice.")
    }
    try {
      if (window.odinDesktop?.requestMicrophoneAccess) {
        const allowed = await window.odinDesktop.requestMicrophoneAccess()
        if (!allowed) {
          throw new Error("ODIN Desktop needs macOS microphone permission before it can hear you.")
        }
      }
      // Some browsers report zero audio inputs until the user grants permission.
      // Ask first, probe access with a short-lived stream, then release before
      // ElevenLabs opens the real session. Keeping both streams can make Chrome
      // report the mic as unavailable after a few retries.
      await probeMicrophoneAccess()
      const inputCount = await refreshAudioInputs()
      if (inputCount === 0) {
        throw new Error("No microphone is visible to this browser after permission was granted. Open ODIN in Chrome or Safari for voice; text commands still work here.")
      }
    } catch (err) {
      throw new Error(friendlyMicrophoneError(err), { cause: err })
    } finally {
      stopMicMonitor()
      await waitForMicRelease()
    }
  }

  async function startSession(messageToSend?: string) {
    if (startInFlightRef.current || connected || connecting) return
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    manualStopRef.current = false
    sessionStartAtRef.current = Date.now()
    startInFlightRef.current = true
    setBusy(true)
    setError(null)
    setElevenStatus("unknown")
    let sessionReady = false
    let micReadyPromise: Promise<void> | null = null
    try {
      stopWakeListener()
      stopMicMonitor()
      await waitForMicRelease()
      setVoiceMessage("Preparing voice channel and microphone.")
      const sessionPromise = getElevenLabsSession()
      micReadyPromise = ensureMicrophoneReady()
      const session = await sessionPromise.catch((err) => {
        void micReadyPromise?.catch(() => undefined)
        throw err
      })
      if (!session.configured || !session.signedUrl) {
        setElevenStatus("error")
        void micReadyPromise.catch(() => undefined)
        throw new Error(session.error || "ElevenLabs agent is not configured.")
      }
      sessionReady = true
      setElevenStatus("ok")
      setVoiceMessage("Voice channel ready. Checking microphone.")
      await micReadyPromise
      if (messageToSend) pendingMessageRef.current = messageToSend
      setLatest(
        emptyResponse(
          messageToSend
            ? "ODIN is waking. I will answer in the voice channel."
            : "ODIN is online. Ask naturally; I will keep the thread alive."
        )
      )
      conversation.startSession({
        signedUrl: session.signedUrl,
        dynamicVariables: {
          ...session.dynamicVariables,
          visible_page: window.location.pathname,
          odin_mode: "read_and_drafts_only",
          odin_voice_prompt: ODIN_VOICE_TOOL_ENFORCEMENT_PROMPT,
        },
      })
      setVoiceMessage(messageToSend ? "ODIN is connecting to answer." : "ODIN is connecting.")
    } catch (err) {
      startInFlightRef.current = false
      stopMicMonitor()
      conversation.endSession()
      const message = friendlyMicrophoneError(err)
      setError(message)
      setVoiceMessage(
        sessionReady
          ? "ElevenLabs is ready; microphone permission is blocked."
          : "Voice core needs attention; text command still works."
      )
    } finally {
      setBusy(false)
    }
  }

  function stopSession() {
    manualStopRef.current = true
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    startInFlightRef.current = false
    pendingMessageRef.current = null
    clearSilenceTimer()
    userSpeechActiveRef.current = false
    turnPendingRef.current = false
    setDigestPhase("idle")
    setDigestStartedAt(null)
    setDigestElapsedMs(0)
    stopMicMonitor()
    conversation.endSession()
    setVoiceMessage("Standing down.")
  }

  function resetVoiceActivity() {
    clearSilenceTimer()
    userSpeechActiveRef.current = false
    turnPendingRef.current = false
    smoothedMicLevelRef.current = 0
    voiceHoldUntilRef.current = 0
    lastVadSignalRef.current = 0
    voiceDetectedRef.current = false
    setDigestPhase("idle")
    setDigestStartedAt(null)
    setDigestElapsedMs(0)
    setMicLevel(0)
    setMicLive(false)
    setVoiceDetected(false)
  }

  function markVoiceDetected(holdMs = 1500) {
    voiceHoldUntilRef.current = Math.max(
      voiceHoldUntilRef.current,
      performance.now() + holdMs
    )
    if (!voiceDetectedRef.current) {
      voiceDetectedRef.current = true
      setVoiceDetected(true)
    }
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current === null) return
    window.clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = null
  }

  function scheduleSpeechFinalization() {
    clearSilenceTimer()
    silenceTimerRef.current = window.setTimeout(() => {
      silenceTimerRef.current = null
      if (!connected || speaking) return
      if (!userSpeechActiveRef.current) return
      const quietFor = performance.now() - lastVadSignalRef.current
      if (quietFor < 950) {
        scheduleSpeechFinalization()
        return
      }
      userSpeechActiveRef.current = false
      voiceDetectedRef.current = false
      setVoiceDetected(false)
      setVoiceMessage("Audio detected. Waiting for words to land.")
      setVoicePulseKey((value) => value + 1)
    }, 1050)
  }

  async function probeMicrophoneAccess() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose microphone access. Open ODIN in Chrome or Safari for voice.")
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    stream.getTracks().forEach((track) => track.stop())
  }

  function stopMicMonitor() {
    const monitor = micMonitorRef.current
    if (!monitor) return
    window.cancelAnimationFrame(monitor.frame)
    monitor.stream.getTracks().forEach((track) => track.stop())
    void monitor.context.close().catch(() => undefined)
    micMonitorRef.current = null
    setMicLive(false)
    resetVoiceActivity()
  }

  function clearWakeRestartTimer() {
    if (wakeRestartTimerRef.current === null) return
    window.clearTimeout(wakeRestartTimerRef.current)
    wakeRestartTimerRef.current = null
  }

  async function enableWakeDetection() {
    setWakeError(null)
    if (!speechRecognitionConstructor()) {
      setWakeSupported(false)
      setWakeError("Wake detection is not supported in this browser.")
      setVoiceMessage("This browser cannot run hands-free wake detection.")
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setWakeError("Microphone access is not available in this browser.")
      setVoiceMessage("Open ODIN in Chrome or Safari to use wake detection.")
      return
    }

    try {
      if (window.odinDesktop?.requestMicrophoneAccess) {
        const allowed = await window.odinDesktop.requestMicrophoneAccess()
        if (!allowed) throw new Error("Mic blocked in macOS settings.")
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      stream.getTracks().forEach((track) => track.stop())
      setMicPermission("granted")
      await refreshAudioInputs()
      setVoiceMessage("Wake listener armed. Say “Hey ODIN” or “ODIN wake up.”")
      await startWakeListener()
    } catch (err) {
      const message = friendlyMicrophoneError(err)
      setMicPermission("denied")
      setWakeArmed(false)
      setWakeError("Mic blocked in browser settings.")
      setVoiceMessage(message)
    }
  }

  async function startWakeListener() {
    if (wakeRecognitionRef.current || activeStateRef.current.active || activeStateRef.current.busy) {
      return
    }

    const Recognition = speechRecognitionConstructor()
    if (!Recognition) {
      wakeShouldRunRef.current = false
      setWakeSupported(false)
      setWakeArmed(false)
      setWakeError("Wake word detection is not supported in this browser.")
      return
    }

    setWakeSupported(true)
    setWakeError(null)
    wakeShouldRunRef.current = true
    clearWakeRestartTimer()

    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = "en-US"
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setWakeArmed(true)
      setWakeError(null)
      setVoiceMessage("Wake listener armed. Say “Hey ODIN” or “ODIN wake up.”")
    }

    recognition.onresult = (event) => {
      let heard = ""
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcriptText = result?.[0]?.transcript
        if (transcriptText) heard = `${heard} ${transcriptText}`
      }
      const cleaned = heard.replace(/\s+/g, " ").trim()
      if (!cleaned) return
      setWakeTranscript(compactTurnText(cleaned, 140))

      const command = commandAfterWakePhrase(cleaned)
      if (command === null) return

      wakeShouldRunRef.current = false
      clearWakeRestartTimer()
      setWakeArmed(false)
      setWakeLastHeardAt(new Date().toISOString())
      setWakeTranscript(compactTurnText(cleaned, 140))
      setVoiceMessage("Wake word heard. Opening ODIN voice.")
      try {
        recognition.stop()
      } catch {
        // The browser may already have ended the speech recognizer.
      }
      void startSession(command || undefined)
    }

    recognition.onerror = (event) => {
      const reason = event.error ?? event.message ?? "wake listener error"
      if (reason === "no-speech" || reason === "aborted") return
      if (reason === "not-allowed" || reason === "service-not-allowed") {
        wakeShouldRunRef.current = false
        setMicPermission("denied")
        setWakeArmed(false)
        setWakeError("Mic blocked in browser settings.")
        setVoiceMessage("Mic blocked. Allow microphone access for 127.0.0.1, then retry.")
        return
      }
      setWakeError(`Wake listener paused: ${reason}.`)
    }

    recognition.onend = () => {
      wakeRecognitionRef.current = null
      const state = activeStateRef.current
      if (!wakeShouldRunRef.current || state.active || state.busy || state.connecting) {
        setWakeArmed(false)
        return
      }
      // Keep the indicator steady while Chrome cycles the speech recognizer.
      setWakeArmed(true)
      wakeRestartTimerRef.current = window.setTimeout(() => {
        wakeRestartTimerRef.current = null
        void startWakeListener()
      }, 650)
    }

    try {
      wakeRecognitionRef.current = recognition
      recognition.start()
      setWakeArmed(true)
      setWakeError(null)
      setVoiceMessage("Wake listener armed. Say “Hey ODIN” or “ODIN wake up.”")
    } catch (err) {
      wakeRecognitionRef.current = null
      wakeShouldRunRef.current = false
      setWakeArmed(false)
      setWakeError(err instanceof Error ? err.message : "Wake listener could not start.")
    }
  }

  function handleEyePress() {
    if (active) {
      stopSession()
      return
    }
    void startSession()
  }

  function stopWakeListener() {
    wakeShouldRunRef.current = false
    clearWakeRestartTimer()
    const recognition = wakeRecognitionRef.current
    wakeRecognitionRef.current = null
    setWakeArmed(false)
    if (recognition) {
      recognition.onend = null
      recognition.onerror = null
      recognition.onresult = null
      recognition.onstart = null
      try {
        recognition.stop()
      } catch {
        try {
          recognition.abort()
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
  }

  async function handleTextSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const command = query.trim()
    if (!command) return
    setQuery("")
    setBusy(true)
    setError(null)
    try {
      const raw = await runOdinTool(command, "text")
      const parsed = JSON.parse(raw) as Pick<OdinCommandResponse, "spokenText" | "displayText" | "suggestions">
      setVoiceMessage(parsed.spokenText)
    } catch (err) {
      const message = err instanceof Error ? err.message : "ODIN could not complete the command."
      setError(message)
      setLatest(emptyResponse(message))
    } finally {
      setBusy(false)
    }
  }

  const wakeMicBlocked = /blocked|not allowed|permission/i.test(wakeError ?? "")
  const hasVoiceBlock = Boolean(error || wakeMicBlocked)
  const statusText = connecting
    ? "connecting"
    : speaking
      ? "speaking"
      : listening
        ? "listening"
        : connected
          ? "online"
          : wakeArmed
            ? "wake armed"
          : "standby"
  const visualState = connecting || busy
    ? "thinking"
    : speaking
      ? "speaking"
      : listening
        ? "listening"
        : wakeArmed
          ? "wake"
          : connected
            ? "online"
          : "idle"

  const listenerPhase: ListenerPhase = hasVoiceBlock
    ? "blocked"
    : connecting || busy
      ? "connecting"
      : speaking
        ? "speaking"
        : listening || connected || voiceDetected
          ? "listening"
          : wakeArmed
            ? "wake"
            : "idle"

  const inputState: OdinVoiceSurfaceState["inputState"] = hasVoiceBlock
    ? "blocked"
    : speaking
      ? "speaking"
      : turnPendingRef.current || /thinking/i.test(voiceMessage)
        ? "thinking"
        : transcript
          ? "captured"
          : voiceDetected || userSpeechActiveRef.current
            ? "hearing"
            : wakeArmed
              ? "wake"
              : "standby"
  const digestActive = digestPhase !== "idle" || turnPendingRef.current || busy
  const handoffSnapshotRef = useRef("")

  useEffect(() => {
    const surfaceState: OdinVoiceSurfaceState = {
      active,
      status: hasVoiceBlock ? "error" : visualState,
      message: voiceMessage,
      latest,
      error,
      micLevel,
      micLive,
      voiceDetected,
      listenerPhase,
      digestPhase,
      digestElapsedMs,
      transcript,
      wakeArmed,
      wakeSupported,
      wakeTranscript,
      wakeLastHeardAt,
      wakeError,
      inputState,
    }
    onStateChange?.(surfaceState)

    const handoffPayload = {
      source: "voice-console" as const,
      updatedAt: Date.now(),
      voice: {
        active: surfaceState.active,
        status: surfaceState.status,
        message: surfaceState.message,
        error: surfaceState.error,
        micLive: surfaceState.micLive,
        voiceDetected: surfaceState.voiceDetected,
        listenerPhase: surfaceState.listenerPhase,
        transcript: surfaceState.transcript,
        wakeArmed: surfaceState.wakeArmed,
        wakeSupported: surfaceState.wakeSupported,
        wakeTranscript: surfaceState.wakeTranscript,
        wakeLastHeardAt: surfaceState.wakeLastHeardAt,
        wakeError: surfaceState.wakeError,
        inputState: surfaceState.inputState,
        digestPhase: surfaceState.digestPhase,
        digestElapsedMs: surfaceState.digestElapsedMs,
      },
      latest: surfaceState.latest,
    }
    const signature = JSON.stringify({
      ...handoffPayload,
      updatedAt: 0,
      voice: {
        ...handoffPayload.voice,
        digestElapsedMs: 0,
      },
    })
    if (signature !== handoffSnapshotRef.current) {
      handoffSnapshotRef.current = signature
      saveOdinSurfaceHandoff(handoffPayload)
    }
  }, [
    active,
    digestElapsedMs,
    digestPhase,
    error,
    hasVoiceBlock,
    latest,
    listenerPhase,
    micLevel,
    micLive,
    onStateChange,
    inputState,
    visualState,
    voiceDetected,
    voiceMessage,
    transcript,
    wakeArmed,
    wakeError,
    wakeLastHeardAt,
    wakeSupported,
    wakeTranscript,
  ])

  if (variant === "controller") {
    return (
      <div className="sr-only" aria-live="polite">
        {voiceMessage}
      </div>
    )
  }

  return (
    <section className="overflow-hidden rounded-md border border-border-accent bg-surface/70">
      <div className="relative min-h-[720px] border-b border-border/60 bg-[linear-gradient(rgba(213,176,91,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(111,160,220,0.04)_1px,transparent_1px)] bg-[size:72px_72px] px-8 py-8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_43%_45%,rgba(111,160,220,0.18),transparent_36%),radial-gradient(circle_at_78%_18%,rgba(213,176,91,0.10),transparent_28%)]" />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-5 top-5 z-20 inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/70 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground transition hover:border-gold/50 hover:text-gold"
            aria-label="Close voice interface"
          >
            <X size={14} />
            Close voice
          </button>
        )}
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="label-track text-gold">VOICE ORCHESTRATOR</div>
            <h2 className="mt-3 font-display text-3xl tracking-[0.14em] text-foreground">
              ODIN INTERFACE
            </h2>
            <p className="mt-4 max-w-4xl text-base leading-relaxed text-muted-foreground">
              Say “Odin” from the open dashboard, or press the Eye to start a
              persistent voice session. ODIN can converse, scan live sources,
              research/process information, and keep context between turns.
            </p>
          </div>
          <div className="rounded-full border border-gold/40 bg-gold/10 px-5 py-3 text-sm font-semibold text-gold">
            <span className="inline-flex items-center gap-2">
              <Shield size={16} />
              Read + drafts only
            </span>
          </div>
        </div>

        <div className="relative z-10 mt-16 grid gap-10 xl:grid-cols-[1fr_520px]">
          <div className="flex min-h-[430px] flex-col items-center justify-center text-center">
            <button
              type="button"
              onClick={handleEyePress}
              disabled={busy}
              className={[
                "odin-voice-core",
                `odin-voice-core--${visualState}`,
                "relative grid h-80 w-80 place-items-center rounded-full border transition duration-300",
                active
                  ? "border-gold/50 bg-gold/[0.04] shadow-[0_0_80px_rgba(213,176,91,0.2)]"
                  : "border-frost/20 bg-background/25 hover:border-gold/40",
              ].join(" ")}
              aria-label={active ? "Stop ODIN voice" : "Start ODIN voice"}
            >
              <span className="odin-voice-core__ring odin-voice-core__ring--outer" />
              <span className="odin-voice-core__ring odin-voice-core__ring--middle" />
              <span className="odin-voice-core__ring odin-voice-core__ring--inner" />
              <span key={voicePulseKey} className="odin-voice-core__input-pulse" />
              <span
                className={[
                  "absolute inset-24 rounded-full blur-2xl transition",
                  speaking
                    ? "bg-gold/30"
                    : listening || wakeArmed
                      ? "bg-frost/25"
                      : "bg-muted/15",
                ].join(" ")}
              />
              <span className="odin-voice-core__bars" aria-hidden="true">
                {Array.from({ length: 11 }).map((_, index) => (
                  <span key={index} style={{ ["--bar" as string]: index }} />
                ))}
              </span>
              <span className="relative grid h-32 w-32 place-items-center rounded-full border border-border bg-background text-gold">
                {busy || connecting ? (
                  <Loader2 size={42} className="animate-spin" />
                ) : active ? (
                  <Volume2 size={44} />
                ) : (
                  <Mic size={44} />
                )}
              </span>
            </button>

            <h3 className="mt-8 font-display text-3xl tracking-[0.08em] text-foreground">
              {latest?.spokenText ?? "ODIN IS STANDING BY."}
            </h3>
            <p className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {voiceMessage}
            </p>
          </div>

          <div className="min-w-0 self-center rounded-md border border-border bg-background/55 p-5">
            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-foreground">
                  Voice channel
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Persistent ElevenLabs session using the Odin voice. The browser
                  wake listener only detects “Odin”; the agent handles conversation.
                </p>
              </div>
              <button
                type="button"
                onClick={active ? stopSession : () => void startSession()}
                disabled={busy}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-gold/40 bg-gold/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold transition hover:bg-gold/15"
              >
                {active ? <Power size={14} /> : <Mic size={14} />}
                {active ? "Stop" : "Start voice"}
              </button>
            </div>

            <div className="mt-5 rounded-md border border-border bg-surface/60 p-4">
              <div className="flex items-center gap-3">
                <Mic size={18} className={active ? "text-gold" : "text-tertiary"} />
                <div>
                  <div className="font-semibold text-foreground">
                    ODIN voice {statusText}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {elevenStatus === "ok" && !active
                      ? "ElevenLabs is ready. The remaining blocker is microphone access."
                      : micPermission === "denied"
                      ? "Voice is blocked. Type below, or allow microphone access and retry."
                      : micPermission === "prompt" || micPermission === "unknown"
                        ? "Tap Enable wake once to request microphone access."
                        : audioInputCount === 0
                          ? "No microphone input is visible after permission."
                          : wakeArmed
                            ? "Wake detection is listening for Odin."
                            : "Ask a brief, scan, research task, or page navigation."}
                  </div>
                </div>
              </div>
              <div className="mt-4 grid gap-2 rounded-md border border-border/70 bg-background/45 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-tertiary">
                    Input path
                  </span>
                  <span className="rounded-full border border-gold/30 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-gold">
                    {inputState === "wake"
                      ? "wake ready"
                      : inputState === "hearing"
                        ? "hearing"
                        : inputState === "captured"
                          ? "words captured"
                          : inputState === "thinking"
                            ? "sent to ODIN"
                            : inputState === "speaking"
                              ? "replying"
                              : inputState === "blocked"
                                ? "blocked"
                                : "standby"}
                  </span>
                </div>
                <div className="grid gap-2 text-xs leading-relaxed text-muted-foreground">
                  <p>
                    {wakeSupported
                      ? wakeArmed
                        ? "Wake listener is on. Say “Hey ODIN” or “ODIN wake up.”"
                        : wakeLastHeardAt
                          ? `Wake word heard ${new Date(wakeLastHeardAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
                          : "Tap Enable wake once; after that ODIN can listen for “Hey ODIN.”"
                      : "This browser does not support hands-free wake detection."}
                  </p>
                  {(transcript || wakeTranscript || wakeError) && (
                    <p className="rounded border border-border/70 bg-surface/70 px-3 py-2">
                      <strong className="text-foreground">
                        {transcript ? "Last words: " : wakeTranscript ? "Wake heard: " : "Wake status: "}
                      </strong>
                      {transcript || wakeTranscript || wakeError}
                    </p>
                  )}
                </div>
              </div>
              {digestActive && (
                <div className="mt-4 rounded-md border border-gold/30 bg-gold/10 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-gold">
                      <span
                        className={[
                          "h-2 w-2 rounded-full",
                          digestPhase === "error"
                            ? "bg-destructive"
                            : digestPhase === "ready"
                              ? "bg-emerald-400"
                              : "animate-pulse bg-gold shadow-[0_0_12px_rgba(227,176,79,0.7)]",
                        ].join(" ")}
                      />
                      ODIN digest
                    </span>
                    <span className="font-mono-data text-[10px] uppercase tracking-[0.14em] text-gold/80">
                      {digestPhaseLabel(digestPhase)} · {formatDigestElapsed(digestElapsedMs)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {digestPhase === "received"
                      ? "Your words landed. ODIN is routing the request."
                      : digestPhase === "routing"
                        ? "Classifying intent and source needs."
                        : digestPhase === "digesting"
                          ? "Reading live context, memory, and source summaries."
                          : digestPhase === "ready"
                            ? "Answer prepared for voice or text playback."
                            : digestPhase === "error"
                              ? "Backend fault detected. Text fallback remains available."
                              : turnPendingRef.current
                                ? "Waiting for ElevenLabs to hand ODIN the full turn."
                                : "Standing by."}
                  </p>
                </div>
              )}
              {(active || wakeArmed || transcript) && (
                <div className="odin-voice-meter mt-4" data-state={visualState}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-tertiary">
                      {listening || wakeArmed
                        ? "Hearing input"
                        : speaking
                          ? "Voice output"
                          : connected
                            ? "Channel open"
                            : "Signal"}
                    </span>
                    <span className="h-2 w-2 rounded-full bg-gold shadow-[0_0_12px_rgba(227,176,79,0.7)]" />
                  </div>
                  <div className="mt-3 flex h-10 items-center gap-1.5" aria-hidden="true">
                    {Array.from({ length: 18 }).map((_, index) => (
                      <span key={index} style={{ ["--bar" as string]: index }} />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive">
                <div className="font-semibold">Voice needs permission.</div>
                {elevenStatus === "ok" && (
                  <div className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-300">
                    ElevenLabs API connected
                  </div>
                )}
                {/chrome|safari|microphone/i.test(error) && (
                  <>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => textInputRef.current?.focus()}
                        className="rounded-md border border-destructive/40 px-3 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-destructive transition hover:bg-destructive/10"
                      >
                        Use text command
                      </button>
                      <button
                        type="button"
                        onClick={() => void startSession()}
                        disabled={busy}
                        className="rounded-md border border-destructive/40 px-3 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                      >
                        Retry voice
                      </button>
                    </div>
                  </>
                )}
                <p className="mt-3 leading-relaxed">{error}</p>
                <div className="mt-4 rounded-md border border-destructive/30 bg-background/50 p-3 text-xs leading-relaxed text-destructive/90">
                  <div className="font-semibold uppercase tracking-[0.12em]">
                    Fast fix
                  </div>
                  <ol className="mt-2 list-decimal space-y-1 pl-4">
                    <li>Open ODIN in Chrome or Safari.</li>
                    <li>Allow microphone access for 127.0.0.1.</li>
                    <li>If it still fails, enable the browser in macOS Privacy & Security → Microphone.</li>
                  </ol>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <a
                    href={currentDashboardUrl()}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-destructive transition hover:bg-destructive/10"
                  >
                    <ExternalLink size={14} />
                    Open tab
                  </a>
                  <button
                    type="button"
                    onClick={() => void copyDashboardUrl()}
                    className="rounded-md border border-destructive/40 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-destructive transition hover:bg-destructive/10"
                  >
                    Copy URL
                  </button>
                </div>
              </div>
            )}

            <form
              onSubmit={handleTextSubmit}
              className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <label className="sr-only" htmlFor="odin-command">
                Ask ODIN
              </label>
              <input
                id="odin-command"
                ref={textInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Type to ODIN..."
                className="h-14 min-w-0 rounded-md border border-border bg-background px-4 text-sm text-foreground outline-none transition placeholder:text-tertiary focus:border-gold/60"
              />
              <button
                type="submit"
                disabled={busy || !query.trim()}
                className="inline-flex h-14 items-center justify-center gap-2 rounded-md border border-gold/40 bg-gold/10 px-5 text-sm font-semibold text-gold transition hover:bg-gold/15 disabled:opacity-50"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Ask
              </button>
            </form>
          </div>
        </div>
      </div>

      <div className="bg-surface px-6 py-6">
        <div className="label-track text-gold">RESPONSE CONSOLE</div>
        {!latest ? (
          <p className="mt-3 rounded-md border border-border bg-background/60 px-4 py-4 text-sm text-muted-foreground">
            Ask for a central brief, Slack scan, Gmail triage, Calendar view,
            vitals, or research task. ODIN will speak the summary and put the
            useful detail here.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground">
                What ODIN returned
              </h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {latest.displayText}
              </p>
            </div>

            {latest.signals.length > 0 && (
              <div className="grid gap-3 md:grid-cols-2">
                {latest.signals.slice(0, 4).map((signal) => (
                  <div
                    key={signal.id}
                    className="rounded-md border border-border bg-background/60 p-4"
                  >
                    <div className="label-track text-gold">
                      {signal.source} · {signal.category}
                    </div>
                    <h4 className="mt-2 font-semibold text-foreground">
                      {signal.title}
                    </h4>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {signal.summary}
                    </p>
                    {signal.nextAction && (
                      <p className="mt-3 text-sm font-semibold text-gold">
                        {signal.nextAction}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {latest.sourceLinks.length > 0 && (
              <div>
                <div className="label-track text-tertiary">Source links</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {latest.sourceLinks.slice(0, 8).map((link) => (
                    <a
                      key={`${link.source}-${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-full border border-frost/30 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-frost transition hover:bg-frost/10"
                    >
                      <ExternalLink size={13} />
                      {link.label}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {latest.drafts.length > 0 && (
              <div>
                <div className="label-track text-tertiary">Drafts</div>
                <div className="mt-2 space-y-2">
                  {latest.drafts.slice(0, 3).map((draft) => (
                    <div
                      key={`${draft.target}-${draft.text}`}
                      className="rounded-md border border-gold/25 bg-gold/[0.05] px-4 py-3 text-sm text-gold"
                    >
                      <strong>{draft.target}:</strong> {draft.text}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {latest.suggestions.length > 0 && (
              <div>
                <div className="label-track text-tertiary">Ask next</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {latest.suggestions.slice(0, 3).map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setQuery(suggestion)}
                      className="rounded-full border border-border bg-background/70 px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:border-gold/40 hover:text-gold"
                    >
                      <Zap size={12} className="mr-1 inline" />
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {latest.warnings.length > 0 && (
              <div className="rounded-md border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-gold">
                {latest.warnings.join(" ")}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

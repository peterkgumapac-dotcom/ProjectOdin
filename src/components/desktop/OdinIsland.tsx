import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import {
  Activity,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  HeartPulse,
  Loader2,
  ListChecks,
  Mic2,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
  Zap,
} from "lucide-react"
import { useAuth } from "@/hooks/useAuth"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import { useOdinResponsibility } from "@/hooks/useOdinResponsibility"
import { useWithingsHealth } from "@/hooks/useWithingsHealth"
import {
  useOdinMusicController,
  type MusicState,
  type MusicTrack,
} from "@/lib/musicState"
import {
  currentPlayback,
  searchSpotify,
  listSpotifyDevices,
  pauseSpotify,
  playSpotify,
  nextSpotify,
  previousSpotify,
} from "@/lib/connectors/spotify"
import {
  spotifyReadinessFromError,
  spotifyReadinessMessage,
} from "@/lib/spotifyReadiness"
import {
  loadOdinSurfaceHandoff,
  saveOdinSurfaceHandoff,
  useOdinSurfaceHandoff,
  type OdinSharedVoiceState,
} from "@/lib/odinSurfaceState"
import { rangeEvents, type CalendarEvent } from "@/lib/connectors/calendar"
import type { WithingsHealthSummary } from "@/lib/connectors/withings"
import type { OdinPendingItem } from "@/lib/odinResponsibility"
import { ConnectionStatusChip } from "@/components/shared/ConnectionStatusChip"

type IslandScenario =
  | "live"
  | "collapsed"
  | "expanded"
  | "voice"
  | "blocked"
  | "ops"
  | "health"
  | "music"

type VoiceState = "idle" | "listening" | "thinking" | "responding" | "blocked"
type CompactMode = "idle" | "music" | "priority" | "calendar" | "health"
type IslandSizeMode = CompactMode | "tray"
type ActiveTrayModule = "music" | "calendar" | "priorities" | "health" | "quick"
type PathKey = "downloads" | "screenshots" | "documents" | "recent"

interface OdinIslandProps {
  scenario?: IslandScenario
  overlay?: boolean
}

interface IslandBridge {
  openRoute?: (route: string) => unknown
  openPath?: (pathKey: PathKey) => unknown
  requestMicrophoneAccess?: () => Promise<boolean>
  microphoneStatus?: () => Promise<string>
  island?: {
    show?: () => unknown
    hide?: () => unknown
    toggle?: () => unknown
    expand?: () => unknown
    collapse?: () => unknown
    resize?: (size: { mode: IslandSizeMode; width: number; height: number }) => unknown
  }
  voice?: {
    start?: () => unknown
    stop?: () => unknown
  }
}

interface CalendarSnapshot {
  events: CalendarEvent[]
  loading: boolean
  error: string | null
  checkedAt: string | null
}

const SCENARIO_LABELS: Array<{ id: IslandScenario; label: string }> = [
  { id: "live", label: "Live" },
  { id: "collapsed", label: "Collapsed" },
  { id: "expanded", label: "Expanded" },
  { id: "voice", label: "Voice" },
  { id: "blocked", label: "Blocked" },
  { id: "ops", label: "Ops" },
  { id: "health", label: "Health" },
  { id: "music", label: "Music" },
]

const ISLAND_SIZES: Record<IslandSizeMode, { width: number; height: number }> = {
  idle: { width: 44, height: 44 },
  calendar: { width: 44, height: 44 },
  priority: { width: 44, height: 44 },
  health: { width: 44, height: 44 },
  music: { width: 44, height: 44 },
  tray: { width: 1200, height: 280 },
}

function desktopBridge(): IslandBridge | undefined {
  return window.odinDesktop as unknown as IslandBridge | undefined
}

function compactNumber(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--"
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`
  return value.toLocaleString()
}

function formatSleep(minutes?: number | null): string {
  if (typeof minutes !== "number") return "--"
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function relativeTime(value?: string | null): string {
  if (!value) return "not synced"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "not synced"
  const minutes = Math.max(1, Math.round((Date.now() - date.getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function timeUntil(date: Date | null): string {
  if (!date) return "today"
  const diff = date.getTime() - Date.now()
  const absoluteMinutes = Math.max(1, Math.round(Math.abs(diff) / 60_000))
  const suffix = diff >= 0 ? "in " : ""
  const trail = diff >= 0 ? "" : " ago"
  if (absoluteMinutes < 60) return `${suffix}${absoluteMinutes}m${trail}`
  const hours = Math.round(absoluteMinutes / 60)
  if (hours < 24) return `${suffix}${hours}h${trail}`
  return `${suffix}${Math.round(hours / 24)}d${trail}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function cleanText(value?: string | null, max = 84): string {
  const text = value?.replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

function eventStart(event?: CalendarEvent | null): Date | null {
  if (!event) return null
  const raw = event.start?.dateTime || event.start?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function eventTimeLabel(event?: CalendarEvent | null): string {
  const start = eventStart(event)
  if (!start) return "Today"
  if (event?.start?.date && !event.start.dateTime) return "All day"
  return start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function readinessScore(summary: WithingsHealthSummary | null): number {
  if (!summary) return 0
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

function topHealthMove(summary: WithingsHealthSummary | null): string {
  if (!summary) return "Read stats"
  const sleep = summary.sleep.durationMinutes
  const heart = summary.heartRate.bpm
  const score = readinessScore(summary)
  if ((typeof sleep === "number" && sleep < 390) || score < 55) return "Recovery low"
  if (typeof heart === "number" && heart >= 88) return "Mobility only"
  if (score >= 72) return "Strength window"
  return "Steps and protein"
}

function hasHealthAnomaly(summary: WithingsHealthSummary | null): boolean {
  if (!summary) return false
  const bpm = summary.heartRate.bpm
  const sleepMinutes = summary.sleep.durationMinutes
  if (typeof bpm === "number" && (bpm >= 92 || bpm <= 48)) return true
  if (typeof sleepMinutes === "number" && sleepMinutes < 360) return true
  return readinessScore(summary) < 55
}

function pendingRank(item: OdinPendingItem): number {
  const urgencyRank = { critical: 4, high: 3, medium: 2, low: 1 }[item.urgency]
  const bucketRank =
    item.bucket === "needs_peter"
      ? 4
      : item.bucket === "today"
        ? 3
        : item.bucket === "waiting_on_others"
          ? 2
          : 1
  return urgencyRank * 10 + bucketRank
}

function dueAt(item: OdinPendingItem): Date | null {
  const record = item as unknown as Record<string, unknown>
  const raw = record.dueAt || record.due_at || record.deadline || record.followUpAt
  if (typeof raw !== "string") return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function voiceCopy(state: VoiceState) {
  if (state === "listening") {
    return { title: "ODIN listening", detail: "Tell me what you need.", action: "Stop" }
  }
  if (state === "thinking") {
    return { title: "ODIN thinking", detail: "Reading the latest context.", action: "Open" }
  }
  if (state === "responding") {
    return { title: "ODIN responding", detail: "Answer is being spoken.", action: "Open" }
  }
  if (state === "blocked") {
    return { title: "Voice blocked", detail: "Mic permission is not granted.", action: "Enable" }
  }
  return { title: "ODIN ready", detail: "Ready for command.", action: "Talk" }
}

function sharedVoiceMode(state: OdinSharedVoiceState): VoiceState {
  if (state.inputState === "blocked" || state.status === "error" || state.listenerPhase === "blocked") return "blocked"
  if (state.listenerPhase === "speaking" || state.inputState === "speaking" || state.status === "speaking") return "responding"
  if (state.listenerPhase === "connecting" || state.inputState === "thinking" || state.status === "thinking" || state.status === "connecting") return "thinking"
  if (
    state.active ||
    state.listenerPhase === "listening" ||
    state.inputState === "hearing" ||
    state.inputState === "captured" ||
    state.status === "listening" ||
    state.status === "online" ||
    state.status === "wake"
  ) {
    return "listening"
  }
  return "idle"
}

function islandVoiceToShared(state: VoiceState): OdinSharedVoiceState {
  const copy = voiceCopy(state)
  if (state === "blocked") {
    return {
      active: false,
      status: "error",
      message: copy.detail,
      error: copy.detail,
      micLive: false,
      voiceDetected: false,
      listenerPhase: "blocked",
      transcript: "",
      wakeArmed: false,
      wakeSupported: true,
      wakeTranscript: "",
      wakeLastHeardAt: null,
      wakeError: copy.detail,
      inputState: "blocked",
      digestPhase: "idle",
      digestElapsedMs: 0,
    }
  }
  if (state === "listening") {
    return {
      active: true,
      status: "listening",
      message: copy.detail,
      error: null,
      micLive: true,
      voiceDetected: true,
      listenerPhase: "listening",
      transcript: "",
      wakeArmed: true,
      wakeSupported: true,
      wakeTranscript: "",
      wakeLastHeardAt: null,
      wakeError: null,
      inputState: "hearing",
      digestPhase: "idle",
      digestElapsedMs: 0,
    }
  }
  return {
    active: false,
    status: "idle",
    message: copy.detail,
    error: null,
    micLive: false,
    voiceDetected: false,
    listenerPhase: "idle",
    transcript: "",
    wakeArmed: false,
    wakeSupported: true,
    wakeTranscript: "",
    wakeLastHeardAt: null,
    wakeError: null,
    inputState: "standby",
    digestPhase: "idle",
    digestElapsedMs: 0,
  }
}

function hueFromSeed(seed: string): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash) % 360
}

function albumGlowShadow(seed: string): string {
  const hue = hueFromSeed(seed)
  return `0 0 22px hsla(${hue} 78% 58% / 0.42), 0 0 46px hsla(${hue} 82% 62% / 0.22)`
}

function formatTimeLabel(valueMs: number | null | undefined): string {
  const safe = typeof valueMs === "number" && Number.isFinite(valueMs)
    ? Math.max(0, Math.round(valueMs))
    : 0
  const totalSeconds = Math.floor(safe / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function routeWithDesktop(route: string, navigate: ReturnType<typeof useNavigate>) {
  const desktop = desktopBridge()
  if (desktop?.openRoute) {
    void desktop.openRoute(route)
    return
  }
  navigate(route)
}

function openPath(pathKey: PathKey) {
  void desktopBridge()?.openPath?.(pathKey)
}

function nextTrack(state: MusicState, direction: 1 | -1): MusicState {
  const queue = state.queue.length > 0 ? state.queue : state.playlistTracks
  if (queue.length === 0) return state
  const currentIndex = queue.findIndex((track) =>
    (track.uri && track.uri === state.current.uri) ||
    (track.url && track.url === state.current.url) ||
    (track.title === state.current.title && track.artist === state.current.artist)
  )
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + queue.length) % queue.length
  return {
    ...state,
    current: queue[nextIndex],
    playback: {
      isPlaying: state.playback.isPlaying,
      startedAt: state.playback.isPlaying ? Date.now() : null,
      positionMs: 0,
    },
  }
}

function playableQueueTracks(state: MusicState): MusicTrack[] {
  const seen = new Set<string>()
  return [state.current, ...state.queue, ...state.playlistTracks].filter((track) => {
    const uri = track.uri ?? ""
    if (!uri) return false
    if (seen.has(uri)) return false
    seen.add(uri)
    return true
  })
}

function IslandOrb({ size = 42 }: { size?: number }) {
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-full border border-white/15"
      style={{
        width: size,
        height: size,
        animation: "odin-island-orb-breathe 2.8s ease-in-out infinite",
        background:
          "radial-gradient(circle at 35% 24%, rgba(255,248,230,0.96) 0 8%, transparent 13%), radial-gradient(circle at 58% 56%, #160d08 0 31%, #8c4b12 50%, #d18425 67%, #f2c283 100%)",
        boxShadow: "inset 0 0 16px rgba(255,246,220,0.16), 0 0 24px rgba(205,118,33,0.28)",
      }}
    >
      <span className="absolute inset-x-2 top-1/2 h-px bg-white/28" />
      <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/55" />
    </div>
  )
}

function VoiceDots({ state }: { state: VoiceState }) {
  const active = state === "listening" || state === "thinking" || state === "responding"
  return (
    <div className="flex h-4 items-center gap-[4px]" aria-hidden="true">
      {Array.from({ length: 7 }, (_, index) => (
        <span
          key={index}
          className="block w-[4px] rounded-full bg-[#d8902f]"
          style={{
            height: `${active ? 5 + ((index * 5) % 12) : 4}px`,
            opacity: active ? 0.92 : 0.42,
            animation: active ? `odin-island-wave ${620 + (index % 4) * 80}ms ease-in-out infinite` : undefined,
            animationDelay: `${index * 54}ms`,
          }}
        />
      ))}
    </div>
  )
}

function AlbumArt({ imageUrl, connected, playing, size = 56 }: { imageUrl?: string | null; connected: boolean; playing: boolean; size?: number }) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(imageUrl ?? null)
  const [lastGoodUrl, setLastGoodUrl] = useState<string | null>(imageUrl ?? null)

  useEffect(() => {
    if (imageUrl) {
      setResolvedUrl(imageUrl)
      return
    }
    setResolvedUrl(lastGoodUrl)
  }, [imageUrl, lastGoodUrl])

  return (
    <div
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-[14px] bg-white/8"
      style={{
        width: size,
        height: size,
        boxShadow: playing ? albumGlowShadow(imageUrl || "odin-music") : "inset 0 0 0 1px rgba(255,255,255,0.07)",
      }}
    >
      {resolvedUrl && connected ? (
        <img
          src={resolvedUrl}
          alt=""
          className="h-full w-full object-cover"
          onLoad={() => setLastGoodUrl(resolvedUrl)}
          onError={() => {
            if (lastGoodUrl && lastGoodUrl !== resolvedUrl) {
              setResolvedUrl(lastGoodUrl)
            } else {
              setResolvedUrl(null)
            }
          }}
        />
      ) : (
        <Music2 size={size > 44 ? 24 : 18} className="text-[#d8902f]" />
      )}
      {!connected ? <span className="absolute inset-0 animate-pulse bg-[#d8902f]/8" /> : null}
    </div>
  )
}

function TrayCard({
  label,
  icon,
  active,
  children,
  onClick,
  className = "",
  style,
}: {
  label: string
  icon: ReactNode
  active: boolean
  children: ReactNode
  onClick: () => void
  className?: string
  style?: CSSProperties
}) {
  return (
    <section
      role="button"
      tabIndex={0}
      style={style}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onClick()
        }
      }}
      className={[
        "odin-island-tray-item min-h-0 overflow-hidden rounded-[22px] border bg-white/[0.055] p-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition",
        active ? "border-[#d8902f]/48 bg-[#d8902f]/10" : "border-white/[0.075] hover:border-white/14 hover:bg-white/[0.075]",
        className,
      ].join(" ")}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/54">
          <span className="text-[#d8902f]">{icon}</span>
          {label}
        </div>
        <ChevronRight size={14} className="text-white/24" />
      </div>
      {children}
    </section>
  )
}

export function OdinIsland({ scenario = "live", overlay = false }: OdinIslandProps) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { google, withings, spotify } = useConnectedAccounts()
  const odinResponsibility = useOdinResponsibility(user?.id)
  const withingsHealth = useWithingsHealth(withings)
  const [music, setMusic] = useOdinMusicController()
  const selectedMusicAccount = useMemo(
    () => spotify.find((account) => account.id === music.activeAccountId) ?? spotify[0],
    [music.activeAccountId, spotify]
  )
  const syncMusicFromPlayback = useCallback(async () => {
    if (!selectedMusicAccount?.id) return
    try {
      const playback = await currentPlayback(selectedMusicAccount.id)
      setMusic((current) => {
        const positionMs = Number.isFinite(playback.positionMs)
          ? Math.max(0, playback.positionMs)
          : current.playback.positionMs
        const track = playback.track
          ? {
              title: playback.track.title,
              artist: playback.track.artist,
              album: playback.track.album,
              url: playback.track.url,
              uri: playback.track.uri,
              imageUrl: playback.track.imageUrl,
              durationMs: playback.track.durationMs,
            }
          : current.current
        return {
          ...current,
          activeAccountId: selectedMusicAccount.id,
          current: track,
          playback: {
            ...current.playback,
            isPlaying: Boolean(playback.isPlaying),
            startedAt: playback.isPlaying ? Date.now() - positionMs : null,
            positionMs,
          },
        }
      })
    } catch {
      // Keep local music state if playback sync fails.
    }
  }, [selectedMusicAccount?.id, setMusic])

  const playRandomRecommendation = async (accountId: string, deviceId: string | null) => {
    const terms = ["top hits", "new music", "chill", "rock", "hip hop", "pop"]
    const query = terms[Math.floor(Math.random() * terms.length)] ?? "music"
    const result = await searchSpotify(query, accountId)
    const candidates = result.tracks
      .map((track) => ({
        title: track.title,
        artist: track.artist,
        album: track.album,
        url: track.url,
        uri: track.uri,
        imageUrl: track.imageUrl,
        durationMs: track.durationMs,
      }))
      .filter((track) => Boolean(track.uri))
    const fallbackTrack = candidates[Math.floor(Math.random() * candidates.length)]
    if (!fallbackTrack?.uri) throw new Error("No recommendation track available.")
    await playSpotify(accountId, fallbackTrack.uri, deviceId)
    setMusic((current) => ({
      ...current,
      activeAccountId: accountId,
      current: fallbackTrack,
      playback: {
        ...current.playback,
        isPlaying: true,
        startedAt: Date.now(),
        positionMs: 0,
      },
    }))
  }

  useEffect(() => {
    if (!selectedMusicAccount?.id) return
    void syncMusicFromPlayback()
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncMusicFromPlayback()
      }
    }, 10000)
    const onFocus = () => {
      if (document.visibilityState === "visible") {
        void syncMusicFromPlayback()
      }
    }
    window.addEventListener("focus", onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [selectedMusicAccount?.id, syncMusicFromPlayback])

  useEffect(() => {
    if (!music.playback.isPlaying) return
    const timer = window.setInterval(() => setMusicNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [music.playback.isPlaying])

  const handoff = useOdinSurfaceHandoff()
  const [voiceState, setVoiceState] = useState<VoiceState>(scenario === "voice" ? "listening" : scenario === "blocked" ? "blocked" : "idle")
  const [musicBusy, setMusicBusy] = useState<"play" | "pause" | "next" | "previous" | null>(null)
  const [musicError, setMusicError] = useState<string | null>(null)
  const [musicNow, setMusicNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(scenario === "expanded" || (!overlay && scenario !== "collapsed"))
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [activeModule, setActiveModule] = useState<ActiveTrayModule>("music")
  const [calendar, setCalendar] = useState<CalendarSnapshot>({ events: [], loading: false, error: null, checkedAt: null })
  const collapseTimerRef = useRef<number | null>(null)
  const headerPressTimerRef = useRef<number | null>(null)
  const headerLongPressFiredRef = useRef(false)

  useEffect(() => {
    setExpanded(scenario === "expanded" || (!overlay && scenario !== "collapsed"))
    setVoiceState(scenario === "voice" ? "listening" : scenario === "blocked" ? "blocked" : "idle")
  }, [overlay, scenario])

  useEffect(() => {
    let cancelled = false
    async function readMicStatus() {
      if (scenario !== "live" && scenario !== "expanded" && scenario !== "collapsed") return
      const status = await desktopBridge()?.microphoneStatus?.()
      if (!cancelled && status === "denied") setVoiceState("blocked")
    }
    void readMicStatus()
    return () => {
      cancelled = true
    }
  }, [scenario])

  useEffect(() => {
    let cancelled = false
    const accountId = google[0]?.id
    if (!accountId) {
      setCalendar({ events: [], loading: false, error: null, checkedAt: null })
      return
    }
    const start = new Date()
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    setCalendar((current) => ({ ...current, loading: true, error: null }))
    void rangeEvents(start.toISOString(), end.toISOString(), accountId, 12)
      .then((result) => {
        if (cancelled) return
        setCalendar({
          events: result.data?.items ?? [],
          loading: false,
          error: result.error?.message ?? null,
          checkedAt: new Date().toISOString(),
        })
      })
      .catch((error) => {
        if (cancelled) return
        setCalendar({ events: [], loading: false, error: error instanceof Error ? error.message : "Calendar unavailable", checkedAt: new Date().toISOString() })
      })
    return () => {
      cancelled = true
    }
  }, [google])

  const topPending = useMemo(() => {
    return [...odinResponsibility.pendingItems]
      .sort((a, b) => pendingRank(b) - pendingRank(a))
      .find((item) => item.status === "open" || item.status === "waiting")
  }, [odinResponsibility.pendingItems])

  const activePending = useMemo(() => {
    return odinResponsibility.pendingItems
      .filter((item) => item.status === "open" || item.status === "waiting")
      .sort((a, b) => pendingRank(b) - pendingRank(a))
  }, [odinResponsibility.pendingItems])

  const opsCount = odinResponsibility.pendingSummary.needs_peter + odinResponsibility.pendingSummary.today
  const overdueCount = activePending.filter((item) => {
    const due = dueAt(item)
    return due ? due.getTime() < Date.now() : item.urgency === "critical"
  }).length
  const todayCount = odinResponsibility.pendingSummary.today
  const upcomingCount = Math.max(0, activePending.length - overdueCount - todayCount)
  const opsTitle = cleanText(topPending?.title || topPending?.summary, 64) || "Ops quiet"

  const healthSummary = withingsHealth.summary
  const healthReadiness = readinessScore(healthSummary)
  const healthHeart = healthSummary?.heartRate.bpm ? `${healthSummary.heartRate.bpm} bpm` : "--"
  const healthSleep = formatSleep(healthSummary?.sleep.durationMinutes)
  const healthSteps = compactNumber(healthSummary?.steps.count)
  const healthMove = topHealthMove(healthSummary)
  const healthFreshness = withingsHealth.checkedAt ? `Synced ${relativeTime(withingsHealth.checkedAt)}` : withingsHealth.account ? "Tap Health to read stats" : "Connect Withings"
  const healthWeight = (() => {
    const record = healthSummary as unknown as Record<string, unknown> | null
    const body = record?.body as Record<string, unknown> | undefined
    const weight = record?.weight as Record<string, unknown> | undefined
    const value = body?.weightKg ?? body?.weight_kg ?? weight?.kg ?? record?.weightKg
    return typeof value === "number" ? `${Math.round(value)} kg` : "--"
  })()

  const calendarEvents = useMemo(() => {
    return [...calendar.events]
      .filter((event) => event.status !== "cancelled")
      .sort((a, b) => (eventStart(a)?.getTime() ?? 0) - (eventStart(b)?.getTime() ?? 0))
  }, [calendar.events])
  const upcomingCalendarEvents = useMemo(() => {
    const now = Date.now() - 15 * 60_000
    return calendarEvents.filter((event) => (eventStart(event)?.getTime() ?? now) >= now).slice(0, 3)
  }, [calendarEvents])
  const nextCalendarEvent = upcomingCalendarEvents[0] ?? null
  const nextCalendarStart = eventStart(nextCalendarEvent)
  const calendarSoon = Boolean(nextCalendarStart && nextCalendarStart.getTime() - Date.now() <= 4 * 60 * 60 * 1000)

  const hasLiveTrack = Boolean(music.current.uri)
  const trackTitle = music.current.title || "No track selected"
  const trackArtist = music.current.artist || "Connect Spotify"
  const shownMusic = {
    title: hasLiveTrack ? trackTitle : "No track selected",
    artist: trackArtist,
    isPlaying: hasLiveTrack ? music.playback.isPlaying : false,
    imageUrl: music.current.imageUrl,
  }
  const hasTrackConnected = Boolean(music.current.uri || (shownMusic.title && shownMusic.title !== "No track selected" && shownMusic.title.trim().length > 0))
  const musicTitle = shownMusic.title === "No track selected" ? "No track" : shownMusic.title
  const musicArtist = shownMusic.artist
  const playbackPositionMs = (() => {
    const base = Math.max(0, music.playback.positionMs ?? 0)
    if (!music.playback.isPlaying || !music.playback.startedAt) return base
    return Math.max(base, base + (musicNow - music.playback.startedAt))
  })()
  const playbackDurationMs = music.current.durationMs ?? null
  const playbackProgressPct =
    playbackDurationMs && playbackDurationMs > 0
      ? Math.max(0, Math.min(100, (playbackPositionMs / playbackDurationMs) * 100))
      : 0

  const sharedVoice = handoff?.voice ?? null
  const effectiveVoiceState = sharedVoice ? sharedVoiceMode(sharedVoice) : voiceState
  const voiceBase = voiceCopy(effectiveVoiceState)
  const voiceDetail = cleanText(sharedVoice?.transcript || sharedVoice?.message || handoff?.latest?.spokenText || handoff?.latest?.displayText, 90)
  const voice = voiceDetail ? { ...voiceBase, detail: voiceDetail } : voiceBase

  const compactMode: CompactMode = scenario === "music"
    ? "music"
    : scenario === "ops"
      ? "priority"
      : scenario === "health"
        ? "health"
        : shownMusic.isPlaying
          ? "music"
          : opsCount > 0 && overdueCount > 0
            ? "priority"
            : calendarSoon
              ? "calendar"
              : hasHealthAnomaly(healthSummary)
                ? "health"
                : "idle"

  const sizeMode: IslandSizeMode = expanded ? "tray" : overlay ? "idle" : compactMode
  const currentSize = ISLAND_SIZES[sizeMode]
  const containerClass = overlay
    ? expanded
      ? "max-w-[1200px]"
      : "max-w-[44px]"
    : expanded
      ? "max-w-[1200px]"
      : "max-w-[700px]"

  useEffect(() => {
    if (!overlay) return
    void desktopBridge()?.island?.resize?.({ mode: sizeMode, width: currentSize.width, height: currentSize.height })
    if (expanded) void desktopBridge()?.island?.expand?.()
    else void desktopBridge()?.island?.collapse?.()
  }, [currentSize.height, currentSize.width, expanded, overlay, sizeMode])

  useEffect(() => {
    if (!overlay) return
    const collapse = () => setExpanded(false)
    const expand = () => setExpanded(true)
    window.addEventListener("odin:island-collapse", collapse)
    window.addEventListener("odin:island-expand", expand)
    return () => {
      window.removeEventListener("odin:island-collapse", collapse)
      window.removeEventListener("odin:island-expand", expand)
    }
  }, [overlay])

  const cancelCollapse = () => {
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = null
    }
  }

  const expandTray = () => {
    cancelCollapse()
    if (overlay) setExpanded(true)
  }

  const scheduleCollapse = () => {
    cancelCollapse()
    if (!overlay || pinnedOpen) return
    collapseTimerRef.current = window.setTimeout(() => setExpanded(false), 500)
  }

  useEffect(() => {
    return () => {
      cancelCollapse()
      if (headerPressTimerRef.current) window.clearTimeout(headerPressTimerRef.current)
    }
  }, [])

  const onVoiceAction = () => {
    const publishVoiceState = (next: VoiceState) => {
      const previous = loadOdinSurfaceHandoff()
      saveOdinSurfaceHandoff({ source: "island", updatedAt: Date.now(), voice: islandVoiceToShared(next), latest: previous?.latest ?? null })
    }

    if (effectiveVoiceState === "blocked") {
      void desktopBridge()?.requestMicrophoneAccess?.().then((allowed) => {
        const nextState: VoiceState = allowed ? "idle" : "blocked"
        setVoiceState(nextState)
        publishVoiceState(nextState)
      })
      return
    }
    if (effectiveVoiceState === "listening") {
      setVoiceState("idle")
      publishVoiceState("idle")
      void desktopBridge()?.voice?.stop?.()
      return
    }
    setVoiceState("listening")
    publishVoiceState("listening")
    void desktopBridge()?.voice?.start?.()
  }

  const runMusicAction = async (action: "play" | "pause" | "next" | "previous") => {
    const accountId = selectedMusicAccount?.id
    if (!accountId) {
      setMusicError("Connect Spotify first.")
      routeWithDesktop("/connections", navigate)
      return
    }

    const currentState = music
    const currentlyPlaying = currentState.playback.isPlaying
    if ((action === "play" || action === "pause") && !currentState.current.uri) {
      setMusicError("Pick a Spotify track first.")
      routeWithDesktop("/music", navigate)
      return
    }

    const queue = playableQueueTracks(currentState)
    const hasLocalQueue = queue.length >= 2
    const direction = action === "next" ? 1 : action === "previous" ? -1 : 0
    const targetTrack = hasLocalQueue && (action === "next" || action === "previous")
      ? (direction === 1 ? nextTrack(currentState, 1).current : direction === -1 ? nextTrack(currentState, -1).current : currentState.current)
      : currentState.current
    const shouldUseLocalTarget =
      (action === "next" || action === "previous") && hasLocalQueue && Boolean(targetTrack?.uri)

    setMusicBusy(action)
    setMusicError(null)
    try {
      const deviceResult = await listSpotifyDevices(accountId)
      const deviceId = deviceResult.devices.find((device) => device.isActive)?.id ?? deviceResult.devices.find((device) => device.id && !device.isRestricted)?.id ?? null
      if (action === "play") await playSpotify(accountId, currentState.current.uri, deviceId)
      else if (action === "pause") await pauseSpotify(accountId, deviceId)
      else if (!hasLocalQueue) {
        try {
          if (action === "next") await nextSpotify(accountId, deviceId)
          else await previousSpotify(accountId, deviceId)
        } catch {
          await playRandomRecommendation(accountId, deviceId)
        }
      } else {
        if (!targetTrack?.uri) {
          try {
            if (action === "next") await nextSpotify(accountId, deviceId)
            else await previousSpotify(accountId, deviceId)
          } catch {
            await playRandomRecommendation(accountId, deviceId)
          }
        } else {
          await playSpotify(accountId, targetTrack.uri, deviceId)
        }
      }

      setMusic((current) => ({
        ...current,
        activeAccountId: accountId,
        current: shouldUseLocalTarget ? targetTrack : current.current,
        playback: {
          ...current.playback,
          isPlaying: action === "pause" ? false : true,
          startedAt: action === "pause" ? null : Date.now(),
          positionMs: action === "pause" ? current.playback.positionMs : 0,
        },
      }))
      await syncMusicFromPlayback()
      setMusicError(null)
    } catch (error) {
      const readiness = spotifyReadinessFromError(error)
      if (readiness === "policy_blocked" || readiness === "needs_reconnect" || readiness === "no_device") setMusicError(spotifyReadinessMessage(readiness))
      else setMusicError("Spotify playback failed.")
      await syncMusicFromPlayback()
      if (!currentlyPlaying && action === "pause") {
        setMusic((current) => ({ ...current, playback: { ...current.playback, isPlaying: false, startedAt: null } }))
      }
    } finally {
      setMusicBusy(null)
    }
  }

  const jumpToTalkMode = () => {
    routeWithDesktop("/dashboard?portal=open", navigate)
    window.setTimeout(() => void desktopBridge()?.voice?.start?.(), 160)
  }

  const startHeaderLongPress = () => {
    headerLongPressFiredRef.current = false
    if (headerPressTimerRef.current) window.clearTimeout(headerPressTimerRef.current)
    headerPressTimerRef.current = window.setTimeout(() => {
      headerLongPressFiredRef.current = true
      jumpToTalkMode()
    }, 460)
  }

  const clearHeaderLongPress = () => {
    if (!headerPressTimerRef.current) return
    window.clearTimeout(headerPressTimerRef.current)
    headerPressTimerRef.current = null
  }

  const compactContent = () => {
    if (overlay) {
      return (
        <button type="button" onClick={expandTray} className="flex h-11 w-11 items-center justify-center rounded-full bg-transparent" aria-label="Expand ODIN island">
          <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-[#090909]/82 shadow-[0_18px_42px_-22px_rgba(0,0,0,0.96)] backdrop-blur-2xl">
            <span className="absolute inset-[-6px] animate-ping rounded-full bg-[#d8902f]/20" />
            <IslandOrb size={28} />
          </span>
        </button>
      )
    }

    if (compactMode === "music") {
      return (
        <div className="grid h-[64px] grid-cols-[minmax(0,1fr)_260px_minmax(0,1fr)] items-center gap-3 px-4">
          <button type="button" onClick={() => routeWithDesktop("/music", navigate)} className="flex min-w-0 items-center gap-3 text-left">
            <AlbumArt imageUrl={shownMusic.imageUrl} connected={hasTrackConnected} playing={shownMusic.isPlaying} size={52} />
            <span className="min-w-0">
              <span className="block truncate text-[18px] font-semibold leading-tight text-white">{musicTitle}</span>
              <span className="block truncate text-[14px] text-white/62">{musicArtist}</span>
            </span>
          </button>
          <div aria-hidden="true" className="h-full" />
          <div className="flex items-center justify-end gap-5 text-white/82">
            <button type="button" onClick={(event) => { event.stopPropagation(); void runMusicAction("previous") }} className="transition hover:text-white" aria-label="Previous"><SkipBack size={21} /></button>
            <button type="button" onClick={(event) => { event.stopPropagation(); void runMusicAction(shownMusic.isPlaying ? "pause" : "play") }} className="transition hover:text-white" aria-label={shownMusic.isPlaying ? "Pause" : "Play"}>{shownMusic.isPlaying ? <Pause size={25} /> : <Play size={25} />}</button>
            <button type="button" onClick={(event) => { event.stopPropagation(); void runMusicAction("next") }} className="transition hover:text-white" aria-label="Next"><SkipForward size={21} /></button>
            <VoiceDots state={effectiveVoiceState} />
            <IslandOrb size={38} />
          </div>
        </div>
      )
    }

    if (compactMode === "priority") {
      return (
        <button type="button" onClick={() => routeWithDesktop("/dashboard?portal=open", navigate)} className="grid h-12 w-full grid-cols-[minmax(0,1fr)_260px_minmax(0,1fr)] items-center gap-3 px-5 text-left">
          <div className="flex min-w-0 items-center gap-4">
            <Zap size={34} className="shrink-0 text-[#ff2f28]" />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-white">{opsCount} priority ops</span>
              <span className="block truncate text-[13px] font-medium text-[#ff352e]">{overdueCount} overdue</span>
            </span>
          </div>
          <div aria-hidden="true" className="h-full" />
          <div className="flex justify-end"><IslandOrb size={34} /></div>
        </button>
      )
    }

    if (compactMode === "calendar") {
      return (
        <button type="button" onClick={() => routeWithDesktop("/calendar", navigate)} className="grid h-12 w-full grid-cols-[minmax(0,1fr)_260px_minmax(0,1fr)] items-center gap-3 px-5 text-left">
          <div className="flex min-w-0 items-center gap-4">
            <CalendarDays size={30} className="shrink-0 text-[#f08a20]" />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-white">{eventTimeLabel(nextCalendarEvent)} {cleanText(nextCalendarEvent?.summary, 34) || "Calendar clear"}</span>
              <span className="block truncate text-[13px] text-white/52">{nextCalendarEvent ? timeUntil(nextCalendarStart) : "Nothing urgent"}</span>
            </span>
          </div>
          <div aria-hidden="true" className="h-full" />
          <div className="flex justify-end"><IslandOrb size={34} /></div>
        </button>
      )
    }

    if (compactMode === "health") {
      return (
        <button type="button" onClick={() => routeWithDesktop("/health", navigate)} className="grid h-12 w-full grid-cols-[minmax(0,1fr)_260px_minmax(0,1fr)] items-center gap-3 px-5 text-left">
          <div className="flex min-w-0 items-center gap-4">
            <HeartPulse size={31} className="shrink-0 text-[#ff3a34]" />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-white">{healthMove}</span>
              <span className="block truncate text-[13px] text-white/52">today</span>
            </span>
          </div>
          <div aria-hidden="true" className="h-full" />
          <div className="flex justify-end"><IslandOrb size={34} /></div>
        </button>
      )
    }

    return (
      <button type="button" onClick={expandTray} className="grid h-[58px] w-full grid-cols-[96px_minmax(260px,1fr)_96px] items-center text-left" aria-label="Expand ODIN island">
        <div className="flex h-[52px] w-[96px] items-center rounded-full border border-white/[0.07] bg-[#070707]/90 pl-3 shadow-[0_18px_42px_-22px_rgba(0,0,0,0.92),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl">
          <div className="relative">
            <span className="absolute inset-[-8px] animate-ping rounded-full bg-[#d8902f]/22" />
            <IslandOrb size={38} />
          </div>
        </div>
        <div aria-hidden="true" className="h-full" />
        <div className="flex h-[36px] w-[58px] items-center justify-center justify-self-end rounded-full border border-white/[0.07] bg-[#070707]/90 shadow-[0_14px_36px_-22px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl">
          <span className="h-2.5 w-2.5 rounded-full bg-[#d8902f] shadow-[0_0_16px_rgba(216,144,47,0.95)]" />
        </div>
      </button>
    )
  }

  const isIdleCompact = !expanded && (overlay || compactMode === "idle")

  return (
    <div className={["mx-auto w-full text-white", containerClass].join(" ")}> 
      <style>{`
        @keyframes odin-island-orb-breathe {
          0%, 100% { transform: scale(1); filter: saturate(1); }
          45% { transform: scale(1.055); filter: saturate(1.24); }
        }
        @keyframes odin-island-wave {
          0%, 100% { transform: scaleY(0.72); opacity: 0.42; }
          48% { transform: scaleY(1.32); opacity: 0.92; }
        }
        @keyframes odin-island-shell-bloom {
          0% { transform: translateY(-8px) scaleX(0.94) scaleY(0.88); opacity: 0.72; }
          62% { transform: translateY(1px) scaleX(1.012) scaleY(1.018); opacity: 1; }
          100% { transform: translateY(0) scaleX(1) scaleY(1); opacity: 1; }
        }
        @keyframes odin-island-tray-item-rise {
          0% { transform: translateY(-10px) scale(0.985); opacity: 0; }
          70% { transform: translateY(1px) scale(1.004); opacity: 1; }
          100% { transform: translateY(0) scale(1); opacity: 1; }
        }
        .odin-island-expanded-shell {
          transform-origin: top center;
          animation: odin-island-shell-bloom 420ms cubic-bezier(0.18, 0.86, 0.18, 1) both;
        }
        .odin-island-tray-item {
          animation: odin-island-tray-item-rise 460ms cubic-bezier(0.16, 0.92, 0.22, 1) both;
        }
      `}</style>
      <section
        className={[
          "relative overflow-hidden text-white",
          isIdleCompact
            ? "border border-transparent bg-transparent shadow-none"
            : "border border-white/[0.06] bg-[#080808]/[0.88] backdrop-blur-2xl shadow-[0_24px_70px_-32px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.08)]",
          expanded ? "odin-island-expanded-shell rounded-[32px] p-3" : isIdleCompact ? "rounded-none" : "rounded-[34px]",
        ].join(" ")}
        onMouseEnter={expandTray}
        onMouseLeave={scheduleCollapse}
      >
        {!expanded ? compactContent() : (
          <div className="h-[256px]">
            <div className="mb-3 grid grid-cols-[minmax(0,1fr)_360px_minmax(0,1fr)] items-center gap-3">
              <div className="flex items-center gap-2">
                <button
                type="button"
                onPointerDown={startHeaderLongPress}
                onPointerUp={clearHeaderLongPress}
                onPointerCancel={clearHeaderLongPress}
                onPointerLeave={clearHeaderLongPress}
                onClick={() => {
                  if (headerLongPressFiredRef.current) {
                    headerLongPressFiredRef.current = false
                    return
                  }
                  setPinnedOpen((current) => !current)
                }}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-black/35 px-3 text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]"
                aria-label="ODIN tray header. Long press to talk."
              >
                <IslandOrb size={28} />
                <span className="text-[#d8902f]">ODIN</span>
                <ChevronDown size={14} className={pinnedOpen ? "rotate-180 text-white/70" : "text-white/70"} />
                </button>
                <button
                type="button"
                onClick={onVoiceAction}
                className="ml-2 inline-flex h-9 items-center gap-2 rounded-full bg-white/8 px-3 text-[12px] font-semibold text-white/72 hover:bg-white/12 hover:text-white"
              >
                {effectiveVoiceState === "listening" ? <Square size={13} /> : <Mic2 size={13} />}
                {voice.action}
                </button>
              </div>
              <div className="flex h-9 items-center justify-center gap-2 rounded-full bg-black/20 px-2 text-[11px] font-bold uppercase tracking-[0.12em] text-white/42">
                <span>Music</span>
                <span>Today</span>
                <span>Tasks</span>
                <span>Health</span>
                <span>Files</span>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setPinnedOpen((current) => !current)}
                  className="inline-flex h-9 items-center gap-2 rounded-full bg-black/35 px-3 text-[12px] font-semibold text-white/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)] hover:text-white"
                >
                  Pin
                  <span className="h-2 w-2 rounded-full bg-[#d8902f]" />
                </button>
              </div>
            </div>

            <div className="grid h-[202px] grid-cols-5 gap-3">
              <TrayCard label="Music" icon={<Music2 size={14} />} active={activeModule === "music"} onClick={() => setActiveModule("music")} style={{ animationDelay: "30ms" }}>
                <div className="flex gap-3">
                  <AlbumArt imageUrl={shownMusic.imageUrl} connected={hasTrackConnected} playing={shownMusic.isPlaying} size={96} />
                  <div className="min-w-0 flex-1">
                    <div className="mb-2">
                      <ConnectionStatusChip
                        label="Spotify"
                        tone={selectedMusicAccount?.id ? "connected" : "disconnected"}
                        detail={selectedMusicAccount?.id ? "linked" : "not linked"}
                        className="border-0 bg-[#1ed760]/16 !px-2 !py-1 text-[10px] tracking-[0.06em] text-[#6af08f]"
                      />
                    </div>
                    <p className="truncate text-[17px] font-semibold">{musicTitle}</p>
                    <p className="truncate text-[13px] text-white/58">{musicArtist}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-center gap-5 text-white/82">
                  <button type="button" onClick={(event) => { event.stopPropagation(); void runMusicAction("previous") }} disabled={Boolean(musicBusy)} className="hover:text-white" aria-label="Previous">{musicBusy === "previous" ? <Loader2 size={18} className="animate-spin" /> : <SkipBack size={19} />}</button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); void runMusicAction(shownMusic.isPlaying ? "pause" : "play") }} disabled={Boolean(musicBusy)} className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black" aria-label={shownMusic.isPlaying ? "Pause" : "Play"}>{musicBusy === "play" || musicBusy === "pause" ? <Loader2 size={18} className="animate-spin" /> : shownMusic.isPlaying ? <Pause size={20} /> : <Play size={20} />}</button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); void runMusicAction("next") }} disabled={Boolean(musicBusy)} className="hover:text-white" aria-label="Next">{musicBusy === "next" ? <Loader2 size={18} className="animate-spin" /> : <SkipForward size={19} />}</button>
                </div>
                <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-[11px] font-semibold text-white/62">
                  <span>{formatTimeLabel(playbackPositionMs)}</span>
                  <div className="h-1 overflow-hidden rounded-full bg-white/12">
                    <div className="h-full rounded-full bg-[#d8902f]" style={{ width: `${playbackProgressPct}%` }} />
                  </div>
                  <span>{formatTimeLabel(playbackDurationMs)}</span>
                </div>
                {musicError ? <p className="mt-2 truncate text-[11px] font-semibold text-[#f4a15f]">{musicError}</p> : null}
              </TrayCard>

              <TrayCard label="Today" icon={<CalendarDays size={14} />} active={activeModule === "calendar"} onClick={() => setActiveModule("calendar")} style={{ animationDelay: "80ms" }}>
                <div className="mb-3 flex items-center gap-3">
                  <div className="rounded-xl bg-white/8 px-3 py-2 text-center"><p className="text-[10px] font-bold text-[#f08a20]">SUN</p><p className="text-[22px] font-bold leading-none">17</p></div>
                  <div className="text-[12px] text-white/52">{calendar.loading ? "Reading Calendar..." : calendar.error ? "Reconnect Calendar" : calendarEvents.length ? `${calendarEvents.length} event${calendarEvents.length === 1 ? "" : "s"} today` : "Nothing for today"}</div>
                </div>
                <div className="space-y-2">
                  {(upcomingCalendarEvents.length ? upcomingCalendarEvents : [{ id: "empty", summary: "Nothing for today" } as CalendarEvent]).map((event) => (
                    <div key={event.id} className="rounded-xl bg-white/[0.045] px-3 py-2">
                      <p className="truncate text-[12px] font-semibold">{eventTimeLabel(event)} {cleanText(event.summary, 28)}</p>
                      <p className="truncate text-[11px] text-white/43">{event.location || event.sourceCalendarSummary || timeUntil(eventStart(event))}</p>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={(event) => { event.stopPropagation(); routeWithDesktop("/calendar", navigate) }} className="mt-3 h-8 w-full rounded-full bg-white/10 text-[12px] font-semibold hover:bg-white/14">Open Calendar</button>
              </TrayCard>

              <TrayCard label="Priorities" icon={<ListChecks size={14} />} active={activeModule === "priorities"} onClick={() => setActiveModule("priorities")} style={{ animationDelay: "120ms" }}>
                <div className="mb-3 flex justify-end"><span className="rounded-full border border-[#ff352e]/30 bg-[#ff352e]/10 px-2 py-1 text-[10px] font-bold text-[#ff6b62]">{opsCount} items</span></div>
                <p className="mb-2 truncate text-[12px] font-semibold text-white/62">{opsTitle}</p>
                <div className="space-y-2 text-[13px] font-semibold">
                  <button type="button" onClick={(event) => { event.stopPropagation(); routeWithDesktop("/dashboard?portal=open", navigate) }} className="flex w-full items-center justify-between rounded-xl bg-white/[0.045] px-3 py-2 text-left"><span className="text-[#ff4238]">{overdueCount} overdue</span><ChevronRight size={13} className="text-white/28" /></button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); routeWithDesktop("/dashboard?portal=open", navigate) }} className="flex w-full items-center justify-between rounded-xl bg-white/[0.045] px-3 py-2 text-left"><span className="text-[#f0a22d]">{todayCount} today</span><ChevronRight size={13} className="text-white/28" /></button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); routeWithDesktop("/dashboard?portal=open", navigate) }} className="flex w-full items-center justify-between rounded-xl bg-white/[0.045] px-3 py-2 text-left"><span className="text-white/72">{upcomingCount} upcoming</span><ChevronRight size={13} className="text-white/28" /></button>
                </div>
                <button type="button" onClick={(event) => { event.stopPropagation(); routeWithDesktop("/dashboard?portal=open", navigate) }} className="mt-3 h-8 w-full rounded-full bg-white/10 text-[12px] font-semibold hover:bg-white/14">View all</button>
              </TrayCard>

              <TrayCard label="Health · Withings" icon={<HeartPulse size={14} />} active={activeModule === "health"} onClick={() => setActiveModule("health")} style={{ animationDelay: "165ms" }}>
                <div className="mb-2 flex items-center justify-between text-[10px] font-semibold">
                  <span className="text-white/45">Readiness {healthReadiness || "--"}</span>
                  <span className="text-[#75dc83]">{healthFreshness}</span>
                </div>
                <div className="mb-2">
                  <ConnectionStatusChip
                    label="Withings"
                    tone={withingsHealth.error ? "attention" : withingsHealth.account ? "connected" : "disconnected"}
                    detail={withingsHealth.error ? "needs reconnect" : withingsHealth.account ? "linked" : "not linked"}
                    className="border-0 bg-white/10 !px-2 !py-1 text-[10px] tracking-[0.06em] text-white/70"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <div className="rounded-xl bg-white/[0.045] p-2"><p className="text-white/42">Heart Rate</p><p className="text-[19px] font-semibold">{healthHeart}</p></div>
                  <div className="rounded-xl bg-white/[0.045] p-2"><p className="text-white/42">Sleep</p><p className="text-[19px] font-semibold">{healthSleep}</p></div>
                  <div className="rounded-xl bg-white/[0.045] p-2"><p className="text-white/42">Steps</p><p className="text-[19px] font-semibold">{healthSteps}</p></div>
                  <div className="rounded-xl bg-white/[0.045] p-2"><p className="text-white/42">Weight</p><p className="text-[19px] font-semibold">{healthWeight}</p></div>
                </div>
                <button type="button" onClick={(event) => { event.stopPropagation(); routeWithDesktop("/health", navigate) }} className="mt-3 h-8 w-full rounded-full bg-white/10 text-[12px] font-semibold hover:bg-white/14">Open Withings</button>
              </TrayCard>

              <TrayCard label="Quick Access" icon={<Download size={14} />} active={activeModule === "quick"} onClick={() => setActiveModule("quick")} style={{ animationDelay: "210ms" }}>
                <div className="space-y-2 text-[12px] font-semibold">
                  <button type="button" onClick={(event) => { event.stopPropagation(); openPath("downloads") }} className="flex w-full items-center gap-2 rounded-xl bg-white/[0.075] px-3 py-2 text-left hover:bg-white/12"><Folder size={14} />Downloads</button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); openPath("screenshots") }} className="flex w-full items-center gap-2 rounded-xl bg-white/[0.075] px-3 py-2 text-left hover:bg-white/12"><Activity size={14} />Screenshots</button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); openPath("documents") }} className="flex w-full items-center gap-2 rounded-xl bg-white/[0.075] px-3 py-2 text-left hover:bg-white/12"><FileText size={14} />Documents</button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); openPath("recent") }} className="flex w-full items-center gap-2 rounded-xl bg-white/[0.075] px-3 py-2 text-left hover:bg-white/12"><Folder size={14} />Recent Files</button>
                </div>
                <button type="button" onClick={(event) => { event.stopPropagation(); openPath("downloads") }} className="mt-3 h-8 w-full rounded-full bg-white/10 text-[12px] font-semibold hover:bg-white/14">Open Downloads</button>
              </TrayCard>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export function OdinIslandScenarioPicker({ scenario }: { scenario: IslandScenario }) {
  const navigate = useNavigate()
  return (
    <div className="mx-auto mb-8 flex max-w-[900px] flex-wrap gap-2">
      {SCENARIO_LABELS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => navigate(`/island?state=${item.id}`)}
          className={[
            "rounded-full border px-4 py-2 text-sm font-extrabold transition",
            scenario === item.id
              ? "border-[#b6531c] bg-[#b6531c] text-[#fffaf1]"
              : "border-[#dfcfb1] bg-[#fffaf1] text-[#6f5a3d] hover:bg-[#f3dfcc]",
          ].join(" ")}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export type { IslandScenario }

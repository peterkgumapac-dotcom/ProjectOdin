import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  HeartPulse,
  Mail,
  MessageSquare,
  Mic2,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  SkipBack,
  SkipForward,
} from "lucide-react"
import type { CalendarEvent } from "@/lib/connectors/calendar"
import { rangeEvents } from "@/lib/connectors/calendar"
import { useAuth } from "@/hooks/useAuth"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import { useOdinResponsibility } from "@/hooks/useOdinResponsibility"
import { useTodayEvents } from "@/hooks/useTodayEvents"
import { useWithingsHealth } from "@/hooks/useWithingsHealth"
import {
  currentPlayback,
  listSpotifyDevices,
  nextSpotify,
  pauseSpotify,
  playSpotify,
  previousSpotify,
} from "@/lib/connectors/spotify"
import { useOdinMusicState, type MusicTrack } from "@/lib/musicState"
import { applyInjectedSupabaseSession, supabase } from "@/lib/supabaseClient"
import { onOdinEvent, postOdinAction } from "@/lib/window.odin"

type SessionState = "checking" | "ready" | "quiet"
type NotchTab = "odin" | "priority" | "calendar" | "quickAccess"

type RecentFileRow = {
  path: string
  name: string
  appName?: string
  modifiedAt?: string
}

type AppShortcut = {
  id: string
  label: string
  action: "route" | "path"
  value: string
  icon?: string
}

type InstalledAppRow = {
  id?: string
  label?: string
  path?: string
  icon?: string
}

const DEFAULT_APP_SHORTCUTS: AppShortcut[] = [
  { id: "slack", label: "Slack", action: "path", value: "/Applications/Slack.app" },
  { id: "chrome", label: "Chrome", action: "path", value: "/Applications/Google Chrome.app" },
]

const APP_SHORTCUT_POOL: AppShortcut[] = [
  { id: "slack", label: "Slack", action: "path", value: "/Applications/Slack.app" },
  { id: "chrome", label: "Chrome", action: "path", value: "/Applications/Google Chrome.app" },
  { id: "finder", label: "Finder", action: "path", value: "/System/Library/CoreServices/Finder.app" },
  { id: "safari", label: "Safari", action: "path", value: "/Applications/Safari.app" },
  { id: "mail", label: "Mail", action: "path", value: "/System/Applications/Mail.app" },
  { id: "messages", label: "Messages", action: "path", value: "/System/Applications/Messages.app" },
  { id: "calendar-app", label: "Calendar", action: "path", value: "/System/Applications/Calendar.app" },
  { id: "notes", label: "Notes", action: "path", value: "/System/Applications/Notes.app" },
  { id: "music-app", label: "Music", action: "path", value: "/System/Applications/Music.app" },
  { id: "terminal", label: "Terminal", action: "path", value: "/System/Applications/Utilities/Terminal.app" },
]

const APP_SHORTCUTS_KEY = "odin.notch.shortcuts"
const notchStorageFallback = new Map<string, string>()
const NOTCH_WIDTH_FALLBACK = 184
const NOTCH_HEIGHT_FALLBACK = 38
const NOTCH_SAFE_PADDING_X = 96

function isNotchTrayStorageContext(): boolean {
  if (typeof window === "undefined") return false
  return window.location.pathname === "/notch-tray" || window.location.pathname.startsWith("/notch-tray/")
}

function safeSetItem(key: string, value: string): void {
  if (typeof window === "undefined") return
  if (!isNotchTrayStorageContext()) {
    window.localStorage.setItem(key, value)
    return
  }
  try {
    window.localStorage.setItem(key, value)
  } catch {
    notchStorageFallback.set(key, value)
  }
}

function safeGetItem(key: string): string | null {
  if (typeof window === "undefined") return null
  if (!isNotchTrayStorageContext()) {
    return window.localStorage.getItem(key)
  }
  try {
    return window.localStorage.getItem(key) ?? notchStorageFallback.get(key) ?? null
  } catch {
    return notchStorageFallback.get(key) ?? null
  }
}

function shortText(value: string | null | undefined, max = 42): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function formatDayTitle(date: Date): string {
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function eventStart(event: CalendarEvent): Date | null {
  const raw = event.start?.dateTime ?? event.start?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function eventTimezone(event: CalendarEvent): string {
  const tz = event.start?.timeZone || event.end?.timeZone
  if (tz && tz.trim()) return tz
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time"
}

function openRoute(route: string) {
  void postOdinAction("openRoute", { route })
}

function openPath(path: string) {
  void postOdinAction("openPath", { path })
}

async function loadMainMusicStateFallback(): Promise<{ track: MusicTrack | null; isPlaying: boolean } | null> {
  try {
    const response = await fetch("/__odin/music-state", { cache: "no-store" })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      state?: {
        current?: Partial<MusicTrack>
        playback?: { isPlaying?: boolean }
      } | null
    }
    const current = payload.state?.current
    const title = (current?.title ?? "").trim()
    const artist = (current?.artist ?? "").trim()
    const hasTrack = Boolean(title && !/^no\s+track/i.test(title))
    if (!hasTrack) return null
    return {
      track: {
        title,
        artist,
        album: current?.album ?? "",
        url: current?.url ?? "",
        uri: current?.uri,
        imageUrl: current?.imageUrl ?? null,
        durationMs: current?.durationMs ?? null,
      },
      isPlaying: Boolean(payload.state?.playback?.isPlaying),
    }
  } catch {
    return null
  }
}

function SpotifyBadge() {
  return (
    <span className="odin-source-badge" aria-label="Spotify">
      <svg viewBox="0 0 24 24" className="odin-spotify-glyph" aria-hidden="true">
        <path d="M6.9 14.8a.9.9 0 0 1 1.2-.3c2.4 1.4 5.4 1.7 8.8.9a.9.9 0 0 1 .4 1.8c-3.8.9-7.2.5-10.1-1.1a.9.9 0 0 1-.3-1.3Z" />
        <path d="M6.1 11.7a1 1 0 0 1 1.3-.4c2.9 1.5 6.2 2 9.8 1.1a1 1 0 0 1 .5 1.9c-4 .9-7.8.4-11-1.3a1 1 0 0 1-.6-1.3Z" />
        <path d="M6 8.4a1 1 0 0 1 1.4-.5c3.2 1.7 6.9 2.2 10.8 1.2a1 1 0 0 1 .5 2c-4.4 1-8.5.5-12.1-1.4A1 1 0 0 1 6 8.4Z" />
      </svg>
    </span>
  )
}

function loadSavedShortcuts(): AppShortcut[] {
  try {
    const raw = safeGetItem(APP_SHORTCUTS_KEY)
    if (!raw) return DEFAULT_APP_SHORTCUTS
    const parsed = JSON.parse(raw) as Array<Partial<AppShortcut> & { route?: string; path?: string }>
    const normalized = parsed
      .map((item) => {
        if (!item || typeof item.id !== "string" || typeof item.label !== "string") return null
        if ((item.action === "route" || item.action === "path") && typeof item.value === "string") {
          return {
            id: item.id,
            label: item.label,
            action: item.action,
            value: item.value,
            icon: typeof (item as { icon?: unknown }).icon === "string" ? (item as { icon?: string }).icon : undefined,
          } as AppShortcut
        }
        if (typeof item.route === "string") {
          return { id: item.id, label: item.label, action: "route", value: item.route } as AppShortcut
        }
        if (typeof item.path === "string") {
          return {
            id: item.id,
            label: item.label,
            action: "path",
            value: item.path,
            icon: typeof (item as { icon?: unknown }).icon === "string" ? (item as { icon?: string }).icon : undefined,
          } as AppShortcut
        }
        return null
      })
      .filter((item): item is AppShortcut => Boolean(item))
    const cleaned = normalized.filter((item) => item.action === "path" && item.value.toLowerCase().endsWith(".app"))
    return cleaned.length > 0 ? cleaned : DEFAULT_APP_SHORTCUTS
  } catch {
    return DEFAULT_APP_SHORTCUTS
  }
}

export function OdinNotchOverlay() {
  const { user } = useAuth()
  const { google, spotify, withings } = useConnectedAccounts()
  const music = useOdinMusicState()
  const eventsState = useTodayEvents(google, { auto: true, pollMs: 60_000 })
  const responsibilities = useOdinResponsibility(user?.id)
  const withingsHealth = useWithingsHealth(withings, { autoRefreshUnusableCache: true })

  const [liveTrack, setLiveTrack] = useState<MusicTrack | null>(null)
  const [livePlaying, setLivePlaying] = useState(false)
  const [sessionState, setSessionState] = useState<SessionState>("checking")
  const [activeTab, setActiveTab] = useState<NotchTab>("odin")
  const [viewedDate, setViewedDate] = useState<Date>(new Date())
  const [dayEvents, setDayEvents] = useState<CalendarEvent[]>([])
  const [dayLoading, setDayLoading] = useState(false)
  const [recentFiles, setRecentFiles] = useState<RecentFileRow[]>([])
  const [transportError, setTransportError] = useState<string | null>(null)
  const [transportBusy, setTransportBusy] = useState<"toggle" | "next" | "previous" | null>(null)
  const [appShortcuts, setAppShortcuts] = useState<AppShortcut[]>(() => loadSavedShortcuts())
  const [appShortcutPool, setAppShortcutPool] = useState<AppShortcut[]>(APP_SHORTCUT_POOL)
  const [isShortcutPickerOpen, setShortcutPickerOpen] = useState(false)

  const swipeStartXRef = useRef<number | null>(null)
  const calendarScrollRef = useRef<HTMLDivElement | null>(null)
  const shortcutPickerRef = useRef<HTMLDivElement | null>(null)
  const trayReadySentRef = useRef(false)

  const activeSpotifyAccount = useMemo(
    () => spotify.find((account) => account.id === music.activeAccountId) ?? spotify[0] ?? null,
    [spotify, music.activeAccountId]
  )

  const refreshSessionState = useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    setSessionState(data.session ? "ready" : "quiet")
  }, [])

  useEffect(() => {
    let mounted = true
    const timeout = window.setTimeout(() => {
      if (mounted) setSessionState((current) => (current === "checking" ? "quiet" : current))
    }, 500)

    void applyInjectedSupabaseSession(window.__ODIN_INITIAL_SESSION__).finally(() => {
      if (mounted) void refreshSessionState()
    })

    const offAuth = onOdinEvent<Window["__ODIN_INITIAL_SESSION__"]>("auth:session", (session) => {
      void applyInjectedSupabaseSession(session).finally(refreshSessionState)
    })

    const offRecentFiles = onOdinEvent<RecentFileRow[]>("quick-access:recent-files", (rows) => {
      if (!Array.isArray(rows)) return
      const normalized = rows
        .filter((row) => row && typeof row.path === "string")
        .map((row) => ({
          path: row.path,
          name: row.name || row.path.split("/").pop() || "Untitled",
          appName: row.appName || "",
          modifiedAt: row.modifiedAt || "",
        }))
      setRecentFiles(normalized)
    })

    const offInstalledApps = onOdinEvent<InstalledAppRow[]>("quick-access:installed-apps", (rows) => {
      if (!Array.isArray(rows)) return
      const normalized = rows
        .filter((row) =>
          row &&
          typeof row.path === "string" &&
          row.path.toLowerCase().endsWith(".app") &&
          typeof row.label === "string"
        )
        .map((row) => ({
          id: typeof row.id === "string" && row.id.trim() ? row.id : `app:${row.path}`,
          label: row.label || "App",
          action: "path" as const,
          value: row.path as string,
          icon: typeof row.icon === "string" ? row.icon : undefined,
        }))
      if (normalized.length > 0) {
        setAppShortcutPool(normalized)
        setAppShortcuts((current) => {
          const byPath = new Map(normalized.map((item) => [item.value, item]))
          const mapped: AppShortcut[] = []
          for (const item of current) {
            if (item.action !== "path") continue
            if (!item.value.toLowerCase().endsWith(".app")) continue
            const matched = byPath.get(item.value)
            if (!matched) continue
            mapped.push({
              ...item,
              id: matched.id,
              label: matched.label,
              icon: matched.icon,
              value: matched.value,
            })
          }

          const seen = new Set(mapped.map((item) => `${item.action}:${item.value}`))
          const deduped: AppShortcut[] = []
          for (const item of mapped) {
            const key = `${item.action}:${item.value}`
            if (!deduped.some((existing) => `${existing.action}:${existing.value}` === key)) {
              deduped.push(item)
            }
          }

          while (deduped.length < 2) {
            const fill = normalized.find(
              (candidate) => !seen.has(`${candidate.action}:${candidate.value}`)
            )
            if (!fill) break
            seen.add(`${fill.action}:${fill.value}`)
            deduped.push(fill)
          }

          return deduped.length > 0 ? deduped : normalized.slice(0, 2)
        })
      } else {
        setAppShortcutPool(APP_SHORTCUT_POOL)
        setAppShortcuts((current) => {
          const cleaned = current.filter((item) => item.action === "path" && item.value.toLowerCase().endsWith(".app"))
          return cleaned.length > 0 ? cleaned : DEFAULT_APP_SHORTCUTS
        })
      }
    })

    const announceReady = () => {
      if (trayReadySentRef.current) return
      trayReadySentRef.current = true
      void postOdinAction("trayReady")
      void postOdinAction("listRecentFiles")
      void postOdinAction("listInstalledApps")
    }

    window.requestAnimationFrame(() => {
      announceReady()
      window.setTimeout(announceReady, 220)
    })

    return () => {
      mounted = false
      window.clearTimeout(timeout)
      offAuth()
      offRecentFiles()
      offInstalledApps()
    }
  }, [refreshSessionState])

  useEffect(() => {
    const detailMode = activeTab === "calendar" || activeTab === "priority" || activeTab === "quickAccess"
    void postOdinAction("resize", { mode: detailMode ? "detail" : "overview" })
  }, [activeTab])

  useEffect(() => {
    safeSetItem(APP_SHORTCUTS_KEY, JSON.stringify(appShortcuts))
  }, [appShortcuts])

  useEffect(() => {
    if (appShortcuts.length > 0 || appShortcutPool.length === 0) return
    const seeded = appShortcutPool.filter((item) => item.action === "path" && item.value.toLowerCase().endsWith(".app")).slice(0, 2)
    if (seeded.length > 0) {
      setAppShortcuts(seeded)
    }
  }, [appShortcuts.length, appShortcutPool])

  useEffect(() => {
    if (!isShortcutPickerOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!shortcutPickerRef.current?.contains(event.target as Node)) {
        setShortcutPickerOpen(false)
      }
    }
    window.addEventListener("pointerdown", onPointerDown)
    return () => window.removeEventListener("pointerdown", onPointerDown)
  }, [isShortcutPickerOpen])

  const syncMusicFromSpotify = useCallback(async () => {
    if (!activeSpotifyAccount?.id) {
      const fallback = await loadMainMusicStateFallback()
      if (fallback?.track) {
        setLiveTrack(fallback.track)
        setLivePlaying(fallback.isPlaying)
      }
      return
    }

    try {
      const playback = await currentPlayback(activeSpotifyAccount.id)
      if (playback.track) {
        setLiveTrack({
          title: playback.track.title,
          artist: playback.track.artist,
          album: playback.track.album,
          url: playback.track.url,
          uri: playback.track.uri,
          imageUrl: playback.track.imageUrl,
          durationMs: playback.track.durationMs,
        })
      } else {
        const fallback = await loadMainMusicStateFallback()
        if (fallback?.track) {
          setLiveTrack(fallback.track)
          setLivePlaying(fallback.isPlaying)
        }
      }
      setLivePlaying(Boolean(playback.isPlaying))
    } catch {
      const fallback = await loadMainMusicStateFallback()
      if (fallback?.track) {
        setLiveTrack(fallback.track)
        setLivePlaying(fallback.isPlaying)
      }
    }
  }, [activeSpotifyAccount?.id])

  useEffect(() => {
    void syncMusicFromSpotify()
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncMusicFromSpotify()
      }
    }, 12_000)
    const onFocus = () => {
      if (document.visibilityState === "visible") {
        void syncMusicFromSpotify()
      }
    }
    window.addEventListener("focus", onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", onFocus)
    }
  }, [syncMusicFromSpotify])

  useEffect(() => {
    if (withingsHealth.account && !withingsHealth.summary && !withingsHealth.loading) {
      void withingsHealth.refresh(true)
    }
  }, [withingsHealth])

  const fetchDayEvents = useCallback(async (date: Date) => {
    if (google.length === 0) {
      setDayEvents([])
      return
    }
    setDayLoading(true)
    const dayStart = startOfDay(date)
    const dayEnd = new Date(dayStart)
    dayEnd.setDate(dayEnd.getDate() + 1)

    const results = await Promise.all(
      google.map(async (account) => {
        const { data } = await rangeEvents(dayStart.toISOString(), dayEnd.toISOString(), account.id, 64)
        return (data?.items ?? []).map((event) => ({
          ...event,
          sourceAccountLabel: account.accountLabel,
          sourceAccountId: account.id,
        }))
      })
    )

    const merged = results
      .flat()
      .sort((a, b) => {
        const aStart = eventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER
        const bStart = eventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER
        return aStart - bStart
      })

    setDayEvents(merged)
    setDayLoading(false)
  }, [google])

  useEffect(() => {
    if (activeTab !== "calendar") return
    void fetchDayEvents(viewedDate)
  }, [activeTab, viewedDate, fetchDayEvents])

  useEffect(() => {
    if (activeTab !== "calendar") return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        setViewedDate((current) => addDays(current, -1))
      }
      if (event.key === "ArrowRight") {
        event.preventDefault()
        setViewedDate((current) => addDays(current, 1))
      }
      if (event.key === "ArrowDown" && calendarScrollRef.current) {
        event.preventDefault()
        calendarScrollRef.current.scrollBy({ top: 72, behavior: "smooth" })
      }
      if (event.key === "ArrowUp" && calendarScrollRef.current) {
        event.preventDefault()
        calendarScrollRef.current.scrollBy({ top: -72, behavior: "smooth" })
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [activeTab])

  const openPrioritySignals = useMemo(
    () => responsibilities.signals.filter((item) => item.status === "open" || item.status === "waiting"),
    [responsibilities.signals]
  )
  const priorityCount = openPrioritySignals.length || responsibilities.pendingSummary.needs_peter
  const criticalCount = openPrioritySignals.filter((item) => item.category === "urgent").length
  const normalCount = Math.max(priorityCount - criticalCount, 0)

  const displayTrack = liveTrack ?? music.current
  const rawTitle = (displayTrack.title ?? "").trim()
  const hasTrackLoaded = Boolean((rawTitle && !/^no\s+track/i.test(rawTitle)) || displayTrack.imageUrl)
  const isPlaying = Boolean(liveTrack ? livePlaying : music.playback.isPlaying) && hasTrackLoaded
  const musicTitle = shortText(hasTrackLoaded ? rawTitle : "No music playing", 34)
  const musicArtist = shortText(hasTrackLoaded ? displayTrack.artist : "Connect Spotify", 40)

  const upcomingMeetings = useMemo(() => {
    const now = Date.now()
    return eventsState.events
      .filter((event) => (eventStart(event)?.getTime() ?? 0) >= now)
      .slice(0, 2)
  }, [eventsState.events])

  const prioritySourceCounts = useMemo(() => {
    const counts = { slack: 0, gmail: 0 }
    for (const signal of openPrioritySignals) {
      const source = (signal.source ?? "").toLowerCase()
      if (source.includes("slack")) counts.slack += 1
      if (source.includes("gmail") || source.includes("mail")) counts.gmail += 1
    }
    return counts
  }, [openPrioritySignals])

  const dayTitle = formatDayTitle(viewedDate)

  const compactCalendarDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(viewedDate, index - 3)
      return {
        label: date.toLocaleDateString([], { weekday: "short" }).slice(0, 1).toUpperCase(),
        value: String(date.getDate()),
        selected: startOfDay(date).getTime() === startOfDay(viewedDate).getTime(),
      }
    })
  }, [viewedDate])

  useEffect(() => {
    const nextMeeting = upcomingMeetings[0]
    const nextMeetingStart = nextMeeting ? eventStart(nextMeeting) : null
    const minutesUntilMeeting = nextMeetingStart
      ? Math.round((nextMeetingStart.getTime() - Date.now()) / 60000)
      : null

    if (hasTrackLoaded) {
      void postOdinAction("setCompactMode", {
        mode: "music",
        title: musicTitle,
        subtitle: musicArtist,
        artworkUrl: displayTrack.imageUrl ?? "",
        progress: isPlaying ? 0.58 : 0.36,
        isPlaying,
      })
      return
    }

    if (nextMeeting && nextMeetingStart && minutesUntilMeeting !== null && minutesUntilMeeting >= -5 && minutesUntilMeeting <= 45) {
      void postOdinAction("setCompactMode", {
        mode: "meeting",
        title: shortText(nextMeeting.summary, 42) || "Meeting",
        subtitle: `${minutesUntilMeeting <= 0 ? "Now" : `in ${minutesUntilMeeting}m`} · ${shortText(eventTimezone(nextMeeting), 18)}`,
        detail: formatClock(nextMeetingStart),
        actionLabel: "Join",
        actionRoute: "/calendar",
      })
      return
    }

    if (activeTab === "calendar") {
      void postOdinAction("setCompactMode", {
        mode: "calendarBrowse",
        title: viewedDate.toLocaleDateString([], { month: "long", year: "numeric" }),
        days: compactCalendarDays,
      })
      return
    }

    void postOdinAction("setCompactMode", {
      mode: "resting",
      title: nextMeeting && nextMeetingStart
        ? `${formatClock(nextMeetingStart)} ${shortText(nextMeeting.summary, 24) || "Meeting"}`
        : "ODIN",
      subtitle: nextMeetingStart && minutesUntilMeeting !== null && minutesUntilMeeting > 0
        ? `in ${minutesUntilMeeting}m`
        : "Ready",
    })
  }, [
    activeTab,
    compactCalendarDays,
    displayTrack.imageUrl,
    hasTrackLoaded,
    isPlaying,
    musicArtist,
    musicTitle,
    upcomingMeetings,
    viewedDate,
  ])

  const hasShortcut = useCallback(
    (current: AppShortcut[], candidate: AppShortcut) =>
      current.some((item) =>
        item.id === candidate.id ||
        (item.action === candidate.action && item.value === candidate.value)
      ),
    []
  )

  const availableShortcutCandidates = useMemo(
    () => appShortcutPool.filter((candidate) => !hasShortcut(appShortcuts, candidate)),
    [appShortcutPool, appShortcuts, hasShortcut]
  )

  const triggerLiveScan = useCallback(() => {
    void syncMusicFromSpotify()
    void eventsState.refresh()
    if (activeTab === "calendar") {
      void fetchDayEvents(viewedDate)
    }
    void postOdinAction("listRecentFiles")
    const refreshResponsibilities = (responsibilities as { refresh?: () => Promise<void> | void }).refresh
    const refreshHealth = (withingsHealth as { refresh?: () => Promise<void> | void }).refresh
    if (typeof refreshResponsibilities === "function") void refreshResponsibilities()
    if (typeof refreshHealth === "function") void refreshHealth()
  }, [activeTab, eventsState, fetchDayEvents, responsibilities, syncMusicFromSpotify, viewedDate, withingsHealth])

  const addShortcut = useCallback((shortcutId?: string) => {
    setAppShortcuts((current) => {
      const sourcePool = shortcutId
        ? appShortcutPool.filter((candidate) => candidate.id === shortcutId)
        : appShortcutPool
      const next = sourcePool.find((candidate) => !hasShortcut(current, candidate))
      if (!next) return current
      return [...current, next]
    })
    setShortcutPickerOpen(false)
  }, [appShortcutPool, hasShortcut])

  const renderShortcutGlyph = useCallback((shortcut: AppShortcut) => {
    if (shortcut.icon) {
      return (
        <span className="odin-main-app-icon-stack" aria-hidden="true">
          <span className="odin-main-app-icon-fallback">{shortcut.label.slice(0, 1).toUpperCase()}</span>
          <img
            src={shortcut.icon}
            alt=""
            className="odin-main-app-icon-img odin-main-app-icon-img-app"
            onError={(event) => {
              event.currentTarget.style.display = "none"
            }}
          />
        </span>
      )
    }
    const id = shortcut.id.toLowerCase()
    const token = `${shortcut.id} ${shortcut.label} ${shortcut.value}`.toLowerCase()
    if (id.includes("slack")) {
      return <img src="/odin-core/slack.svg" alt="" className="odin-main-app-icon-img" aria-hidden="true" />
    }
    if (token.includes("gmail") || token.includes("mail")) return <Mail size={13} />
    if (token.includes("message")) return <MessageSquare size={13} />
    if (token.includes("music")) return <Music2 size={13} />
    if (token.includes("calendar")) return <CalendarDays size={13} />
    if (token.includes("council") || token.includes("priority")) return <AlertTriangle size={13} />
    if (token.includes("health")) return <HeartPulse size={13} />
    if (token.includes("browser") || token.includes("chrome") || token.includes("safari")) return <Globe size={13} />
    if (token.includes("finder")) return <FolderOpen size={13} />
    if (token.includes("rules") || token.includes("settings")) return <Settings2 size={13} />
    if (token.includes("accounts")) return <Mic2 size={13} />
    return <Folder size={13} />
  }, [])

  const triggerMusicAction = useCallback(async (action: "toggle" | "next" | "previous") => {
    const accountId = activeSpotifyAccount?.id ?? music.activeAccountId ?? null
    if (transportBusy) return
    setTransportError(null)
    setTransportBusy(action)

    try {
      const devices = await listSpotifyDevices(accountId || undefined)
      const activeDevice =
        devices.devices.find((device) => device.isActive) ??
        devices.devices.find((device) => Boolean(device.id && !device.isRestricted))
      const deviceId = activeDevice?.id ?? null

      if (action === "toggle") {
        if (isPlaying) {
          setLivePlaying(false)
          await pauseSpotify(accountId || undefined, deviceId)
        } else {
          setLivePlaying(true)
          let started = false
          if (displayTrack.uri) {
            try {
              await playSpotify(accountId || undefined, displayTrack.uri, deviceId)
              started = true
            } catch (uriError) {
              const message = uriError instanceof Error ? uriError.message : ""
              if (!/404|No active device|premium|required|reconnect|unauthorized/i.test(message)) {
                throw uriError
              }
            }
          }
          if (!started) {
            await playSpotify(accountId || undefined, undefined, deviceId)
          }
        }
      } else if (action === "next") {
        await nextSpotify(accountId || undefined, deviceId)
      } else {
        await previousSpotify(accountId || undefined, deviceId)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Spotify controls unavailable."
      setTransportError(/No active Spotify device|No active device/i.test(message)
        ? "Open Spotify once on this Mac, then press play again."
        : message)
    }

    setTransportBusy(null)
    await syncMusicFromSpotify()
  }, [activeSpotifyAccount?.id, displayTrack.uri, isPlaying, music.activeAccountId, syncMusicFromSpotify, transportBusy])

  const handleMusicControl = useCallback((event: React.MouseEvent<HTMLButtonElement>, action: "toggle" | "next" | "previous") => {
    event.preventDefault()
    event.stopPropagation()
    void triggerMusicAction(action)
  }, [triggerMusicAction])

  const handleHoverEnter = useCallback(() => {
    void postOdinAction("hoverEnter")
  }, [])

  const handleHoverLeave = useCallback(() => {
    void postOdinAction("hoverLeave")
  }, [])

  const renderOdinTab = () => (
    <>
      <section className={`odin-content-left odin-content-left-stack ${hasTrackLoaded ? "is-playing" : "is-idle"}`}>
        <div className="odin-content-track">
          <div className="odin-art-wrap">
            {displayTrack.imageUrl ? (
              <img src={displayTrack.imageUrl} alt={musicTitle} className="odin-art" loading="lazy" />
            ) : (
              <div className="odin-art odin-art-fallback"><Music2 size={20} /></div>
            )}
            {hasTrackLoaded ? <SpotifyBadge /> : null}
          </div>
          <div className="odin-music-meta">
            <p className="odin-track-title">{musicTitle}</p>
            <p className="odin-track-artist">{musicArtist}</p>
            {hasTrackLoaded ? (
              <div className="odin-progress" aria-hidden="true"><div className={`odin-progress-fill ${isPlaying ? "is-playing" : "is-paused"}`} /></div>
            ) : (
              <button type="button" className="odin-open-btn" onClick={() => openRoute("/music")}>Open Music</button>
            )}
            {transportError ? <p className="odin-transport-error">{shortText(transportError, 72)}</p> : null}
          </div>
        </div>

        <button type="button" className="odin-content-calendar" onClick={() => setActiveTab("calendar")}>
          <div className="odin-calendar-meeting-mini-list">
            {upcomingMeetings.length === 0 ? (
              <p className="odin-calendar-title-main">No meetings scheduled</p>
            ) : (
              upcomingMeetings.slice(0, 2).map((event, index) => {
                const start = eventStart(event)
                const time = start ? formatClock(start) : "--:--"
                const zone = shortText(eventTimezone(event), 22)
                return (
                  <div key={`${event.id || event.summary || "meeting"}-${index}`} className="odin-calendar-mini-row">
                    <span className="odin-calendar-mini-row-time">{time}</span>
                    <span className="odin-calendar-mini-row-title">{shortText(event.summary, 42) || "Untitled meeting"}</span>
                    <span className="odin-calendar-mini-row-zone">{zone}</span>
                  </div>
                )
              })
            )}
          </div>
        </button>
      </section>

      <section className="odin-content-right odin-content-right-stack">
        <div className="odin-content-transport" aria-label="Music transport controls">
          <button type="button" className="odin-media-btn" onClick={(event) => handleMusicControl(event, "previous")} disabled={transportBusy !== null}><SkipBack size={11} /></button>
          <button type="button" className="odin-media-btn odin-media-btn-main" onClick={(event) => handleMusicControl(event, "toggle")} disabled={transportBusy !== null}>
            {isPlaying ? <Pause size={12} /> : <Play size={12} />}
          </button>
          <button type="button" className="odin-media-btn" onClick={(event) => handleMusicControl(event, "next")} disabled={transportBusy !== null}><SkipForward size={11} /></button>
        </div>

        <button type="button" className="odin-content-priority" onClick={() => setActiveTab("priority")}>
          <p className="odin-main-kicker"><span className="odin-priority-dot" />Priority</p>
          <p className="odin-priority-count-main">{criticalCount}<span className="odin-priority-count-divider">·</span><span className="odin-priority-count-soft">{normalCount}</span></p>
          <div className="odin-priority-source-row">
            <span className="odin-priority-source-chip" title="Slack open priorities">
              <img src="/odin-core/slack.svg" alt="" className="odin-priority-source-icon" aria-hidden="true" />
              {prioritySourceCounts.slack}
            </span>
            <span className="odin-priority-source-chip" title="Gmail open priorities">
              <img src="/odin-core/gmail.svg" alt="" className="odin-priority-source-icon" aria-hidden="true" />
              {prioritySourceCounts.gmail}
            </span>
          </div>
        </button>

        <div className="odin-content-apps" aria-label="App shortcuts">
          <button type="button" className="odin-content-app-btn" onClick={() => openPath("downloads")} title="Downloads">
            <Download size={14} />
            <span>Downloads</span>
          </button>
          <button type="button" className="odin-content-app-btn" onClick={() => openPath("screenshots")} title="Screenshots">
            <FileText size={14} />
            <span>Screenshots</span>
          </button>
          <button type="button" className="odin-content-app-btn" onClick={() => openPath("documents")} title="Documents">
            <Folder size={14} />
            <span>Documents</span>
          </button>
          <button type="button" className="odin-content-app-btn" onClick={() => openPath("/Applications/Figma.app")} title="Figma">
            <span className="odin-main-app-icon-text">F</span>
            <span>Figma</span>
          </button>
          <button type="button" className="odin-content-app-btn" onClick={() => openPath("/Applications/Visual Studio Code.app")} title="VS Code">
            <span className="odin-main-app-icon-text">VS</span>
            <span>VS Code</span>
          </button>
          <button type="button" className="odin-content-app-btn odin-main-app-add" onClick={() => setShortcutPickerOpen(true)} title="Add app">
            <Plus size={14} />
            <span>Add App</span>
          </button>
        </div>
      </section>
    </>
  )

  const renderPriorityTab = () => (
    <div className="odin-detail-panel">
      <p className="odin-detail-kicker"><AlertTriangle size={11} />Priority snapshot</p>
      <div className="odin-priority-list">
        {openPrioritySignals.length === 0 ? <p className="odin-empty">No open priorities right now</p> : null}
        {openPrioritySignals.slice(0, 7).map((item, index) => (
          <button
            key={`${item.id ?? item.title}-${index}`}
            type="button"
            className="odin-priority-row"
            onClick={() => openRoute("/council")}
          >
            <span className="odin-priority-row-title">{shortText(item.title, 84)}</span>
            <span className="odin-priority-row-meta">{shortText(item.person ?? item.business ?? item.source ?? "Ops", 24)} · {item.category === "urgent" ? "Urgent" : "Normal"}</span>
          </button>
        ))}
      </div>
    </div>
  )

  const renderQuickAccessTab = () => (
    <div className="odin-detail-panel">
      <p className="odin-detail-kicker"><FolderOpen size={11} />Quick access</p>
      <div className="odin-shortcuts-list">
        <button type="button" className="odin-shortcut-row" onClick={() => openPath("downloads")}>
          <span className="odin-shortcut-label"><Download size={12} />Downloads</span>
          <ChevronRight size={11} />
        </button>
        <button type="button" className="odin-shortcut-row" onClick={() => openPath("screenshots")}>
          <span className="odin-shortcut-label"><FileText size={12} />Screenshots</span>
          <ChevronRight size={11} />
        </button>
        <button type="button" className="odin-shortcut-row" onClick={() => openPath("documents")}>
          <span className="odin-shortcut-label"><Folder size={12} />Documents</span>
          <ChevronRight size={11} />
        </button>
        <button type="button" className="odin-shortcut-row" onClick={() => openPath("recent")}>
          <span className="odin-shortcut-label"><FolderOpen size={12} />Recent files</span>
          <span className="odin-shortcut-trailing">{recentFiles.length > 0 ? Math.min(recentFiles.length, 99) : ""}<ChevronRight size={11} /></span>
        </button>
      </div>
    </div>
  )

  const renderCalendarTab = () => (
    <div className="odin-detail-panel">
      <div className="odin-calendar-toolbar">
        <button type="button" className="odin-nav-btn" onClick={() => setViewedDate((current) => addDays(current, -1))}><ChevronLeft size={12} />Prev</button>
        <p className="odin-calendar-day-title">{dayTitle}</p>
        <button type="button" className="odin-nav-btn" onClick={() => setViewedDate((current) => addDays(current, 1))}>Next<ChevronRight size={12} /></button>
      </div>
      <div className="odin-calendar-today-wrap">
        <button type="button" className="odin-nav-btn" onClick={() => setViewedDate(new Date())}>Today</button>
      </div>
      <div
        ref={calendarScrollRef}
        className="odin-calendar-list"
        onPointerDown={(event) => { swipeStartXRef.current = event.clientX }}
        onPointerUp={(event) => {
          const startX = swipeStartXRef.current
          if (startX == null) return
          const delta = event.clientX - startX
          if (Math.abs(delta) >= 50) setViewedDate((current) => addDays(current, delta > 0 ? -1 : 1))
          swipeStartXRef.current = null
        }}
      >
        {dayLoading ? <p className="odin-empty">Loading meetings…</p> : null}
        {!dayLoading && dayEvents.length === 0 ? <p className="odin-empty">No meetings today</p> : null}
        {!dayLoading
          ? dayEvents.map((event, index) => {
            const start = eventStart(event)
            const timezone = eventTimezone(event)
            return (
              <button key={`${event.id || event.summary || "event"}-${index}`} type="button" className="odin-calendar-row" onClick={() => openRoute("/calendar")}>
                <span className="odin-calendar-row-time">{start ? formatClock(start) : "--:--"}</span>
                <span className="odin-calendar-row-zone">{shortText(timezone, 22)}</span>
                <span className="odin-calendar-row-title">{shortText(event.summary, 78) || "Untitled meeting"}</span>
              </button>
            )
          })
          : null}
      </div>
    </div>
  )

  const renderActiveTab = () => {
    if (activeTab === "odin") return renderOdinTab()
    if (activeTab === "priority") return renderPriorityTab()
    if (activeTab === "quickAccess") return renderQuickAccessTab()
    return renderCalendarTab()
  }

  const sessionLabel = sessionState === "ready" ? "Ready" : sessionState === "checking" ? "Syncing" : "Quiet"
  const notchGeometry = typeof window === "undefined"
    ? null
    : (window as Window & { __ODIN_NOTCH_GEOMETRY__?: { notchWidth?: number; notchHeight?: number } }).__ODIN_NOTCH_GEOMETRY__ ?? null
  const notchWidth = Math.max(notchGeometry?.notchWidth ?? NOTCH_WIDTH_FALLBACK, NOTCH_WIDTH_FALLBACK)
  const notchHeight = Math.max(notchGeometry?.notchHeight ?? NOTCH_HEIGHT_FALLBACK, NOTCH_HEIGHT_FALLBACK)
  const panelWidth = typeof window === "undefined" ? 1180 : window.innerWidth
  const protectedZoneWidth = notchWidth + NOTCH_SAFE_PADDING_X
  // The signal row uses the larger of notchHeight + 32 or 56 so the physical notch plus breathing room stays black-only.
  const protectedZoneHeight = Math.max(notchHeight + 32, 56)
  const protectedZoneLeft = Math.max(0, (panelWidth - protectedZoneWidth) / 2)
  const notchZoneStyle = {
    "--notch-zone-w": `${protectedZoneWidth}px`,
    "--notch-zone-h": `${protectedZoneHeight}px`,
    "--notch-zone-left": `${protectedZoneLeft}px`,
    "--notch-zone-right": `${protectedZoneLeft + protectedZoneWidth}px`,
  } as CSSProperties

  return (
    <main className="h-screen w-screen bg-transparent text-white">
      <style>{notchTrayCss}</style>
      <section className="odin-shell" style={notchZoneStyle} onMouseEnter={handleHoverEnter} onMouseLeave={handleHoverLeave}>
        <div className="odin-notch-panel" style={notchZoneStyle}>
          <header className="odin-signal-row">
            <div className="odin-signal-left">
              <div className="odin-tab-list">
                {[
                  { key: "odin", label: "ODIN" },
                  { key: "priority", label: "PRIORITY" },
                  { key: "calendar", label: "CALENDAR" },
                  { key: "quickAccess", label: "QUICK ACCESS" },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`odin-tab-btn ${activeTab === tab.key ? "is-active" : ""}`}
                    onClick={() => setActiveTab(tab.key as NotchTab)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="odin-signal-notch-void" aria-hidden="true" />
            <div className="odin-signal-right" ref={shortcutPickerRef}>
              <button type="button" className="odin-icon-btn" onClick={triggerLiveScan} title="Live scan refresh"><RefreshCw size={13} /></button>
              <button type="button" className="odin-icon-btn" onClick={() => openRoute("/settings")} title="Settings"><Settings2 size={13} /></button>
              <button
                type="button"
                className="odin-icon-btn"
                title="Add app shortcut"
                onClick={() => {
                  void postOdinAction("listInstalledApps")
                  setShortcutPickerOpen((open) => !open)
                }}
              >
                <Plus size={12} />
              </button>
              {isShortcutPickerOpen ? (
                <div className="odin-shortcut-picker" role="menu" aria-label="Add quick access app">
                  <p className="odin-shortcut-picker-title">Add quick app</p>
                  {availableShortcutCandidates.length === 0 ? (
                    <p className="odin-shortcut-picker-empty">All shortcuts already added</p>
                  ) : (
                    <div className="odin-shortcut-picker-list">
                      {availableShortcutCandidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          className="odin-shortcut-picker-item"
                          onClick={() => addShortcut(candidate.id)}
                        >
                          <span className="odin-shortcut-picker-item-left">
                            <span className="odin-main-app-icon">{renderShortcutGlyph(candidate)}</span>
                            <span>{candidate.label}</span>
                          </span>
                          <Plus size={10} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </header>

          <section className={`odin-content-row odin-tab-body ${activeTab === "odin" ? "is-compact" : "is-detail"}`}>
            {renderActiveTab()}
          </section>
        </div>

        {import.meta.env.DEV && (
          <div
            className="odin-notch-debug-protected-zone"
            style={{
              position: "absolute",
              top: 0,
              left: "var(--notch-zone-left)",
              width: "var(--notch-zone-w)",
              height: "var(--notch-zone-h)",
              border: "1px solid rgba(255,0,0,0.5)",
              pointerEvents: "none",
              zIndex: 9999,
            }}
          />
        )}

        <span className="sr-only">{sessionLabel}</span>
      </section>
    </main>
  )
}

const notchTrayCss = `
html, body, #root {
  margin: 0;
  background: #000;
  overflow: hidden;
}

.odin-shell {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 8px 16px;
  background: #000;
  border: 1px solid rgba(255,255,255,0.10);
  border-top: 0;
  border-radius: 0 0 14px 14px;
  box-shadow: 0 18px 36px rgba(0,0,0,0.52), inset 0 1px 0 rgba(255,255,255,0.08);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.odin-top-row {
  --notch-gap-width: 220px;
  height: 32px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--notch-gap-width) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.odin-header-left { display: flex; justify-content: flex-start; }
.odin-header-right { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.odin-header-deadzone {
  height: 100%;
  border-radius: 10px;
  background: transparent;
}

.odin-chip {
  height: 28px;
  min-width: 128px;
  border: 0;
  border-radius: 999px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #fff;
  cursor: pointer;
}
.odin-chip-brand {
  background: linear-gradient(180deg, rgba(255,255,255,0.11), rgba(255,255,255,0.06));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.09);
  border: 1px solid rgba(255,255,255,0.11);
}
.odin-chip-label {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: #f0a22e;
}

.odin-status-pulse {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #f0a22e;
  box-shadow: 0 0 12px rgba(240,162,46,0.85);
  animation: odinPulse 2s ease-in-out infinite;
}

.odin-health-strip {
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.08);
}
.odin-health-strip span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 800;
  color: rgba(255,255,255,0.8);
}

.odin-icon-btn {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: rgba(255,255,255,0.12);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.odin-tab-row {
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.odin-tab-list {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.odin-tab-btn {
  height: 24px;
  border: 0;
  border-radius: 999px;
  background: rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.72);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .1em;
  text-transform: uppercase;
  padding: 0 16px;
}
.odin-tab-btn.is-active {
  background: rgba(255,255,255,0.2);
  color: #fff;
}

.odin-tab-plus-btn {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 999px;
  background: rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.9);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.odin-tab-plus-btn:hover {
  background: rgba(255,255,255,0.2);
}
.odin-tab-plus-btn:disabled {
  opacity: 0.45;
}

.odin-tab-plus-wrap {
  position: relative;
}

.odin-shortcut-picker {
  position: absolute;
  top: 30px;
  right: 0;
  min-width: 220px;
  max-width: 280px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(10,10,10,0.98);
  box-shadow: 0 12px 24px rgba(0,0,0,0.45);
  padding: 8px;
  z-index: 30;
}

.odin-shortcut-picker-title {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.68);
}

.odin-shortcut-picker-empty {
  margin: 0;
  font-size: 10px;
  color: rgba(255,255,255,0.5);
}

.odin-shortcut-picker-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.odin-shortcut-picker-item {
  width: 100%;
  min-height: 28px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  background: rgba(255,255,255,0.06);
  color: #fff;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
}
.odin-shortcut-picker-item-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.odin-shortcut-picker-item:hover {
  background: rgba(255,255,255,0.14);
}

.odin-tab-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.odin-tab-body.is-compact {
  min-height: 148px;
}
.odin-tab-body.is-detail {
  min-height: 196px;
}


.odin-main-music {
  display: grid;
  grid-template-columns: 54px minmax(0,1fr);
  gap: 8px;
  min-height: 0;
}
.odin-main-music.is-idle { opacity: .8; }

.odin-art-wrap {
  width: 54px;
  height: 54px;
  position: relative;
}
.odin-art {
  width: 54px;
  height: 54px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.12);
}
.odin-art-fallback {
  background: rgba(255,255,255,0.08);
  display: grid;
  place-items: center;
}
.odin-source-badge {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: #1DB954;
  border: 1px solid rgba(0,0,0,0.45);
  display: grid;
  place-items: center;
}
.odin-spotify-glyph {
  width: 10px;
  height: 10px;
  fill: #00110A;
}

.odin-music-meta {
  min-width: 0;
}
.odin-track-title {
  margin: 0;
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.odin-track-artist {
  margin: 2px 0 0;
  font-size: 10px;
  font-weight: 700;
  color: rgba(255,255,255,0.62);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-transport-row {
  margin-top: 5px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.odin-media-btn {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 999px;
  background: rgba(255,255,255,0.13);
  color: rgba(255,255,255,0.9);
  display: grid;
  place-items: center;
}
.odin-media-btn-main {
  width: 28px;
  height: 28px;
  background: rgba(255,255,255,0.18);
  color: #fff;
}
.odin-media-btn:disabled {
  opacity: .6;
  cursor: wait;
}

.odin-progress {
  margin-top: 5px;
  height: 3px;
  border-radius: 999px;
  background: rgba(255,255,255,0.16);
  overflow: hidden;
  width: 100%;
  max-width: 132px;
}
.odin-progress-fill {
  height: 100%;
  border-radius: 999px;
}
.odin-progress-fill.is-playing { width: 58%; background: #f0a22e; }
.odin-progress-fill.is-paused { width: 36%; background: rgba(240,162,46,0.58); }

.odin-open-btn {
  margin-top: 8px;
  height: 24px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.9);
  font-size: 10px;
  font-weight: 800;
  padding: 0 10px;
}

.odin-main-calendar,
.odin-main-priority {
  border: 0;
  background: transparent;
  color: #fff;
  text-align: left;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.odin-main-kicker {
  margin: 0 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .11em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.7);
}

.odin-day-label {
  margin: 0;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.65);
}
.odin-calendar-date-line {
  margin: 0;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.62);
}
.odin-calendar-title-main {
  margin: 8px 0 0;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.25;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.odin-calendar-meta-main {
  margin: 6px 0 0;
  font-size: 10px;
  font-weight: 700;
  color: rgba(255,255,255,0.58);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.odin-calendar-meeting-mini-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.odin-calendar-mini-row {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 10px;
  align-items: start;
}
.odin-calendar-mini-row-time {
  grid-column: 1;
  grid-row: 1 / span 2;
  font-size: 11px;
  font-weight: 800;
  color: rgba(240,162,46,0.96);
}
.odin-calendar-mini-row-title {
  grid-column: 2;
  grid-row: 1;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.odin-calendar-mini-row-zone {
  grid-column: 2;
  grid-row: 2;
  font-size: 10px;
  color: rgba(255,255,255,0.56);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-priority-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #ff4c4c;
  box-shadow: 0 0 9px rgba(255,76,76,0.6);
}
.odin-priority-count-main {
  margin: 0;
  font-size: 18px;
  font-weight: 900;
  line-height: 1;
  color: #ff7575;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.odin-priority-count-divider {
  color: rgba(255,255,255,0.32);
  font-weight: 700;
}
.odin-priority-count-soft {
  font-size: 14px;
  color: rgba(255,255,255,0.78);
  font-weight: 800;
}
.odin-priority-source-row {
  margin-top: 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.odin-priority-source-chip {
  height: 24px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.07);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  font-size: 10px;
  font-weight: 800;
}
.odin-priority-source-icon {
  width: 12px;
  height: 12px;
  object-fit: contain;
}

.odin-detail-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.odin-detail-kicker {
  margin: 0 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .11em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.72);
}
.odin-main-apps {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: 20px minmax(0, 1fr) 20px;
  align-items: center;
  justify-items: stretch;
  gap: 6px;
  width: 100%;
  min-width: 176px;
  max-width: 200px;
  justify-self: end;
  align-self: stretch;
  padding-right: 2px;
  box-sizing: border-box;
}

.odin-main-app-scroll-btn {
  width: 100%;
  height: 20px;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 999px;
  background: rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.92);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.odin-main-app-scroll-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.2);
}
.odin-main-app-scroll-btn:disabled {
  opacity: 0.38;
  cursor: default;
}

.odin-main-app-viewport {
  width: 100%;
  max-height: 132px;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
}

.odin-main-app-icon-btn {
  width: 100%;
  min-height: 60px;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 14px;
  background: rgba(255,255,255,0.09);
  color: rgba(255,255,255,0.94);
  display: grid;
  grid-template-rows: 34px auto;
  align-items: center;
  justify-content: center;
  padding: 5px 6px;
  cursor: pointer;
}

.odin-main-app-icon-btn:hover {
  background: rgba(255,255,255,0.14);
}
.odin-main-app-icon-btn-only {
  justify-content: center;
}

.odin-main-app-label {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.82);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-main-app-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.odin-main-app-icon-stack {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
}

.odin-main-app-icon-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 900;
  color: rgba(255,255,255,0.92);
}

.odin-main-app-icon-img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}
.odin-main-app-icon-img-app {
  width: 32px;
  height: 32px;
  border-radius: 6px;
}

.odin-main-app-icon svg {
  width: 20px;
  height: 20px;
}

.odin-main-app-empty {
  display: grid;
  place-items: center;
  width: 100%;
  height: 52px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.45);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.odin-priority-list,
.odin-calendar-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.odin-priority-row,
.odin-calendar-row,
.odin-shortcut-row {
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 12px;
  background: rgba(255,255,255,0.05);
  color: #fff;
}

.odin-priority-row {
  width: 100%;
  text-align: left;
  padding: 8px 10px;
}
.odin-priority-row-title {
  display: block;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.odin-priority-row-meta {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  color: rgba(255,255,255,0.58);
}

.odin-shortcuts-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.odin-shortcut-row {
  width: 100%;
  text-align: left;
  min-height: 34px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.odin-shortcut-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 800;
}
.odin-shortcut-trailing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 800;
  color: rgba(255,255,255,0.72);
}

.odin-file-row {
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.odin-file-name {
  font-size: 11px;
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.odin-file-meta {
  font-size: 9px;
  color: rgba(255,255,255,0.58);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-calendar-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.odin-calendar-day-title {
  margin: 0;
  font-size: 12px;
  font-weight: 800;
}
.odin-calendar-today-wrap {
  margin-top: 6px;
  display: flex;
  justify-content: center;
}
.odin-nav-btn {
  height: 24px;
  border: 0;
  border-radius: 999px;
  background: rgba(255,255,255,0.14);
  color: #fff;
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 800;
}

.odin-calendar-row {
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  display: grid;
  grid-template-columns: 74px 126px 1fr;
  gap: 8px;
  align-items: center;
}
.odin-calendar-row-time {
  font-size: 11px;
  font-weight: 800;
  color: rgba(240,162,46,0.96);
}
.odin-calendar-row-zone {
  font-size: 9px;
  font-weight: 700;
  color: rgba(255,255,255,0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.odin-calendar-row-title {
  font-size: 11px;
  font-weight: 800;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-empty {
  margin: auto 0;
  text-align: center;
  font-size: 11px;
  color: rgba(255,255,255,0.5);
}

.odin-transport-error {
  margin: 5px 0 0;
  font-size: 9px;
  color: rgba(255,126,126,0.92);
}

button { -webkit-appearance: none; }

/* Final notch-blend pass: pure-black shelf attached to the physical notch. */
.odin-shell {
  height: 100vh;
  box-sizing: border-box;
  background: #000;
  color: #f8f7f3;
  border: 0;
  border-top: 0;
  border-radius: 0 0 34px 34px;
  box-shadow: 0 18px 34px rgba(0,0,0,0.68);
  padding: 14px 22px 18px;
  overflow: hidden;
}

.odin-top-row {
  height: 30px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(190px, 22%) auto;
  align-items: center;
  gap: 12px;
  margin: 0 0 14px;
}

.odin-header-notch-void {
  height: 30px;
  min-width: 190px;
  background: #000;
  pointer-events: none;
}

.odin-tab-list {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  overflow: hidden;
}

.odin-tab-btn {
  height: 26px;
  min-width: 0;
  flex: 0 1 auto;
  border-radius: 999px;
  border: 0;
  background: rgba(255,255,255,0.11);
  color: rgba(255,255,255,0.74);
  box-shadow: none;
  padding: 0 13px;
  font-size: 9.5px;
  line-height: 1;
  font-weight: 900;
  letter-spacing: .15em;
  white-space: nowrap;
}

.odin-tab-btn.is-active {
  background: rgba(255,255,255,0.20);
  color: #fff;
}

.odin-header-actions {
  justify-self: end;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.odin-icon-btn,
.odin-tab-plus-btn {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  border: 0;
  background: rgba(255,255,255,0.10);
  color: rgba(255,255,255,0.90);
  display: inline-grid;
  place-items: center;
  box-shadow: none;
}

.odin-tab-body,
.odin-tab-body.is-compact {
  min-height: 0;
  height: calc(100vh - 62px);
  overflow: hidden;
}


.odin-main-music,
.odin-main-calendar,
.odin-main-priority,
.odin-main-apps {
  min-width: 0;
  padding-top: 2px;
  padding-bottom: 0;
}

.odin-main-music {
  display: grid;
  grid-template-columns: 82px minmax(0,1fr);
  column-gap: 14px;
  padding-right: 20px;
  align-content: start;
}

.odin-main-calendar,
.odin-main-priority,
.odin-main-apps {
  border-left: 1px solid rgba(255,255,255,0.065);
  padding-left: 20px;
}

.odin-art-wrap,
.odin-art {
  width: 76px;
  height: 76px;
  border-radius: 18px;
}

.odin-track-title {
  margin: 0 0 4px;
  max-width: 174px;
  font-size: 13px;
  line-height: 1.12;
  font-weight: 900;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-track-artist {
  margin: 0 0 11px;
  max-width: 174px;
  font-size: 10.5px;
  line-height: 1.12;
  font-weight: 800;
  color: rgba(255,255,255,0.56);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-transport-row {
  gap: 8px;
  margin: 0 0 10px;
}

.odin-media-btn {
  width: 30px;
  height: 30px;
  background: rgba(255,255,255,0.12);
}

.odin-progress {
  width: min(210px, 100%);
  height: 3px;
}

.odin-volume-row {
  display: none;
}

.odin-calendar-mini-row {
  display: grid;
  grid-template-columns: 70px minmax(0,1fr);
  column-gap: 10px;
  row-gap: 2px;
  align-items: baseline;
}

.odin-calendar-mini-row-time {
  color: #ff9f1a;
  font-size: 12px;
  font-weight: 900;
}

.odin-calendar-mini-row-title {
  color: #fff;
  font-size: 11px;
  font-weight: 900;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-calendar-mini-row-zone {
  grid-column: 2;
  font-size: 9px;
  color: rgba(255,255,255,0.52);
}

.odin-main-kicker,
.odin-apps-title {
  margin: 0 0 11px;
  font-size: 9px;
  line-height: 1;
  font-weight: 900;
  letter-spacing: .17em;
  color: rgba(255,255,255,0.52);
  text-transform: uppercase;
}

.odin-priority-count-main {
  margin: 0 0 10px;
  font-size: 22px;
  line-height: 1;
  font-weight: 900;
  color: #ff4c54;
}

.odin-priority-count-soft {
  color: rgba(255,255,255,0.72);
}

.odin-priority-source-row {
  display: flex;
  gap: 8px;
}

.odin-priority-source-chip {
  min-width: 38px;
  height: 24px;
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.08);
}

.odin-main-apps {
  display: grid;
  grid-template-columns: repeat(2, minmax(58px,1fr));
  grid-template-rows: auto repeat(3, 44px);
  grid-auto-rows: 44px;
  gap: 8px;
  align-content: start;
}

.odin-main-app-icon-btn {
  height: 44px;
  border-radius: 12px;
  border: 0;
  background: rgba(255,255,255,0.075);
  color: rgba(255,255,255,0.88);
  gap: 3px;
  padding: 5px 5px;
}

.odin-main-app-icon-btn svg {
  width: 14px;
  height: 14px;
}

.odin-main-app-icon-text,
.odin-main-app-label {
  max-width: 66px;
  font-size: 7.5px;
  line-height: 1.05;
  font-weight: 900;
  letter-spacing: .04em;
  color: rgba(255,255,255,0.84);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}


/* Reference rebuild: notch-attached full access surface. */
.odin-shell {
  height: 100vh;
  box-sizing: border-box;
  background: #000;
  color: #f8f7f3;
  border-radius: 0 0 30px 30px;
  border: 1px solid rgba(255,255,255,0.07);
  border-top: 0;
  box-shadow: 0 22px 58px rgba(0,0,0,0.74), inset 0 1px 0 rgba(255,255,255,0.05);
  padding: 24px 30px 26px;
  overflow: hidden;
}

.odin-top-row {
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin: 0 0 26px;
}

.odin-tab-list {
  display: flex;
  align-items: center;
  gap: 10px;
}

.odin-tab-btn {
  height: 30px;
  min-width: 100px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.07);
  background: rgba(255,255,255,0.10);
  color: rgba(255,255,255,0.74);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
  padding: 0 20px;
  font-size: 11px;
  line-height: 1;
  font-weight: 900;
  letter-spacing: .16em;
}

.odin-tab-btn.is-active {
  background: rgba(255,255,255,0.20);
  color: #fff;
  border-color: rgba(255,255,255,0.12);
}

.odin-header-actions {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.odin-icon-btn,
.odin-tab-plus-btn {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 0;
  background: rgba(255,255,255,0.10);
  color: rgba(255,255,255,0.90);
  display: inline-grid;
  place-items: center;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
}

.odin-tab-body,
.odin-tab-body.is-compact {
  min-height: 0;
  height: calc(100vh - 84px);
}


.odin-main-music,
.odin-main-calendar,
.odin-main-priority,
.odin-main-apps {
  min-width: 0;
  padding-top: 8px;
  padding-bottom: 2px;
}

.odin-main-music {
  display: grid;
  grid-template-columns: 120px minmax(0,1fr);
  column-gap: 22px;
  padding-right: 28px;
  align-content: start;
}

.odin-main-calendar,
.odin-main-priority,
.odin-main-apps {
  border-left: 1px solid rgba(255,255,255,0.085);
  padding-left: 28px;
}

.odin-main-apps {
  display: grid;
  grid-template-columns: repeat(2, minmax(74px,1fr));
  grid-template-rows: auto repeat(3, 64px);
  grid-auto-rows: 64px;
  gap: 9px;
  align-content: start;
}

.odin-column-title,
.odin-apps-title {
  margin: 0 0 16px;
  grid-column: 1 / -1;
  font-size: 10px;
  line-height: 1;
  font-weight: 900;
  letter-spacing: .18em;
  color: rgba(255,255,255,0.50);
  text-transform: uppercase;
}

.odin-priority-title {
  margin: 0 0 14px;
  display: flex;
  align-items: center;
  gap: 9px;
  color: rgba(255,255,255,0.64);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: .16em;
  text-transform: uppercase;
}

.odin-art-wrap,
.odin-art {
  width: 112px;
  height: 112px;
  border-radius: 22px;
}

.odin-art {
  object-fit: cover;
  box-shadow: 0 18px 34px rgba(0,0,0,0.44);
}

.odin-art-fallback {
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #f59a23 0%, #be2246 62%, #2c1027 100%);
  color: rgba(35,0,14,0.78);
}

.odin-track-meta {
  min-width: 0;
  align-self: start;
  padding-top: 8px;
}

.odin-track-title {
  margin: 0 0 5px;
  max-width: 210px;
  font-size: 15px;
  line-height: 1.15;
  font-weight: 900;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-track-artist {
  margin: 0 0 17px;
  max-width: 210px;
  font-size: 12px;
  line-height: 1.15;
  font-weight: 800;
  color: rgba(255,255,255,0.58);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-transport-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
}

.odin-media-btn {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 0;
  background: rgba(255,255,255,0.12);
  color: #fff;
  display: inline-grid;
  place-items: center;
}

.odin-progress {
  grid-column: 1 / -1;
  margin-top: 0;
  height: 3px;
  width: min(360px, 100%);
  background: rgba(255,255,255,0.14);
  border-radius: 999px;
  overflow: hidden;
}

.odin-progress-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #ff9f1a, #ffb03f);
}

.odin-volume-row {
  grid-column: 1 / -1;
  margin-top: 18px;
  width: min(300px, 100%);
  display: flex;
  align-items: center;
  gap: 10px;
  color: rgba(255,255,255,0.58);
}

.odin-volume-track {
  flex: 1;
  height: 3px;
  border-radius: 999px;
  background: rgba(255,255,255,0.14);
  overflow: hidden;
}

.odin-volume-fill {
  display: block;
  height: 100%;
  width: 62%;
  border-radius: inherit;
  background: #ff9f1a;
}

.odin-calendar-mini {
  display: grid;
  gap: 13px;
}

.odin-calendar-time {
  font-size: 15px;
  line-height: 1;
  color: #ff9f1a;
  font-weight: 900;
  white-space: nowrap;
}

.odin-calendar-title {
  font-size: 14px;
  line-height: 1.1;
  color: #fff;
  font-weight: 900;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-calendar-zone {
  margin-top: 4px;
  font-size: 10px;
  font-weight: 800;
  color: rgba(255,255,255,0.50);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-priority-total {
  margin: 0 0 14px;
  color: #fff;
  font-size: 22px;
  line-height: 1.05;
  font-weight: 900;
  letter-spacing: -.02em;
}

.odin-priority-total .urgent {
  color: #ff4c54;
}

.odin-priority-total .normal {
  color: rgba(255,255,255,0.74);
}

.odin-priority-chips {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 18px;
}

.odin-priority-chip {
  min-width: 42px;
  height: 28px;
  border-radius: 999px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.09);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #fff;
  font-size: 11px;
  font-weight: 900;
}

.odin-priority-items {
  display: grid;
  gap: 10px;
}

.odin-priority-item {
  display: grid;
  grid-template-columns: 8px minmax(0,1fr) auto;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 800;
  color: rgba(255,255,255,0.78);
}

.odin-priority-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
}

.odin-priority-label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-priority-level {
  color: rgba(255,255,255,0.48);
  font-size: 10px;
  font-weight: 800;
}

.odin-main-app-icon-btn {
  min-width: 0;
  min-height: 0;
  height: 64px;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.07);
  color: rgba(255,255,255,0.90);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 6px;
}

.odin-main-app-icon {
  width: 28px;
  height: 28px;
  border-radius: 10px;
  background: rgba(255,255,255,0.08);
  display: grid;
  place-items: center;
}

.odin-main-app-icon-text {
  max-width: 92px;
  font-size: 9px;
  line-height: 1.05;
  font-weight: 900;
  color: rgba(255,255,255,0.88);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.odin-main-app-label {
  max-width: 82px;
  font-size: 8.5px;
  line-height: 1.05;
  font-weight: 900;
  letter-spacing: .04em;
  color: rgba(255,255,255,0.86);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Winning final pass: keep the installed surface pure-black, low, and notch-attached. */
.odin-shell {
  height: 100vh;
  box-sizing: border-box;
  background: #000;
  color: #f8f7f3;
  border: 0;
  border-top: 0;
  border-radius: 0 0 34px 34px;
  box-shadow: 0 18px 34px rgba(0,0,0,0.68);
  padding: 14px 22px 18px;
  overflow: hidden;
}

.odin-top-row {
  height: 30px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(190px, 22%) auto;
  align-items: center;
  gap: 12px;
  margin: 0 0 14px;
}

.odin-header-notch-void {
  height: 30px;
  min-width: 190px;
  background: #000;
  pointer-events: none;
}

.odin-tab-list {
  min-width: 0;
  justify-content: flex-start;
  gap: 8px;
  overflow: hidden;
}

.odin-tab-btn {
  height: 26px;
  min-width: 0;
  flex: 0 1 auto;
  border: 0;
  background: rgba(255,255,255,0.11);
  box-shadow: none;
  padding: 0 13px;
  font-size: 9.5px;
}

.odin-icon-btn,
.odin-tab-plus-btn {
  width: 30px;
  height: 30px;
  border: 0;
  background: rgba(255,255,255,0.10);
  box-shadow: none;
}

.odin-tab-body,
.odin-tab-body.is-compact {
  height: calc(100vh - 62px);
  overflow: hidden;
}


.odin-main-music {
  grid-template-columns: 82px minmax(0,1fr);
  column-gap: 14px;
  padding-right: 20px;
}

.odin-main-calendar,
.odin-main-priority,
.odin-main-apps {
  border-left-color: rgba(255,255,255,0.065);
  padding-left: 20px;
}

.odin-art-wrap,
.odin-art {
  width: 76px;
  height: 76px;
  border-radius: 18px;
}

.odin-track-title {
  max-width: 174px;
  font-size: 13px;
}

.odin-track-artist {
  max-width: 174px;
  margin-bottom: 11px;
  font-size: 10.5px;
}

.odin-media-btn {
  width: 30px;
  height: 30px;
}

.odin-progress {
  width: min(210px, 100%);
  height: 3px;
}

.odin-volume-row {
  display: none;
}

.odin-main-apps {
  grid-template-columns: repeat(2, minmax(58px,1fr));
  grid-template-rows: auto repeat(3, 44px);
  grid-auto-rows: 44px;
  gap: 8px;
}

.odin-main-app-icon-btn {
  height: 44px;
  border: 0;
  border-radius: 12px;
  background: rgba(255,255,255,0.075);
  gap: 3px;
  padding: 5px;
}

.odin-main-app-icon-btn svg {
  width: 14px;
  height: 14px;
}

.odin-main-app-icon-text,
.odin-main-app-label {
  max-width: 66px;
  font-size: 7.5px;
}

/* Protected notch-lane geometry: nothing readable/clickable under the real notch. */
.odin-shell {
  padding: 10px 18px 16px;
}

.odin-top-row {
  height: 42px;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 32%) minmax(0, 1fr);
  gap: 10px;
  margin: 0 0 36px;
}

.odin-header-notch-void {
  min-width: 280px;
  height: 42px;
}

.odin-tab-list,
.odin-header-actions {
  align-self: start;
}

.odin-header-actions {
  justify-self: end;
}

.odin-tab-body,
.odin-tab-body.is-compact {
  height: calc(100vh - 104px);
}

@keyframes odinPulse {
  0%, 100% { transform: scale(1); opacity: .66; }
  50% { transform: scale(1.18); opacity: 1; }
}

/* Structural protected-notch lane rebuild. The center signal cell is a true black void: no children, no decoration, no overflow. */
.odin-shell {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 0;
  background: #000;
  border: 0;
  border-radius: 0 0 18px 18px;
  box-shadow: 0 18px 38px rgba(0,0,0,0.62);
  display: block;
  overflow: hidden;
}

.odin-notch-panel {
  display: grid;
  grid-template-rows: var(--notch-zone-h) minmax(0, 1fr);
  grid-template-areas:
    "signal-row"
    "content-row";
  width: 100%;
  height: 100%;
  background: #000;
  overflow: hidden;
}

.odin-signal-row {
  grid-area: signal-row;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--notch-zone-w) minmax(0, 1fr);
  grid-template-areas: "sig-left notch-void sig-right";
  align-items: center;
  height: var(--notch-zone-h);
  background: #000;
  overflow: hidden;
}

.odin-signal-left {
  grid-area: sig-left;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  padding-right: 16px;
}

.odin-signal-notch-void {
  grid-area: notch-void;
  min-width: 0;
  width: var(--notch-zone-w);
  height: var(--notch-zone-h);
  background: #000;
  pointer-events: none;
}

.odin-signal-right {
  grid-area: sig-right;
  position: relative;
  display: flex;
  justify-content: flex-start;
  align-items: center;
  min-width: 0;
  overflow: visible;
  padding-left: 16px;
  gap: 8px;
}

.odin-signal-left .odin-tab-list {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  display: inline-flex;
  flex-wrap: nowrap;
  justify-content: flex-end;
}

.odin-signal-left .odin-tab-btn {
  flex: 0 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 13px;
  white-space: nowrap;
}

.odin-content-row {
  grid-area: content-row;
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-areas: "content-left content-right";
  align-items: center;
  min-height: 0;
  height: auto;
  padding: 0 24px 18px;
  gap: 18px;
  background: #000;
  overflow: hidden;
}

.odin-content-row.is-detail {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "content-left";
  padding-top: 0;
}

.odin-content-row.is-detail > .odin-detail-panel {
  grid-column: 1 / -1;
  width: 100%;
  min-width: 0;
}

.odin-content-left {
  grid-area: content-left;
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 14px;
}

.odin-content-right {
  grid-area: content-right;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  gap: 12px;
}

.odin-content-track {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 12px;
  flex: 1 1 260px;
}

.odin-content-left-stack .odin-art-wrap {
  width: 72px;
  height: 72px;
  flex: 0 0 72px;
}

.odin-content-left-stack .odin-art {
  width: 72px;
  height: 72px;
  border-radius: 18px;
}

.odin-content-left-stack .odin-music-meta {
  min-width: 0;
  flex: 1 1 auto;
}

.odin-content-left-stack .odin-track-title {
  margin: 0 0 3px;
  font-size: 17px;
  line-height: 1.05;
  font-weight: 900;
  color: #fff;
}

.odin-content-left-stack .odin-track-artist {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.1;
  font-weight: 800;
  color: rgba(255,255,255,0.62);
}

.odin-content-left-stack .odin-progress {
  width: min(220px, 100%);
  height: 4px;
  margin: 0;
  background: rgba(255,255,255,0.14);
}

.odin-content-calendar {
  flex: 0 1 270px;
  min-width: 190px;
  border: 0;
  border-left: 1px solid rgba(255,255,255,0.09);
  background: transparent;
  color: #fff;
  padding: 4px 0 4px 18px;
  text-align: left;
}

.odin-content-calendar .odin-calendar-meeting-mini-list {
  gap: 8px;
}

.odin-content-calendar .odin-calendar-mini-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  grid-template-areas:
    "time title"
    "time zone";
  gap: 0 12px;
}

.odin-content-calendar .odin-calendar-mini-row-time { grid-area: time; color: #ff9f1a; font-size: 13px; font-weight: 900; }
.odin-content-calendar .odin-calendar-mini-row-title { grid-area: title; color: #fff; font-size: 12px; font-weight: 850; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.odin-content-calendar .odin-calendar-mini-row-zone { grid-area: zone; color: rgba(255,255,255,0.52); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.odin-content-transport {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.odin-content-priority {
  flex: 0 1 165px;
  min-width: 145px;
  border: 0;
  border-left: 1px solid rgba(255,255,255,0.09);
  background: transparent;
  color: #fff;
  padding: 4px 0 4px 18px;
  text-align: left;
}

.odin-content-priority .odin-main-kicker { margin: 0 0 8px; font-size: 10px; }
.odin-content-priority .odin-priority-count-main { margin: 0 0 8px; font-size: 24px; }

.odin-content-apps {
  display: grid;
  grid-template-columns: repeat(3, minmax(58px, 1fr));
  gap: 8px;
  width: min(260px, 36vw);
  min-width: 190px;
  padding-left: 18px;
  border-left: 1px solid rgba(255,255,255,0.09);
}

.odin-content-app-btn {
  min-width: 0;
  height: 54px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px;
  background: rgba(255,255,255,0.065);
  color: #fff;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 8px;
  font-weight: 900;
  letter-spacing: .02em;
  text-transform: uppercase;
}

.odin-content-app-btn span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.odin-notch-debug-protected-zone {
  box-sizing: border-box;
}

`

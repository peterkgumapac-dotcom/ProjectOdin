import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { AuthProvider, useAuth } from "@/hooks/useAuth"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import { OdinNotchOverlay } from "@/pages/OdinNotchOverlay"
import {
  MUSIC_STATE_EVENT,
  MUSIC_STATE_KEY,
  loadMusicState,
  saveMusicState,
  type MusicTrack,
} from "@/lib/musicState"
import {
  currentPlayback,
  invalidateCurrentPlaybackCache,
} from "@/lib/connectors/spotify"

const Login = lazy(() => import("@/pages/Login").then((module) => ({ default: module.Login })))
const Dashboard = lazy(() => import("@/pages/Dashboard").then((module) => ({ default: module.Dashboard })))
const Connections = lazy(() => import("@/pages/Connections").then((module) => ({ default: module.Connections })))
const Council = lazy(() => import("@/pages/Council").then((module) => ({ default: module.Council })))
const CalendarPage = lazy(() => import("@/pages/Calendar").then((module) => ({ default: module.CalendarPage })))
const HealthPage = lazy(() => import("@/pages/Health").then((module) => ({ default: module.HealthPage })))
const BrowserPage = lazy(() => import("@/pages/Browser").then((module) => ({ default: module.BrowserPage })))
const MusicPage = lazy(() => import("@/pages/Music").then((module) => ({ default: module.MusicPage })))
const IslandPage = lazy(() => import("@/pages/Island").then((module) => ({ default: module.IslandPage })))
const Settings = lazy(() => import("@/pages/Settings").then((module) => ({ default: module.Settings })))

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
      Loading...
    </div>
  )
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!session) return <Navigate to="/login" replace />
  return <>{children}</>
}

function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (session) return <Navigate to="/dashboard?portal=open" replace />
  return <>{children}</>
}

function MusicStateBridge() {
  const { spotify } = useConnectedAccounts()
  const lastSpotifySyncRef = useRef("")

  useEffect(() => {
    const publish = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      const desktopBridge = (
        window as Window & {
          odinDesktop?: { publishMusicState?: (payload: unknown) => Promise<unknown> | unknown }
        }
      ).odinDesktop
      if (!desktopBridge?.publishMusicState) return
      try {
        const raw = window.localStorage.getItem(MUSIC_STATE_KEY)
        if (!raw) return
        const parsed = JSON.parse(raw)
        void Promise.resolve(desktopBridge.publishMusicState(parsed)).catch(() => {
          // Best effort bridge sync for notch host.
        })
      } catch {
        // Ignore malformed storage payloads.
      }
    }

    publish()
    const timer = window.setInterval(publish, 5000)
    window.addEventListener("focus", publish)
    window.addEventListener("visibilitychange", publish)
    window.addEventListener(MUSIC_STATE_EVENT, publish)
    window.addEventListener("storage", publish)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", publish)
      window.removeEventListener("visibilitychange", publish)
      window.removeEventListener(MUSIC_STATE_EVENT, publish)
      window.removeEventListener("storage", publish)
    }
  }, [])

  useEffect(() => {
    if (!spotify.length) return

    const rememberRecentTrack = (history: MusicTrack[], track: MusicTrack) => {
      const key = track.uri || track.url || `${track.title}:${track.artist}`
      if (!key || (!track.uri && !track.url)) return history
      const next = [track, ...history.filter((item) => {
        const itemKey = item.uri || item.url || `${item.title}:${item.artist}`
        return itemKey !== key
      })]
      return next.slice(0, 32)
    }

    const syncFromSpotify = async () => {
      const accountId = spotify[0]?.id
      if (!accountId) return
      try {
        invalidateCurrentPlaybackCache(accountId)
        const playback = await currentPlayback(accountId)
        const nextTrack = playback.track
          ? {
              title: playback.track.title ?? "",
              artist: playback.track.artist ?? "",
              album: playback.track.album ?? "",
              url: playback.track.url ?? "",
              uri: playback.track.uri ?? "",
              imageUrl: playback.track.imageUrl ?? null,
              durationMs: playback.track.durationMs ?? null,
            }
          : null

        const syncSignature = [
          accountId,
          playback.isPlaying ? "1" : "0",
          String(Math.floor((playback.positionMs ?? 0) / 1000)),
          nextTrack?.uri || nextTrack?.url || "",
        ].join("|")
        if (lastSpotifySyncRef.current === syncSignature) return
        lastSpotifySyncRef.current = syncSignature

        const current = loadMusicState()
        const mergedCurrent = nextTrack ?? current.current
        saveMusicState({
          ...current,
          activeAccountId: accountId,
          current: mergedCurrent,
          recentTracks: nextTrack
            ? rememberRecentTrack(current.recentTracks ?? [], nextTrack)
            : current.recentTracks ?? [],
          playback: {
            ...current.playback,
            isPlaying: Boolean(playback.isPlaying),
            startedAt: playback.isPlaying
              ? Date.now() - Math.max(0, playback.positionMs ?? 0)
              : null,
            positionMs: Math.max(0, playback.positionMs ?? 0),
          },
        })
      } catch {
        // Keep UI resilient if Spotify polling fails transiently.
      }
    }

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void syncFromSpotify()
    }

    void syncFromSpotify()
    const timer = window.setInterval(tick, 3000)
    window.addEventListener("focus", tick)
    window.addEventListener("visibilitychange", tick)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", tick)
      window.removeEventListener("visibilitychange", tick)
    }
  }, [spotify])

  return null
}

export function App() {
  return (
    <AuthProvider>
      <MusicStateBridge />
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard?portal=open" replace />} />
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <Login />
              </RedirectIfAuthed>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/connections"
            element={
              <ProtectedRoute>
                <Connections />
              </ProtectedRoute>
            }
          />
          <Route
            path="/council"
            element={
              <ProtectedRoute>
                <Council />
              </ProtectedRoute>
            }
          />
          <Route
            path="/calendar"
            element={
              <ProtectedRoute>
                <CalendarPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/health"
            element={
              <ProtectedRoute>
                <HealthPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/browser"
            element={
              <ProtectedRoute>
                <BrowserPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/music"
            element={
              <ProtectedRoute>
                <MusicPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/island"
            element={<IslandPage />}
          />
          <Route
            path="/notch-tray"
            element={<OdinNotchOverlay />}
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard?portal=open" replace />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  )
}

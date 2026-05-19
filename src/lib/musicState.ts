import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react"

export const MUSIC_STATE_KEY = "odin.music.surface.v1"
export const MUSIC_STATE_EVENT = "odin:music-state"
const musicStateFallback = new Map<string, string>()

function isNotchTrayStorageContext(): boolean {
  if (typeof window === "undefined") return false
  return window.location.href.includes("/notch-tray")
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
    musicStateFallback.set(key, value)
  }
}

function safeGetItem(key: string): string | null {
  if (typeof window === "undefined") return null
  if (!isNotchTrayStorageContext()) {
    return window.localStorage.getItem(key)
  }
  try {
    return window.localStorage.getItem(key) ?? musicStateFallback.get(key) ?? null
  } catch {
    return musicStateFallback.get(key) ?? null
  }
}

export interface MusicTrack {
  title: string
  artist: string
  album: string
  url: string
  uri?: string
  imageUrl?: string | null
  durationMs?: number | null
}

export interface MusicPlaybackState {
  isPlaying: boolean
  startedAt: number | null
  positionMs: number
}

export interface MusicState {
  activeAccountId?: string
  playlistName: string
  playlistUrl: string
  mode: "focus" | "recovery" | "deep-work" | "night"
  current: MusicTrack
  recentTracks: MusicTrack[]
  playlistTracks: MusicTrack[]
  queue: MusicTrack[]
  playback: MusicPlaybackState
}

export const EMPTY_TRACK: MusicTrack = {
  title: "",
  artist: "",
  album: "",
  url: "",
  uri: "",
  imageUrl: null,
  durationMs: null,
}

export const DEFAULT_QUEUE: MusicTrack[] = []

export const DEFAULT_MUSIC_STATE: MusicState = {
  activeAccountId: "",
  playlistName: "Music Box Playlist",
  playlistUrl: "",
  mode: "focus",
  current: {
    title: "No track selected",
    artist: "Connect Spotify",
    album: "Ready for integration",
    url: "",
  },
  recentTracks: [],
  playlistTracks: [],
  queue: DEFAULT_QUEUE,
  playback: {
    isPlaying: false,
    startedAt: null,
    positionMs: 0,
  },
}

export function loadMusicState(): MusicState {
  try {
    const raw = safeGetItem(MUSIC_STATE_KEY)
    if (!raw) return DEFAULT_MUSIC_STATE
    const parsed = JSON.parse(raw) as Partial<MusicState>
    const playlistName =
      !parsed.playlistName || /focus/i.test(parsed.playlistName)
        ? DEFAULT_MUSIC_STATE.playlistName
        : parsed.playlistName
    return {
      activeAccountId:
        typeof parsed.activeAccountId === "string" ? parsed.activeAccountId : "",
      playlistName,
      playlistUrl: parsed.playlistUrl ?? "",
      mode: parsed.mode ?? "focus",
      current: {
        ...DEFAULT_MUSIC_STATE.current,
        ...(parsed.current ?? {}),
      },
      recentTracks:
        Array.isArray(parsed.recentTracks)
          ? parsed.recentTracks.map((track) => ({ ...EMPTY_TRACK, ...track }))
          : [],
      playlistTracks:
        Array.isArray(parsed.playlistTracks)
          ? parsed.playlistTracks.map((track) => ({ ...EMPTY_TRACK, ...track }))
          : [],
      queue:
        Array.isArray(parsed.queue) && parsed.queue.length > 0
          ? parsed.queue.map((track) => ({ ...EMPTY_TRACK, ...track }))
          : DEFAULT_QUEUE,
      playback: {
        ...DEFAULT_MUSIC_STATE.playback,
        ...(parsed.playback ?? {}),
      },
    }
  } catch {
    return DEFAULT_MUSIC_STATE
  }
}

export function saveMusicState(state: MusicState) {
  safeSetItem(MUSIC_STATE_KEY, JSON.stringify(state))
  const desktopBridge = (
    window as Window & {
      odinDesktop?: { publishMusicState?: (payload: unknown) => Promise<unknown> | unknown }
    }
  ).odinDesktop
  if (desktopBridge?.publishMusicState) {
    void Promise.resolve(desktopBridge.publishMusicState(state)).catch(() => {
      // Bridge delivery is best-effort. Local state remains canonical in this renderer.
    })
  }
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(MUSIC_STATE_EVENT, { detail: state }))
  }, 0)
}

export function useOdinMusicState(): MusicState {
  const [state, setState] = useState<MusicState>(() => loadMusicState())

  useEffect(() => {
    const refresh = () => setState(loadMusicState())
    window.addEventListener("storage", refresh)
    window.addEventListener(MUSIC_STATE_EVENT, refresh)
    return () => {
      window.removeEventListener("storage", refresh)
      window.removeEventListener(MUSIC_STATE_EVENT, refresh)
    }
  }, [])

  return state
}

export function useOdinMusicController(): [
  MusicState,
  Dispatch<SetStateAction<MusicState>>,
] {
  const [state, setState] = useState<MusicState>(() => loadMusicState())

  useEffect(() => {
    const refresh = () => setState(loadMusicState())
    window.addEventListener("storage", refresh)
    window.addEventListener(MUSIC_STATE_EVENT, refresh)
    return () => {
      window.removeEventListener("storage", refresh)
      window.removeEventListener(MUSIC_STATE_EVENT, refresh)
    }
  }, [])

  const setSyncedState = useCallback<Dispatch<SetStateAction<MusicState>>>(
    (next) => {
      setState((current) => {
        const value = typeof next === "function" ? next(current) : next
        saveMusicState(value)
        return value
      })
    },
    []
  )

  return [state, setSyncedState]
}

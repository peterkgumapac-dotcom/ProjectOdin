import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Loader2,
  Music2,
  Pause,
  Play,
  Repeat2,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import {
  currentPlayback,
  searchSpotify,
  pauseSpotify,
  playSpotify,
  nextSpotify,
  listSpotifyDevices,
  previousSpotify,
} from "@/lib/connectors/spotify"
import { spotifyReadinessFromError, spotifyReadinessMessage } from "@/lib/spotifyReadiness"
import {
  saveMusicState,
  useOdinMusicState,
  type MusicState,
  type MusicTrack,
} from "@/lib/musicState"

interface MusicBoxWidgetProps {
  variant?: "light" | "dark" | "lock"
  size?: "compact" | "mini" | "panel" | "wide"
  className?: string
  onOpen?: () => void
}

function formatTime(ms?: number | null, fallback = "--:--") {
  if (ms === null || typeof ms === "undefined" || ms < 0) return fallback
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function currentPosition(state: MusicState, now = Date.now()) {
  const duration = state.current.durationMs ?? 0
  const base = Math.max(0, state.playback.positionMs ?? 0)
  if (!state.playback.isPlaying || !state.playback.startedAt) return base
  const elapsed = Math.max(0, now - state.playback.startedAt)
  const position = base + elapsed
  return duration > 0 ? Math.min(position, duration) : position
}

function queueNeighbor(
  queue: MusicTrack[],
  current: MusicTrack,
  direction: "previous" | "next"
) {
  if (queue.length < 2) return current
  const currentIndex = queue.findIndex(
    (track) =>
      (track.uri && track.uri === current.uri) ||
      (track.url && track.url === current.url) ||
      (track.title === current.title && track.artist === current.artist)
  )
  const safeIndex = currentIndex >= 0 ? currentIndex : 0
  const nextIndex =
    direction === "next"
      ? (safeIndex + 1) % queue.length
      : (safeIndex - 1 + queue.length) % queue.length
  return queue[nextIndex] ?? current
}

function playableQueue(state: MusicState): MusicTrack[] {
  const seen = new Set<string>()
  return [state.current, ...state.queue].filter((track) => {
    if (!track.uri) return false
    const key = track.uri || `${track.title}:${track.artist}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function BeatSignal({ active, compact = false }: { active: boolean; compact?: boolean }) {
  return (
    <div
      className={[
        "odin-music-beat flex items-center justify-center gap-1",
        compact ? "h-5" : "h-8",
        active ? "is-playing" : "",
      ].join(" ")}
      aria-hidden="true"
    >
      {Array.from({ length: compact ? 16 : 22 }, (_, index) => (
        <span
          key={index}
          style={{
            animationDelay: `${index * -42}ms`,
            height: `${compact ? 4 + ((index * 5) % 12) : 7 + ((index * 7) % 19)}px`,
          }}
        />
      ))}
    </div>
  )
}

function WidgetArtwork({
  url,
  label,
  size,
  fallbackColor,
}: {
  url?: string | null
  label: string
  size: number
  fallbackColor: string
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(url ?? null)
  const [lastGoodUrl, setLastGoodUrl] = useState<string | null>(url ?? null)

  useEffect(() => {
    if (url) {
      setResolvedUrl(url)
      return
    }
    setResolvedUrl(lastGoodUrl)
  }, [lastGoodUrl, url])

  return (
    <span
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-2xl border border-white/10 bg-black/20"
      style={{ width: size, height: size }}
    >
      {resolvedUrl ? (
        <img
          src={resolvedUrl}
          alt={label}
          className="h-full w-full object-cover"
          loading="lazy"
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
        <Music2 size={Math.max(14, Math.round(size * 0.38))} style={{ color: fallbackColor }} />
      )}
    </span>
  )
}

export function MusicBoxWidget({
  variant = "light",
  size = variant === "lock" ? "wide" : "compact",
  className = "",
  onOpen,
}: MusicBoxWidgetProps) {
  const music = useOdinMusicState()
  const { spotify } = useConnectedAccounts()
  const activeAccount = useMemo(
    () =>
      spotify.find((account) => account.id === music.activeAccountId) ?? spotify[0],
    [music.activeAccountId, spotify]
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [shuffleEnabled, setShuffleEnabled] = useState(false)
  const [repeatEnabled, setRepeatEnabled] = useState(false)
  const isDark = variant === "dark"
  const isWide = size === "wide"
  const isMini = size === "mini"
  const isPanel = size === "panel"
  const hasLiveTrack = Boolean(music.current.uri)
  const isPlaying = hasLiveTrack ? music.playback.isPlaying : false
  const trackTitle = music.current.title || "No track selected"
  const trackArtist = music.current.artist || "Connect Spotify"
  const trackMeta = [trackArtist, music.current.album]
    .filter((value) => value && value !== "Ready for integration")
    .join(" · ")
  const playlist = music.playlistName || "ODIN Focus"
  const positionMs = currentPosition(music, now)
  const durationMs = music.current.durationMs ?? null
  const progress =
    durationMs && durationMs > 0
      ? Math.max(0, Math.min(100, (positionMs / durationMs) * 100))
      : 0

  useEffect(() => {
    if (!isPlaying) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isPlaying])

  const surfaceClass = isDark
    ? "border-[#27313b] bg-[#080c10]/86 text-[#f7f2e8]"
    : "border-[#ead9bd]/80 bg-[#fffaf1]/84 text-[#2b1d0f]"

  const mutedClass = isDark ? "text-[#a99f86]" : "text-[#6d5334]"
  const softClass = isDark ? "bg-[#141a20] text-[#e3b04f]" : "bg-[#f2d9c5] text-[#b6531c]"
  const actionClass = isDark
    ? "border-[#27313b] text-[#d6c9a8] hover:border-[#e3b04f]"
    : "border-[#dfcfb1] text-[#6d5334] hover:border-[#b6531c]/55"
  const primaryClass = isDark ? "bg-[#e3b04f] text-[#080c10]" : "bg-[#b6531c] text-white"
  const canControl = useMemo(() => Boolean(activeAccount?.id), [activeAccount?.id])

  const syncPlayback = (patch: Partial<MusicState["playback"]>, current = music.current) => {
    saveMusicState({
      ...music,
      activeAccountId: activeAccount?.id ?? music.activeAccountId ?? "",
      current,
      playback: {
        ...music.playback,
        ...patch,
      },
    })
  }

  const syncFromSpotify = useCallback(async () => {
    if (!activeAccount?.id) return
    try {
      const playback = await currentPlayback(activeAccount.id)
      const positionMs = Number.isFinite(playback.positionMs)
        ? Math.max(0, playback.positionMs)
        : music.playback.positionMs
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
        : music.current
      saveMusicState({
        ...music,
        activeAccountId: activeAccount.id,
        current: track,
        playback: {
          ...music.playback,
          isPlaying: Boolean(playback.isPlaying),
          startedAt: playback.isPlaying ? Date.now() - positionMs : null,
          positionMs,
        },
      })
      setNow(Date.now())
    } catch {
      // Keep existing state if live sync fails.
    }
  }, [activeAccount?.id, music, setNow])

  const playRandomRecommendation = async (accountId: string, deviceId: string | null) => {
    const queries = ["top hits", "new music", "chill", "rock", "hip hop", "pop"]
    const query = queries[Math.floor(Math.random() * queries.length)] ?? "music"
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
    const next = candidates[Math.floor(Math.random() * candidates.length)]
    if (!next?.uri) {
      throw new Error("No recommendation track available.")
    }
    await playSpotify(accountId, next.uri, deviceId)
    syncPlayback(
      {
        isPlaying: true,
        startedAt: Date.now(),
        positionMs: 0,
      },
      next
    )
  }

  useEffect(() => {
    if (!activeAccount?.id) return
    void syncFromSpotify()
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncFromSpotify()
      }
    }, 10000)
    const onFocus = () => {
      if (document.visibilityState === "visible") {
        void syncFromSpotify()
      }
    }
    window.addEventListener("focus", onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [activeAccount?.id, syncFromSpotify])

  const runPlayback = async (action: "play" | "pause" | "next" | "previous") => {
    if (!canControl) {
      setError("Connect Spotify first.")
      onOpen?.()
      return
    }
    if ((action === "play" || action === "pause") && !music.current.uri) {
      setError("Pick a Spotify track first.")
      onOpen?.()
      return
    }
    setBusy(action)
    setError(null)
    try {
      const deviceResult = await listSpotifyDevices(activeAccount.id)
      const deviceId =
        deviceResult.devices.find((device) => device.isActive)?.id ??
        deviceResult.devices.find((device) => device.id && !device.isRestricted)?.id ??
        null
    if (action === "play") {
        await playSpotify(activeAccount.id, music.current.uri, deviceId)
        syncPlayback({
          isPlaying: true,
          startedAt: Date.now(),
          positionMs: currentPosition(music),
        })
        await syncFromSpotify()
      }
      if (action === "pause") {
        await pauseSpotify(activeAccount.id, deviceId)
        syncPlayback({
          isPlaying: false,
          startedAt: null,
          positionMs: currentPosition(music),
        })
        await syncFromSpotify()
      }
      if (action === "next") {
        const queue = playableQueue(music)
        const alternatives = queue.filter((track) => track.uri !== music.current.uri)
        if (shuffleEnabled && alternatives.length > 0) {
          const target =
            alternatives[Math.floor(Math.random() * alternatives.length)]
          await playSpotify(activeAccount.id, target.uri, deviceId)
          syncPlayback(
            {
              isPlaying: true,
              startedAt: Date.now(),
              positionMs: 0,
            },
            target
          )
        } else if (queue.length >= 2) {
          const target = queueNeighbor(queue, music.current, "next")
          if (!target?.uri) {
            try {
              await nextSpotify(activeAccount.id, deviceId)
            } catch {
              await playRandomRecommendation(activeAccount.id, deviceId)
            }
            await syncFromSpotify()
            return
          }
          await playSpotify(activeAccount.id, target.uri, deviceId)
          syncPlayback(
            {
              isPlaying: true,
              startedAt: Date.now(),
              positionMs: 0,
            },
            target
          )
        } else {
          try {
            await nextSpotify(activeAccount.id, deviceId)
          } catch {
            await playRandomRecommendation(activeAccount.id, deviceId)
          }
        }
        await syncFromSpotify()
      }
      if (action === "previous") {
        const queue = playableQueue(music)
        const target = queueNeighbor(queue, music.current, "previous")
        if (queue.length >= 2 && target?.uri) {
          await playSpotify(activeAccount.id, target.uri, deviceId)
          syncPlayback(
            {
              isPlaying: true,
              startedAt: Date.now(),
              positionMs: 0,
            },
            target
          )
        } else {
          try {
            await previousSpotify(activeAccount.id, deviceId)
          } catch {
            await playRandomRecommendation(activeAccount.id, deviceId)
          }
        }
        await syncFromSpotify()
      }
    } catch (err) {
      const readiness = spotifyReadinessFromError(err)
      if (readiness === "no_device") {
        setError(spotifyReadinessMessage("no_device"))
      } else if (readiness === "policy_blocked") {
        setError(spotifyReadinessMessage("policy_blocked"))
      } else if (readiness === "needs_reconnect") {
        setError(spotifyReadinessMessage("needs_reconnect"))
      } else {
        setError("Spotify playback failed.")
      }
    } finally {
      setBusy(null)
    }
  }

  if (isDark && isWide) {
    return (
      <section
        className={[
          "flex min-h-[340px] flex-col justify-between rounded-3xl border border-[#181818] bg-[#050505] p-5 text-[#f5f5f5] shadow-[0_24px_60px_-44px_rgba(0,0,0,0.9)]",
          className,
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <WidgetArtwork
              url={music.current.imageUrl}
              label={trackTitle}
              size={86}
              fallbackColor="#d8d8d8"
            />
            <div className="min-w-0">
              <p className="font-mono-data text-[10px] font-bold uppercase tracking-[0.2em] text-[#9b9b9b]">
                Now Playing
              </p>
              <h3 className="mt-2 truncate text-3xl font-extrabold tracking-[-0.04em] text-white">
                {trackTitle}
              </h3>
              <p className="mt-2 truncate text-base font-semibold text-[#b8b8b8]">
                {trackMeta || playlist}
              </p>
            </div>
          </div>
          {onOpen && (
            <button
              type="button"
              onClick={onOpen}
              className="shrink-0 rounded-full border border-[#3a3a3a] px-4 py-2 text-xs font-bold uppercase tracking-[0.14em] text-[#d7d7d7] transition hover:border-white"
            >
              Open
            </button>
          )}
        </div>

        <div className="rounded-[28px] border border-[#151515] bg-black px-7 py-5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]">
          <div className="flex items-center justify-center gap-9">
            <button
              type="button"
              onClick={() => setShuffleEnabled((value) => !value)}
              className={[
                "grid h-9 w-9 place-items-center rounded-full transition",
                shuffleEnabled ? "text-white" : "text-[#787878] hover:text-[#c8c8c8]",
              ].join(" ")}
              aria-pressed={shuffleEnabled}
              aria-label="Shuffle queue"
              title="Shuffle queue"
            >
              <Shuffle size={22} />
            </button>
            <button
              type="button"
              onClick={() => void runPlayback("previous")}
              disabled={Boolean(busy)}
              className="grid h-9 w-9 place-items-center rounded-full text-[#d8d8d8] transition hover:text-white disabled:opacity-50"
              aria-label="Previous track"
              title="Previous track"
            >
              {busy === "previous" ? <Loader2 size={20} className="animate-spin" /> : <SkipBack size={24} fill="currentColor" />}
            </button>
            <button
              type="button"
              onClick={() => void runPlayback(isPlaying ? "pause" : "play")}
              disabled={Boolean(busy)}
              className="grid h-14 w-14 place-items-center rounded-full bg-white text-black transition hover:scale-[1.03] disabled:opacity-60"
              aria-label={isPlaying ? "Pause track" : "Play track"}
              title={isPlaying ? "Pause track" : "Play track"}
            >
              {busy === "play" || busy === "pause" ? (
                <Loader2 size={26} className="animate-spin" />
              ) : isPlaying ? (
                <Pause size={26} fill="currentColor" />
              ) : (
                <Play size={26} fill="currentColor" />
              )}
            </button>
            <button
              type="button"
              onClick={() => void runPlayback("next")}
              disabled={Boolean(busy)}
              className="grid h-9 w-9 place-items-center rounded-full text-[#d8d8d8] transition hover:text-white disabled:opacity-50"
              aria-label="Next track"
              title="Next track"
            >
              {busy === "next" ? <Loader2 size={20} className="animate-spin" /> : <SkipForward size={24} fill="currentColor" />}
            </button>
            <button
              type="button"
              onClick={() => setRepeatEnabled((value) => !value)}
              className={[
                "grid h-9 w-9 place-items-center rounded-full transition",
                repeatEnabled ? "text-white" : "text-[#787878] hover:text-[#c8c8c8]",
              ].join(" ")}
              aria-pressed={repeatEnabled}
              aria-label="Repeat current queue"
              title="Repeat current queue"
            >
              <Repeat2 size={22} />
            </button>
          </div>

          <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 font-mono-data text-sm font-bold text-[#c6c6c6]">
            <span>{formatTime(positionMs, "0:00")}</span>
            <div className="h-1.5 overflow-hidden rounded-full bg-[#3b3b3b]">
              <span
                className="block h-full rounded-full bg-white transition-[width] duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span>{formatTime(durationMs)}</span>
          </div>
        </div>

        {error && (
          <p className="rounded-2xl border border-[#3a2518] bg-[#1a0d07] px-4 py-3 text-sm font-bold text-[#f0b28b]">
            {error}
          </p>
        )}
      </section>
    )
  }

  if (isMini) {
    return (
      <section
        className={[
          "rounded-[20px] border px-3 py-2.5 shadow-[0_14px_34px_-24px_rgba(72,45,14,0.7)] backdrop-blur",
          surfaceClass,
          className,
        ].join(" ")}
        aria-label="Music player"
      >
        <div className="grid grid-cols-[34px_minmax(0,1fr)_34px_auto] items-center gap-2.5">
          <span className={["grid h-8 w-8 place-items-center rounded-2xl", softClass].join(" ")}>
            <Music2 size={15} />
          </span>
          <div className="min-w-0">
            <p className={["font-mono-data text-[9px] font-bold uppercase tracking-[0.18em]", mutedClass].join(" ")}>
              Music
            </p>
            <h3 className="truncate text-sm font-extrabold leading-tight">
              {trackTitle}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => void runPlayback(isPlaying ? "pause" : "play")}
            disabled={Boolean(busy)}
            className={["grid h-8 w-8 place-items-center rounded-full transition disabled:opacity-60", primaryClass].join(" ")}
            aria-label={isPlaying ? "Pause track" : "Play track"}
            title={isPlaying ? "Pause track" : "Play track"}
          >
            {busy === "play" || busy === "pause" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isPlaying ? (
              <Pause size={14} fill="currentColor" />
            ) : (
              <Play size={14} fill="currentColor" />
            )}
          </button>
          {onOpen && (
            <button
              type="button"
              onClick={onOpen}
              className={["rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition", actionClass].join(" ")}
            >
              Open
            </button>
          )}
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-[#dfcfb1]/65">
          <span
            className={[
              "block h-full rounded-full transition-[width] duration-500",
              isDark ? "bg-[#e3b04f]" : "bg-[#b6531c]",
            ].join(" ")}
            style={{ width: `${progress}%` }}
          />
        </div>
        {error && (
          <p className={["mt-2 text-[11px] font-bold", isDark ? "text-[#e3b04f]" : "text-[#9b3e12]"].join(" ")}>
            {error}
          </p>
        )}
      </section>
    )
  }

  return (
    <section
      className={[
        "rounded-3xl border shadow-[0_24px_60px_-48px_rgba(72,45,14,0.7)] backdrop-blur",
        isWide ? "p-6" : isPanel ? "p-4" : "p-5",
        surfaceClass,
        className,
      ].join(" ")}
    >
      <div className={["flex items-start justify-between", isPanel ? "gap-3" : "gap-4"].join(" ")}>
        <div className={["flex min-w-0 items-center", isPanel ? "gap-2.5" : "gap-3"].join(" ")}>
          <WidgetArtwork
            url={music.current.imageUrl}
            label={trackTitle}
            size={isWide ? 56 : isPanel ? 36 : 40}
            fallbackColor={isDark ? "#e3b04f" : "#b6531c"}
          />
          <div className="min-w-0">
            <p className={["font-mono-data text-[10px] font-bold uppercase tracking-[0.2em]", mutedClass].join(" ")}>
              Music Box
            </p>
            <h3 className={[isWide ? "text-2xl" : isPanel ? "text-lg" : "text-base", "mt-1 truncate font-extrabold leading-tight"].join(" ")}>
              {trackTitle}
            </h3>
          </div>
        </div>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className={[
              "shrink-0 rounded-full border font-bold uppercase tracking-[0.14em] transition",
              isWide ? "px-5 py-2.5 text-xs" : isPanel ? "px-3 py-1.5 text-[10px]" : "px-3 py-1.5 text-[10px]",
              actionClass,
            ].join(" ")}
          >
            Open
          </button>
        )}
      </div>

      <p className={[isWide ? "mt-5 text-lg" : isPanel ? "mt-3 text-sm" : "mt-3 text-sm", "line-clamp-1 font-semibold leading-snug", mutedClass].join(" ")}>
        {trackMeta || `${playlist} · ${music.mode}`}
      </p>

      <div className={isWide ? "mt-5" : isPanel ? "mt-3" : "mt-4"}>
        <BeatSignal active={isPlaying} compact={isPanel} />
        <div className={[isPanel ? "mt-2 h-1" : "mt-3 h-1.5", "overflow-hidden rounded-full bg-[#dfcfb1]/65"].join(" ")}>
          <span
            className={[
              "block h-full rounded-full transition-[width] duration-500",
              isDark ? "bg-[#e3b04f]" : "bg-[#b6531c]",
            ].join(" ")}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className={["mt-2 flex items-center justify-between font-mono-data text-[10px] font-bold uppercase tracking-[0.12em]", mutedClass].join(" ")}>
          <span>{formatTime(positionMs, "0:00")}</span>
          <span>{formatTime(durationMs)}</span>
        </div>
      </div>

      <div className={[isWide ? "mt-5" : isPanel ? "mt-3" : "mt-4", "flex items-center gap-2"].join(" ")}>
        <button
          type="button"
          onClick={() => void runPlayback("previous")}
          disabled={Boolean(busy)}
          className={["grid place-items-center rounded-full border transition", isWide ? "h-11 w-11" : isPanel ? "h-8 w-8" : "h-9 w-9", actionClass].join(" ")}
          aria-label="Previous track"
          title="Previous track"
        >
          {busy === "previous" ? <Loader2 size={13} className="animate-spin" /> : <SkipBack size={isWide ? 16 : isPanel ? 12 : 13} />}
        </button>
        <button
          type="button"
          onClick={() => void runPlayback(isPlaying ? "pause" : "play")}
          disabled={Boolean(busy)}
          className={[
            "grid place-items-center rounded-full shadow-[0_14px_26px_-18px_rgba(181,83,28,0.65)] transition",
            isWide ? "h-14 w-14" : isPanel ? "h-10 w-10" : "h-11 w-11",
            primaryClass,
          ].join(" ")}
          aria-label={isPlaying ? "Pause track" : "Play track"}
          title={isPlaying ? "Pause track" : "Play track"}
        >
          {busy === "play" || busy === "pause" ? (
            <Loader2 size={isWide ? 18 : isPanel ? 15 : 16} className="animate-spin" />
          ) : isPlaying ? (
            <Pause size={isWide ? 18 : isPanel ? 15 : 16} fill="currentColor" />
          ) : (
            <Play size={isWide ? 18 : isPanel ? 15 : 16} fill="currentColor" />
          )}
        </button>
        <button
          type="button"
          onClick={() => void runPlayback("next")}
          disabled={Boolean(busy)}
          className={["grid place-items-center rounded-full border transition", isWide ? "h-11 w-11" : isPanel ? "h-8 w-8" : "h-9 w-9", actionClass].join(" ")}
          aria-label="Next track"
          title="Next track"
        >
          {busy === "next" ? <Loader2 size={13} className="animate-spin" /> : <SkipForward size={isWide ? 16 : isPanel ? 12 : 13} />}
        </button>
        <span className={["ml-auto inline-flex items-center gap-1.5 rounded-full border font-bold", isWide ? "h-11 px-4 text-sm" : isPanel ? "h-8 px-3 text-xs" : "h-9 px-3 text-xs", actionClass].join(" ")}>
          <Volume2 size={isWide ? 15 : isPanel ? 12 : 13} />
          72
        </span>
      </div>

      {error && (
        <p className={["mt-3 text-xs font-bold", isDark ? "text-[#e3b04f]" : "text-[#9b3e12]"].join(" ")}>
          {error}
        </p>
      )}
    </section>
  )
}

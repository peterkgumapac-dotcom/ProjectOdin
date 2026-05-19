import { useMemo, useState } from "react"
import { Loader2, Mic, Power, Radio, ShieldAlert } from "lucide-react"
import { useLocation } from "react-router-dom"
import {
  OdinVoiceConsole,
  type OdinVoiceSurfaceState,
} from "./OdinVoiceConsole"
import { useOdinSurfaceHandoff } from "@/lib/odinSurfaceState"

const INITIAL_VOICE_STATE: OdinVoiceSurfaceState = {
  active: false,
  status: "idle",
  message: "ODIN is standing by.",
  latest: null,
  error: null,
  micLevel: 0,
  micLive: false,
  voiceDetected: false,
  listenerPhase: "idle",
  transcript: "",
  wakeArmed: false,
  wakeSupported: false,
  wakeTranscript: "",
  wakeLastHeardAt: null,
  wakeError: null,
  inputState: "standby",
}

function statusCopy(state: OdinVoiceSurfaceState) {
  if (state.inputState === "blocked" || state.status === "error") {
    return {
      label: "Voice blocked",
      detail: state.error ?? state.wakeError ?? "Allow microphone access, then retry.",
      tone: "error" as const,
    }
  }
  if (state.listenerPhase === "connecting" || state.status === "thinking") {
    return {
      label: "Connecting",
      detail: state.message || "Opening the ODIN voice channel.",
      tone: "busy" as const,
    }
  }
  if (state.inputState === "hearing" || state.voiceDetected) {
    return {
      label: "Hearing you",
      detail: state.transcript ? `Captured: ${state.transcript}` : "Your mic signal is live.",
      tone: "live" as const,
    }
  }
  if (state.inputState === "captured") {
    return {
      label: "Words captured",
      detail: state.transcript || "ODIN received the turn.",
      tone: "busy" as const,
    }
  }
  if (state.inputState === "thinking") {
    return {
      label: "Sent to ODIN",
      detail: state.message || "Reading the request.",
      tone: "busy" as const,
    }
  }
  if (state.listenerPhase === "speaking" || state.inputState === "speaking") {
    return {
      label: "ODIN replying",
      detail: state.message || state.latest?.spokenText || "Voice response is playing.",
      tone: "live" as const,
    }
  }
  if (state.active || state.listenerPhase === "listening") {
    return {
      label: "Listening",
      detail: state.message || "Speak naturally.",
      tone: "live" as const,
    }
  }
  if (state.wakeArmed) {
    return {
      label: "Wake ready",
      detail: "Say \"Hey ODIN\" or press Talk.",
      tone: "wake" as const,
    }
  }
  if (state.wakeSupported) {
    return {
      label: "Voice ready",
      detail: state.message || "Press Talk to start ODIN.",
      tone: "idle" as const,
    }
  }
  return {
    label: "ODIN voice",
    detail: state.message || "Press Talk to start ODIN.",
    tone: "idle" as const,
  }
}

function primaryLabel(state: OdinVoiceSurfaceState) {
  if (state.active) return "Stop"
  if (state.status === "error" || state.inputState === "blocked") return "Retry"
  if (state.listenerPhase === "connecting" || state.status === "thinking") return "Opening"
  return "Talk"
}

export function GlobalOdinVoiceControl() {
  const location = useLocation()
  const [state, setState] = useState<OdinVoiceSurfaceState>(INITIAL_VOICE_STATE)
  const [stateUpdatedAt, setStateUpdatedAt] = useState(0)
  const [autoStartKey, setAutoStartKey] = useState(0)
  const [stopKey, setStopKey] = useState(0)
  const [enableWakeKey, setEnableWakeKey] = useState(0)
  const [initialCommand, setInitialCommand] = useState<string | undefined>()
  const handoff = useOdinSurfaceHandoff()

  const surfaceState = useMemo(() => {
    if (!handoff?.voice || handoff.updatedAt <= stateUpdatedAt) return state
    return {
      ...INITIAL_VOICE_STATE,
      ...handoff.voice,
      latest: handoff.latest ?? null,
    }
  }, [handoff, state, stateUpdatedAt])

  const copy = useMemo(() => statusCopy(surfaceState), [surfaceState])
  const isDashboard = location.pathname === "/dashboard"
  const isOpening =
    surfaceState.listenerPhase === "connecting" || surfaceState.status === "thinking"
  const needsWakeEnable =
    surfaceState.wakeSupported &&
    !surfaceState.wakeArmed &&
    !surfaceState.active &&
    surfaceState.inputState !== "blocked" &&
    /enable wake|request microphone/i.test(surfaceState.message)

  if (isDashboard) return null

  function toggleVoice() {
    if (surfaceState.active) {
      setStopKey((key) => key + 1)
      return
    }
    if (isOpening) return
    setInitialCommand(undefined)
    setAutoStartKey((key) => key + 1)
  }

  return (
    <>
      <OdinVoiceConsole
        variant="controller"
        autoStartKey={autoStartKey}
        stopKey={stopKey}
        enableWakeKey={enableWakeKey}
        initialCommand={initialCommand}
        onStateChange={(next) => {
          setState(next)
          setStateUpdatedAt(Date.now())
        }}
      />

      <div
        className={[
          "pointer-events-auto fixed bottom-5 right-5 z-[90] flex max-w-[min(430px,calc(100vw-2.5rem))] items-center gap-3 rounded-full border px-4 py-3 shadow-[0_18px_46px_-28px_rgba(74,42,12,0.55)] backdrop-blur-xl",
          copy.tone === "error"
            ? "border-[#e6a486] bg-[#fff4ec]/95 text-[#9b3e12]"
            : copy.tone === "live"
              ? "border-[#8fb071] bg-[#f3faed]/95 text-[#2f5a23]"
              : copy.tone === "busy"
                ? "border-[#dfbd80] bg-[#fff8ea]/95 text-[#7d5520]"
                : "border-[#dfcfb1] bg-[#fffaf1]/95 text-[#2b1d0f]",
        ].join(" ")}
        aria-live="polite"
      >
        <span
          className={[
            "grid h-11 w-11 shrink-0 place-items-center rounded-full",
            copy.tone === "error"
              ? "bg-[#ffe6d8]"
              : copy.tone === "live"
                ? "bg-[#e1f0d7]"
                : "bg-[#f4dfc5]",
          ].join(" ")}
        >
          {copy.tone === "error" ? (
            <ShieldAlert size={19} />
          ) : isOpening ? (
            <Loader2 size={19} className="animate-spin" />
          ) : surfaceState.wakeArmed ? (
            <Radio size={19} />
          ) : (
            <Mic size={19} />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-extrabold">{copy.label}</p>
            {surfaceState.digestPhase && surfaceState.digestPhase !== "idle" && (
              <span className="rounded-full border border-current/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] opacity-75">
                {surfaceState.digestPhase}
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs font-semibold leading-snug opacity-75">
            {copy.detail}
          </p>
        </div>

        {needsWakeEnable && (
          <button
            type="button"
            onClick={() => setEnableWakeKey((key) => key + 1)}
            className="hidden h-10 shrink-0 rounded-full border border-[#d2ba95] px-3 text-xs font-extrabold text-[#7d644e] transition hover:border-[#b6531c] hover:text-[#b6531c] sm:inline-flex sm:items-center"
          >
            Wake
          </button>
        )}

        <button
          type="button"
          onClick={toggleVoice}
          disabled={isOpening}
          className={[
            "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full px-4 text-sm font-extrabold transition disabled:cursor-wait disabled:opacity-75",
            surfaceState.active
              ? "border border-[#a44a18] bg-transparent text-[#a44a18] hover:bg-[#fff2e8]"
              : "bg-[#bd5a18] text-white shadow-[0_10px_24px_-16px_rgba(189,90,24,0.7)] hover:bg-[#a94b16]",
          ].join(" ")}
          aria-label={surfaceState.active ? "Stop ODIN voice" : "Start ODIN voice"}
        >
          {surfaceState.active ? <Power size={14} /> : <Mic size={14} />}
          {primaryLabel(surfaceState)}
        </button>
      </div>
    </>
  )
}

import { useEffect, useState } from "react"
import type { OdinCommandResponse } from "@/lib/odinOrchestrator"

export const ODIN_SURFACE_STATE_KEY = "odin.surface.handoff.v1"
export const ODIN_SURFACE_STATE_EVENT = "odin:surface-handoff"

export type OdinSharedVoiceState = {
  active: boolean
  status: "idle" | "wake" | "connecting" | "listening" | "speaking" | "online" | "thinking" | "error"
  message: string
  error: string | null
  micLive: boolean
  voiceDetected: boolean
  listenerPhase: "idle" | "wake" | "connecting" | "listening" | "speaking" | "blocked"
  transcript: string
  wakeArmed: boolean
  wakeSupported: boolean
  wakeTranscript: string
  wakeLastHeardAt: string | null
  wakeError: string | null
  inputState: "standby" | "wake" | "hearing" | "captured" | "thinking" | "speaking" | "blocked"
  digestPhase?: "idle" | "received" | "routing" | "digesting" | "ready" | "error"
  digestElapsedMs?: number
}

export interface OdinSurfaceHandoff {
  source: "voice-console" | "island" | "dashboard" | "unknown"
  updatedAt: number
  voice: OdinSharedVoiceState
  latest: OdinCommandResponse | null
}

function sanitize(raw: Partial<OdinSurfaceHandoff> | null): OdinSurfaceHandoff | null {
  if (!raw || typeof raw !== "object") return null
  const voice = raw.voice
  if (!voice || typeof voice !== "object") return null
  return {
    source:
      raw.source === "voice-console" ||
      raw.source === "island" ||
      raw.source === "dashboard" ||
      raw.source === "unknown"
        ? raw.source
        : "unknown",
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    latest: raw.latest ?? null,
    voice: {
      active: Boolean(voice.active),
      status:
        voice.status === "idle" ||
        voice.status === "wake" ||
        voice.status === "connecting" ||
        voice.status === "listening" ||
        voice.status === "speaking" ||
        voice.status === "online" ||
        voice.status === "thinking" ||
        voice.status === "error"
          ? voice.status
          : "idle",
      message: typeof voice.message === "string" ? voice.message : "ODIN is standing by.",
      error: typeof voice.error === "string" ? voice.error : null,
      micLive: Boolean(voice.micLive),
      voiceDetected: Boolean(voice.voiceDetected),
      listenerPhase:
        voice.listenerPhase === "idle" ||
        voice.listenerPhase === "wake" ||
        voice.listenerPhase === "connecting" ||
        voice.listenerPhase === "listening" ||
        voice.listenerPhase === "speaking" ||
        voice.listenerPhase === "blocked"
          ? voice.listenerPhase
          : "idle",
      transcript: typeof voice.transcript === "string" ? voice.transcript : "",
      wakeArmed: Boolean(voice.wakeArmed),
      wakeSupported: Boolean(voice.wakeSupported),
      wakeTranscript: typeof voice.wakeTranscript === "string" ? voice.wakeTranscript : "",
      wakeLastHeardAt:
        typeof voice.wakeLastHeardAt === "string" || voice.wakeLastHeardAt === null
          ? voice.wakeLastHeardAt
          : null,
      wakeError: typeof voice.wakeError === "string" ? voice.wakeError : null,
      inputState:
        voice.inputState === "standby" ||
        voice.inputState === "wake" ||
        voice.inputState === "hearing" ||
        voice.inputState === "captured" ||
        voice.inputState === "thinking" ||
        voice.inputState === "speaking" ||
        voice.inputState === "blocked"
          ? voice.inputState
          : "standby",
      digestPhase:
        voice.digestPhase === "idle" ||
        voice.digestPhase === "received" ||
        voice.digestPhase === "routing" ||
        voice.digestPhase === "digesting" ||
        voice.digestPhase === "ready" ||
        voice.digestPhase === "error"
          ? voice.digestPhase
          : undefined,
      digestElapsedMs:
        typeof voice.digestElapsedMs === "number" ? voice.digestElapsedMs : undefined,
    },
  }
}

export function loadOdinSurfaceHandoff(): OdinSurfaceHandoff | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(ODIN_SURFACE_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<OdinSurfaceHandoff>
    return sanitize(parsed)
  } catch {
    return null
  }
}

export function saveOdinSurfaceHandoff(next: OdinSurfaceHandoff) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(ODIN_SURFACE_STATE_KEY, JSON.stringify(next))
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(ODIN_SURFACE_STATE_EVENT, { detail: next }))
  }, 0)
}

export function useOdinSurfaceHandoff(): OdinSurfaceHandoff | null {
  const [state, setState] = useState<OdinSurfaceHandoff | null>(() => loadOdinSurfaceHandoff())

  useEffect(() => {
    const refresh = () => setState(loadOdinSurfaceHandoff())
    window.addEventListener("storage", refresh)
    window.addEventListener(ODIN_SURFACE_STATE_EVENT, refresh)
    return () => {
      window.removeEventListener("storage", refresh)
      window.removeEventListener(ODIN_SURFACE_STATE_EVENT, refresh)
    }
  }, [])

  return state
}

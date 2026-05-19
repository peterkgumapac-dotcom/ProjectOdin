// Local-only diagnostics log. Captures unhandled errors and rejections in a
// 50-entry ring buffer in localStorage, plus mirrors them to the Electron main
// process (if available) which appends to a rotating file in userData/. No
// network, no third-party telemetry.

const STORAGE_KEY = "odin.diag.log.v1"
const MAX_ENTRIES = 50

export interface DiagEntry {
  ts: string
  source: string
  name?: string
  message: string
  stack?: string
  url?: string
  extra?: Record<string, unknown>
}

interface DesktopDiagBridge {
  appendDiag?: (entry: DiagEntry) => Promise<unknown> | unknown
}

interface NotchDiagBridge {
  appendDiag?: (entry: DiagEntry) => Promise<unknown> | unknown
  postMessage?: (message: { action: string; payload?: Record<string, unknown> }) => Promise<unknown> | unknown
}

function describeError(err: unknown): { name?: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  if (typeof err === "string") return { message: err }
  if (err && typeof err === "object") {
    const maybe = err as { message?: unknown; stack?: unknown; name?: unknown }
    return {
      name: typeof maybe.name === "string" ? maybe.name : undefined,
      message: typeof maybe.message === "string" ? maybe.message : JSON.stringify(err),
      stack: typeof maybe.stack === "string" ? maybe.stack : undefined,
    }
  }
  return { message: String(err) }
}

function readBuffer(): DiagEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is DiagEntry =>
        Boolean(item) && typeof item === "object" && typeof (item as DiagEntry).message === "string"
    )
  } catch {
    return []
  }
}

function writeBuffer(entries: DiagEntry[]): void {
  try {
    const trimmed = entries.slice(-MAX_ENTRIES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // localStorage full or unavailable; nothing to do.
  }
}

export function logFatalError(err: unknown, meta?: { source?: string; extra?: Record<string, unknown> }): void {
  const desc = describeError(err)
  const entry: DiagEntry = {
    ts: new Date().toISOString(),
    source: meta?.source ?? "renderer",
    name: desc.name,
    message: desc.message,
    stack: desc.stack,
    url: typeof window !== "undefined" ? window.location.href : undefined,
    extra: meta?.extra,
  }

  try {
    const next = [...readBuffer(), entry]
    writeBuffer(next)
  } catch {
    // Ignore storage failures.
  }

  try {
    const bridges = window as Window & { odinDesktop?: DesktopDiagBridge; odin?: NotchDiagBridge }
    const desktopResult = bridges.odinDesktop?.appendDiag?.(entry)
    if (desktopResult) {
      void Promise.resolve(desktopResult).catch(() => {
        // Ignore IPC delivery failures; localStorage copy is the source of truth.
      })
    } else if (bridges.odin?.appendDiag) {
      void Promise.resolve(bridges.odin.appendDiag(entry)).catch(() => {
        // Ignore notch host delivery failures.
      })
    } else if (bridges.odin?.postMessage) {
      void Promise.resolve(
        bridges.odin.postMessage({
          action: "appendDiag",
          payload: entry as unknown as Record<string, unknown>,
        })
      ).catch(() => {
        // Ignore notch host delivery failures.
      })
    }
  } catch {
    // odinDesktop missing in web context.
  }

  if (typeof console !== "undefined") {
    console.error("[odin-diag]", entry.source, desc.message, desc.stack ?? "")
  }
}

export function readDiagnosticsLog(): DiagEntry[] {
  return readBuffer()
}

export function clearDiagnosticsLog(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}

export function installGlobalDiagnostics(): void {
  if (typeof window === "undefined") return
  const flag = "__odinDiagInstalled" as const
  const w = window as Window & { [flag]?: boolean }
  if (w[flag]) return
  w[flag] = true

  window.addEventListener("error", (event) => {
    logFatalError(event.error ?? event.message, { source: "window.error" })
  })

  window.addEventListener("unhandledrejection", (event) => {
    logFatalError(event.reason, { source: "unhandledrejection" })
  })
}

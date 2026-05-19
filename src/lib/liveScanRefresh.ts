export const LIVE_SCAN_REFRESH_KEY = "odin.live_scan.refresh.v1"
export const LIVE_SCAN_REFRESH_EVENT = "odin:live-scan-refresh"

export type LiveScanSource =
  | "all"
  | "calendar"
  | "gmail"
  | "slack"
  | "weather"
  | "health"
  | "council"

export interface LiveScanRefreshSignal {
  id: string
  requestedAt: string
  reason: string
  sources: LiveScanSource[]
}

function normalizeSignal(
  raw: Partial<LiveScanRefreshSignal> | null
): LiveScanRefreshSignal | null {
  if (!raw || typeof raw !== "object") return null
  if (typeof raw.id !== "string" || !raw.id.trim()) return null
  const requestedAt =
    typeof raw.requestedAt === "string" && raw.requestedAt.trim()
      ? raw.requestedAt
      : new Date().toISOString()
  const reason =
    typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason
      : "live_scan"
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((source): source is LiveScanSource => {
        return (
          source === "all" ||
          source === "calendar" ||
          source === "gmail" ||
          source === "slack" ||
          source === "weather" ||
          source === "health" ||
          source === "council"
        )
      })
    : []
  return {
    id: raw.id,
    requestedAt,
    reason,
    sources: sources.length ? sources : ["all"],
  }
}

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `scan-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function readLiveScanRefreshSignal(): LiveScanRefreshSignal | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(LIVE_SCAN_REFRESH_KEY)
    if (!raw) return null
    return normalizeSignal(
      JSON.parse(raw) as Partial<LiveScanRefreshSignal> | null
    )
  } catch {
    return null
  }
}

export function publishLiveScanRefreshSignal(
  input?: Partial<Pick<LiveScanRefreshSignal, "sources" | "reason" | "requestedAt">>
): LiveScanRefreshSignal | null {
  if (typeof window === "undefined") return null
  const signal: LiveScanRefreshSignal = {
    id: randomId(),
    requestedAt: input?.requestedAt ?? new Date().toISOString(),
    reason: input?.reason?.trim() || "live_scan",
    sources: input?.sources?.length ? input.sources : ["all"],
  }
  try {
    window.localStorage.setItem(LIVE_SCAN_REFRESH_KEY, JSON.stringify(signal))
  } catch {
    // Storage sync is best-effort. The in-tab event still dispatches.
  }
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(LIVE_SCAN_REFRESH_EVENT, { detail: signal }))
  }, 0)
  return signal
}

export function isLiveScanSourceEnabled(
  signal: LiveScanRefreshSignal,
  source: Exclude<LiveScanSource, "all">
): boolean {
  return signal.sources.includes("all") || signal.sources.includes(source)
}

export function subscribeLiveScanRefresh(
  callback: (signal: LiveScanRefreshSignal) => void
): () => void {
  if (typeof window === "undefined") return () => undefined
  let lastId: string | null = null

  const emitFromStorage = () => {
    const signal = readLiveScanRefreshSignal()
    if (!signal || signal.id === lastId) return
    lastId = signal.id
    callback(signal)
  }

  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<LiveScanRefreshSignal>).detail
    const signal = normalizeSignal(detail)
    if (!signal || signal.id === lastId) return
    lastId = signal.id
    callback(signal)
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== LIVE_SCAN_REFRESH_KEY) return
    emitFromStorage()
  }

  window.addEventListener(LIVE_SCAN_REFRESH_EVENT, onCustom as EventListener)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(LIVE_SCAN_REFRESH_EVENT, onCustom as EventListener)
    window.removeEventListener("storage", onStorage)
  }
}

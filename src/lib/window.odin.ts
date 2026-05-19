export type OdinNativeEventName =
  | "notch:expanded"
  | "notch:collapsed"
  | "notch:geometry"
  | "auth:session"
  | "quick-access:recent-files"
  | "quick-access:installed-apps"

export type OdinNativeAction =
  | "openRoute"
  | "openPath"
  | "openFinder"
  | "appendDiag"
  | "listRecentFiles"
  | "listInstalledApps"
  | "voiceStart"
  // Telemetry only in the two-panel host (never used as an expand gate)
  | "trayReady"
  // Compatibility actions only. Native hover tracking is authoritative.
  | "hoverEnter"
  | "hoverLeave"
  // Native compact mode/state selection
  | "setCompactMode"
  // Expanded panel sizing mode
  | "resize"

export function onOdinEvent<T = unknown>(name: OdinNativeEventName, handler: (payload: T) => void) {
  const nativeOn = window.odin?.events?.on
  if (nativeOn) return nativeOn(name, handler as (payload: unknown) => void)

  const wrapped = (event: Event) => handler((event as CustomEvent<T>).detail)
  window.addEventListener(name, wrapped)
  return () => window.removeEventListener(name, wrapped)
}

export function postOdinAction(action: OdinNativeAction, payload?: Record<string, unknown>) {
  const message = { action, ...(payload ? { payload } : {}) }
  if (window.odin?.postMessage) return window.odin.postMessage(message)

  const desktop = (window as Window & {
    odinDesktop?: {
      openRoute?: (route: string) => Promise<unknown> | unknown
      openPath?: (pathKey: string) => Promise<unknown> | unknown
      voice?: { start?: () => Promise<unknown> | unknown }
    }
  }).odinDesktop

  const delivered = (value: unknown) => value !== false
  try {
    if (desktop) {
      if (action === "openRoute" && typeof payload?.route === "string" && desktop.openRoute) {
        const result = desktop.openRoute(payload.route)
        return Promise.resolve(result).then(delivered, () => false)
      }
      if (action === "openPath" && typeof payload?.path === "string" && desktop.openPath) {
        const result = desktop.openPath(payload.path)
        return Promise.resolve(result).then(delivered, () => false)
      }
      if (action === "voiceStart" && desktop.voice?.start) {
        const result = desktop.voice.start()
        return Promise.resolve(result).then(delivered, () => false)
      }
    }
  } catch {
    return Promise.resolve(false)
  }

  const webkit = (window as Window & {
    webkit?: { messageHandlers?: { odin?: { postMessage?: (message: unknown) => void } } }
  }).webkit
  try {
    webkit?.messageHandlers?.odin?.postMessage?.(message)
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(false)
  }
}

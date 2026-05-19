const { contextBridge, ipcRenderer } = require("electron")

const isPackaged = process.env.ODIN_DESKTOP_PACKAGED === "1"

function safeRoute(route) {
  if (typeof route !== "string") return "/dashboard"
  if (!route.startsWith("/") || route.startsWith("//")) return "/dashboard"
  return route
}

contextBridge.exposeInMainWorld("odinDesktop", {
  isDesktop: true,
  isPackaged,
  platform: process.platform,
  routeUrl: (route) => {
    const normalized = safeRoute(route)
    if (isPackaged) return `odin://open${normalized}`
    return `${window.location.origin}${normalized}`
  },
  microphoneStatus: () => ipcRenderer.invoke("odin:microphone-status"),
  requestMicrophoneAccess: () => ipcRenderer.invoke("odin:request-microphone-access"),
  permissionSnapshot: () => ipcRenderer.invoke("odin:permission-snapshot"),
  requestRequiredPermissions: () => ipcRenderer.invoke("odin:request-required-permissions"),
  openExternal: (url) => ipcRenderer.invoke("odin:open-external", url),
  openRoute: (route) => ipcRenderer.invoke("odin:open-route", route),
  openPath: (pathKey) => ipcRenderer.invoke("odin:open-path", pathKey),
  publishMusicState: (state) => ipcRenderer.invoke("odin:music-state-update", state),
  exportSession: (session) => ipcRenderer.invoke("odin:session-export", session),
  appendDiag: (entry) => ipcRenderer.invoke("odin:append-diag", entry),
  voice: {
    start: () => ipcRenderer.invoke("odin:voice-start"),
    stop: () => ipcRenderer.invoke("odin:voice-stop"),
  },
  onVoiceCommand: (handler) => {
    if (typeof handler !== "function") return () => {}
    const listener = (_event, payload) => {
      try {
        handler(payload)
      } catch {
        // Keep native bridge resilient to renderer callback errors.
      }
    }
    ipcRenderer.on("odin:voice-command", listener)
    return () => {
      ipcRenderer.removeListener("odin:voice-command", listener)
    }
  },
})

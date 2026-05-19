export {}

declare global {
  interface Window {
    odinDesktop?: {
      isDesktop: boolean
      isPackaged: boolean
      platform: string
      routeUrl: (route: string) => string
      microphoneStatus: () => Promise<"not-determined" | "granted" | "denied" | "restricted" | "unknown">
      requestMicrophoneAccess: () => Promise<boolean>
      permissionSnapshot: () => Promise<{
        platform: string
        microphone: "not-determined" | "granted" | "denied" | "restricted" | "unknown"
      }>
      requestRequiredPermissions: () => Promise<{
        platform: string
        microphone: "not-determined" | "granted" | "denied" | "restricted" | "unknown"
      }>
      openExternal: (url: string) => Promise<void>
      openRoute?: (route: string) => Promise<void>
      openPath?: (pathKey: "downloads" | "screenshots" | "documents" | "recent") => Promise<void>
      exportSession?: (
        session: {
          access_token: string
          refresh_token: string
          user: unknown
        } | null
      ) => Promise<void>
      appendDiag?: (entry: {
        ts: string
        source: string
        name?: string
        message: string
        stack?: string
        url?: string
        extra?: Record<string, unknown>
      }) => Promise<{ ok: boolean; path?: string; error?: string }>
      voice?: {
        start: () => Promise<boolean>
        stop: () => Promise<boolean>
      }
      onVoiceCommand?: (
        handler: (payload: { command?: "start" | "stop" } | null | undefined) => void
      ) => () => void
    }

    __ODIN_INITIAL_SESSION__?: {
      access_token?: string
      refresh_token?: string
      user?: unknown
    } | null

    odin?: {
      events?: {
        on?: (name: string, handler: (payload: unknown) => void) => () => void
        off?: (name: string, handler: (payload: unknown) => void) => void
      }
      appendDiag?: (entry: {
        ts: string
        source: string
        name?: string
        message: string
        stack?: string
        url?: string
        extra?: Record<string, unknown>
      }) => Promise<unknown> | unknown
      postMessage?: (message: { action: string; payload?: Record<string, unknown> }) => Promise<boolean>
    }
  }
}

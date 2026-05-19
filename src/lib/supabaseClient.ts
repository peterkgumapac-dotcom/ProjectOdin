import { createClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const notchSupabaseStorageFallback = new Map<string, string>()

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Set them in .env.local."
  )
}

function isNotchTrayStorageContext(): boolean {
  if (typeof window === "undefined") return false
  const { pathname } = window.location
  return pathname === "/notch-tray" || pathname.startsWith("/notch-tray/")
}

const notchSafeStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key) ?? notchSupabaseStorageFallback.get(key) ?? null
    } catch {
      return notchSupabaseStorageFallback.get(key) ?? null
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      notchSupabaseStorageFallback.set(key, value)
    }
  },
  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key)
    } catch {
      notchSupabaseStorageFallback.delete(key)
    }
  },
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    ...(isNotchTrayStorageContext() ? { storage: notchSafeStorage } : {}),
  },
})

export async function applyInjectedSupabaseSession(session: Window["__ODIN_INITIAL_SESSION__"]) {
  if (!session?.access_token || !session.refresh_token) return false
  const { error } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
  if (error) {
    console.warn("[ODIN] Notch session injection failed:", error.message)
    return false
  }
  return true
}

if (typeof window !== "undefined") {
  void applyInjectedSupabaseSession(window.__ODIN_INITIAL_SESSION__)
  window.addEventListener("auth:session", (event) => {
    const session = (event as CustomEvent<Window["__ODIN_INITIAL_SESSION__"]>).detail
    void applyInjectedSupabaseSession(session)
  })
}

export async function getFreshAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  let session = data.session
  const expiresAt = session?.expires_at ? session.expires_at * 1000 : null

  if (session && expiresAt && expiresAt - Date.now() < 60_000) {
    const refreshed = await supabase.auth.refreshSession()
    session = refreshed.data.session ?? session
  }

  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {}
}

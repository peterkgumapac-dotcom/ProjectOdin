import { createContext, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import type { Session } from "@supabase/supabase-js"
import { supabase } from "@/lib/supabaseClient"
import { odinRouteUrl } from "@/lib/desktopRoute"
import type { AuthContextValue, AuthResult } from "@/types/auth"

const AuthContext = createContext<AuthContextValue | undefined>(undefined)
const localAuthEmail = import.meta.env.DEV
  ? import.meta.env.VITE_ODIN_LOCAL_AUTH_EMAIL
  : undefined
const localAuthPassword = import.meta.env.DEV
  ? import.meta.env.VITE_ODIN_LOCAL_AUTH_PASSWORD
  : undefined

function toAuthError(err: unknown): Error | null {
  if (!err) return null
  if (err instanceof Error) return err
  return new Error(String(err))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const sessionForNotch = session
      ? {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          user: session.user,
        }
      : null
    void window.odinDesktop?.exportSession?.(sessionForNotch)
  }, [session])

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return
      if (data.session) {
        setSession(data.session)
        setLoading(false)
        return
      }

      if (localAuthEmail && localAuthPassword) {
        const { data: signInData, error } = await supabase.auth.signInWithPassword({
          email: localAuthEmail,
          password: localAuthPassword,
        })
        if (!mounted) return
        if (!error) {
          setSession(signInData.session)
        } else {
          console.warn("[ODIN] Local auto sign-in failed:", error.message)
        }
        setLoading(false)
        return
      }

      setSession(null)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    const handleSessionExpired = () => {
      if (!mounted) return
      void supabase.auth.signOut().catch(() => {
        // Even if signOut fails (offline), clear local state so the UI bounces.
      })
      setSession(null)
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        const hash = window.location.hash || ""
        if (hash.startsWith("#/")) {
          window.location.hash = "#/login"
        } else {
          window.location.assign("/login")
        }
      }
    }
    window.addEventListener("odin:session-expired", handleSessionExpired)

    return () => {
      mounted = false
      sub.subscription.unsubscribe()
      window.removeEventListener("odin:session-expired", handleSessionExpired)
    }
  }, [])

  const value = useMemo<AuthContextValue>(() => {
    const signIn = async (email: string, password: string): Promise<AuthResult> => {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      return { error: toAuthError(error) }
    }

    const signUp = async (email: string, password: string): Promise<AuthResult> => {
      const { error } = await supabase.auth.signUp({ email, password })
      return { error: toAuthError(error) }
    }

    const signInWithMagicLink = async (email: string): Promise<AuthResult> => {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: odinRouteUrl("/dashboard") },
      })
      return { error: toAuthError(error) }
    }

    const signOut = async () => {
      await supabase.auth.signOut()
    }

    return {
      session,
      user: session?.user ?? null,
      loading,
      signIn,
      signUp,
      signInWithMagicLink,
      signOut,
    }
  }, [session, loading])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>")
  }
  return ctx
}

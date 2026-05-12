import { createContext, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import type { Session } from "@supabase/supabase-js"
import { supabase } from "@/lib/supabaseClient"
import type { AuthContextValue, AuthResult } from "@/types/auth"

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function toAuthError(err: unknown): Error | null {
  if (!err) return null
  if (err instanceof Error) return err
  return new Error(String(err))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => {
      mounted = false
      sub.subscription.unsubscribe()
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
        options: { emailRedirectTo: `${window.location.origin}/dashboard` },
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

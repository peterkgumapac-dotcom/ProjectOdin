import type { Session, User } from "@supabase/supabase-js"

export interface AuthResult {
  error: Error | null
}

export interface AuthContextValue {
  session: Session | null
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<AuthResult>
  signUp: (email: string, password: string) => Promise<AuthResult>
  signInWithMagicLink: (email: string) => Promise<AuthResult>
  signOut: () => Promise<void>
}

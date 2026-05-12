import { useCallback, useEffect, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { useAuth } from "@/hooks/useAuth"

export interface ConnectedAccount {
  id: string
  provider: string
  provider_account_id: string | null
  scopes: string[] | null
  token_expires_at: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface UseConnectedAccountsResult {
  accounts: ConnectedAccount[]
  loading: boolean
  error: Error | null
  isConnected: (provider: string) => boolean
  refresh: () => Promise<void>
}

export function useConnectedAccounts(): UseConnectedAccountsResult {
  const { user } = useAuth()
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    if (!user) {
      setAccounts([])
      setLoading(false)
      return
    }
    setError(null)
    const { data, error: loadError } = await supabase
      .from("connected_accounts")
      .select(
        "id, provider, provider_account_id, scopes, token_expires_at, metadata, created_at, updated_at"
      )
      .eq("user_id", user.id)
    if (loadError) {
      setError(new Error(loadError.message))
      setLoading(false)
      return
    }
    setAccounts(
      (data ?? []).map((row) => ({
        ...row,
        metadata: (row.metadata as Record<string, unknown>) ?? {},
      })) as ConnectedAccount[]
    )
    setLoading(false)
  }, [user])

  useEffect(() => {
    load()
    const onFocus = () => load()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [load])

  const isConnected = useCallback(
    (provider: string) => accounts.some((a) => a.provider === provider),
    [accounts]
  )

  return { accounts, loading, error, isConnected, refresh: load }
}

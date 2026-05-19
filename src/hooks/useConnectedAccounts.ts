import { useCallback, useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { useAuth } from "@/hooks/useAuth"

export type Provider = "google" | "slack" | "spotify" | "withings"

export type WorkflowTrigger =
  | "new_email"
  | "unread_over"
  | "from_sender"
  | "subject_contains"
  | "to_address"
  | "new_message"
  | "mentioned"
  | "keyword_in_channel"
  | "from_user"
  | "channel_unread_over"

export type WorkflowAction =
  | "notify_odin"
  | "label_urgent"
  | "summarize_counsel"
  | "skip_inbox"
  | "auto_followup"
  | "highlight_channel"

export interface WorkflowRule {
  id: string
  trigger: WorkflowTrigger
  condition: string
  action: WorkflowAction
  enabled: boolean
}

export interface ConnectedAccount {
  id: string
  provider: Provider
  accountEmail: string | null
  accountLabel: string
  workspaceName: string | null
  workspaceId: string | null
  scopes: string[] | null
  tokenExpiresAt: string | null
  isPrimary: boolean
  workflowRules: WorkflowRule[]
  metadata: Record<string, unknown>
  createdAt: string
}

export interface GroupedAccounts {
  google: ConnectedAccount[]
  slack: ConnectedAccount[]
  spotify: ConnectedAccount[]
  withings: ConnectedAccount[]
  all: ConnectedAccount[]
}

export interface UseConnectedAccountsResult extends GroupedAccounts {
  loading: boolean
  error: Error | null
  isConnected: (provider: Provider) => boolean
  hasAny: boolean
  refresh: () => Promise<void>
}

function isProvider(value: string): value is Provider {
  return (
    value === "google" ||
    value === "slack" ||
    value === "spotify" ||
    value === "withings"
  )
}

function parseRules(raw: unknown): WorkflowRule[] {
  if (!Array.isArray(raw)) return []
  const out: WorkflowRule[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    if (
      typeof r.id === "string" &&
      typeof r.trigger === "string" &&
      typeof r.action === "string"
    ) {
      out.push({
        id: r.id,
        trigger: r.trigger as WorkflowTrigger,
        condition: typeof r.condition === "string" ? r.condition : "",
        action: r.action as WorkflowAction,
        enabled: r.enabled !== false,
      })
    }
  }
  return out
}

export function useConnectedAccounts(): UseConnectedAccountsResult {
  const { user } = useAuth()
  const [all, setAll] = useState<ConnectedAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    if (!user) {
      setAll([])
      setLoading(false)
      return
    }
    setError(null)
    const { data, error: loadError } = await supabase
      .from("connected_accounts")
      .select(
        "id, provider, account_email, account_label, workspace_id, workspace_name, scopes, token_expires_at, is_primary, workflow_rules, metadata, created_at"
      )
      .eq("user_id", user.id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
    if (loadError) {
      setError(new Error(loadError.message))
      setLoading(false)
      return
    }
    const rows = (data ?? [])
      .filter((row) => isProvider(row.provider))
      .map<ConnectedAccount>((row) => ({
        id: row.id,
        provider: row.provider as Provider,
        accountEmail: row.account_email ?? null,
        accountLabel: row.account_label ?? "Account",
        workspaceName: row.workspace_name ?? null,
        workspaceId: row.workspace_id ?? null,
        scopes: row.scopes,
        tokenExpiresAt: row.token_expires_at ?? null,
        isPrimary: Boolean(row.is_primary),
        workflowRules: parseRules(row.workflow_rules),
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        createdAt: row.created_at,
      }))
    setAll(rows)
    setLoading(false)
  }, [user])

  useEffect(() => {
    load()
    const onFocus = () => load()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [load])

  const grouped = useMemo<GroupedAccounts>(() => {
    return {
      google: all.filter((a) => a.provider === "google"),
      slack: all.filter((a) => a.provider === "slack"),
      spotify: all.filter((a) => a.provider === "spotify"),
      withings: all.filter((a) => a.provider === "withings"),
      all,
    }
  }, [all])

  const isConnected = useCallback(
    (provider: Provider) => grouped[provider].length > 0,
    [grouped]
  )

  return {
    ...grouped,
    loading,
    error,
    isConnected,
    hasAny: all.length > 0,
    refresh: load,
  }
}

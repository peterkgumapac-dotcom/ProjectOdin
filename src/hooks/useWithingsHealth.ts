import { useCallback, useEffect, useMemo, useState } from "react"
import type { ConnectedAccount } from "@/hooks/useConnectedAccounts"
import {
  getWithingsHealthSummary,
  type WithingsHealthSummary,
} from "@/lib/connectors/withings"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

export interface UseWithingsHealthResult {
  account: ConnectedAccount | null
  summary: WithingsHealthSummary | null
  loading: boolean
  refreshing: boolean
  error: Error | null
  checkedAt: string | null
  refresh: (silent?: boolean) => Promise<void>
}

export interface UseWithingsHealthOptions {
  autoRefreshUnusableCache?: boolean
}

interface CachedWithingsSummary {
  summary: WithingsHealthSummary
  checkedAt: string | null
}

function cacheKey(account: ConnectedAccount) {
  return `odin.withings.summary.${account.id}.${account.tokenExpiresAt ?? "no-expiry"}`
}

function readCachedSummary(account: ConnectedAccount): CachedWithingsSummary | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(account))
    if (!raw) return null
    const parsed = JSON.parse(raw) as WithingsHealthSummary | CachedWithingsSummary

    if (
      parsed &&
      typeof parsed === "object" &&
      "summary" in parsed &&
      parsed.summary
    ) {
      return parsed as CachedWithingsSummary
    }

    return {
      summary: parsed as WithingsHealthSummary,
      checkedAt: null,
    }
  } catch {
    return null
  }
}

function writeCachedSummary(
  account: ConnectedAccount,
  summary: WithingsHealthSummary,
  checkedAt: string
) {
  try {
    window.localStorage.setItem(
      cacheKey(account),
      JSON.stringify({ summary, checkedAt })
    )
  } catch {
    // Cache is only for smoother UI; failures should not block live data.
  }
}

function isUnusableCachedSummary(
  summary: WithingsHealthSummary | null | undefined
) {
  if (!summary) return false
  if (summary.ok === false || summary.needsReconnect) return true
  return (
    summary.sleep.status !== "connected" &&
    summary.steps.status !== "connected" &&
    summary.calories.status !== "connected" &&
    summary.heartRate.status !== "connected"
  )
}

export function useWithingsHealth(
  accounts: ConnectedAccount[],
  options: UseWithingsHealthOptions = {}
): UseWithingsHealthResult {
  const account = useMemo(() => accounts[0] ?? null, [accounts])
  const autoRefreshUnusableCache = options.autoRefreshUnusableCache ?? false
  const [summary, setSummary] = useState<WithingsHealthSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)

  const refresh = useCallback(async (silent = false) => {
    if (!account) {
      setSummary(null)
      setLoading(false)
      setRefreshing(false)
      setError(null)
      setCheckedAt(null)
      return
    }
    if (silent) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    setError(null)
    const result = await getWithingsHealthSummary(account.id)
    if (result.error) {
      setError(result.error)
      setLoading(false)
      setRefreshing(false)
      return
    }
    if (result.data?.ok === false) {
      setError(new Error(result.data.error ?? "Withings returned no usable health data."))
      setSummary(result.data)
      setCheckedAt(new Date().toISOString())
      setLoading(false)
      setRefreshing(false)
      return
    }
    const now = new Date().toISOString()
    setSummary(result.data)
    setCheckedAt(now)
    if (result.data) writeCachedSummary(account, result.data, now)
    setLoading(false)
    setRefreshing(false)
  }, [account])

  useEffect(() => {
    if (!account) {
      setSummary(null)
      setLoading(false)
      setRefreshing(false)
      setCheckedAt(null)
      return
    }

    const cached = readCachedSummary(account)
    const cachedSummary = cached?.summary ?? null
    const unusable = isUnusableCachedSummary(cachedSummary)
    setSummary(unusable ? null : cachedSummary)
    setCheckedAt(cached?.checkedAt ?? null)
    setLoading(false)
    setRefreshing(false)
    setError(null)
    if (unusable && autoRefreshUnusableCache) {
      void refresh(true)
    }
  }, [account, autoRefreshUnusableCache, refresh])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "health")) return
      void refresh(true)
    })
  }, [refresh])

  return { account, summary, loading, refreshing, error, checkedAt, refresh }
}

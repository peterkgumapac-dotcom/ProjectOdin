import { useCallback, useEffect, useMemo, useState } from "react"
import {
  listOdinLearningEvents,
  listOdinPendingItems,
  listOdinScanSnapshots,
  pendingItemToSignal,
  scanSnapshotsToSourceHealth,
  summarizeAgentFreshness,
  summarizePending,
  updateOdinPendingItemStatus,
  type OdinAgentFreshness,
  type OdinLearningEvent,
  type OdinPendingItem,
  type OdinPendingSummary,
  type OdinScanSnapshot,
} from "@/lib/odinResponsibility"
import type {
  OperationsSignal,
  OperationsSignalStatus,
  OperationsSourceHealth,
} from "@/types/operations"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

type OdinResponsibilitySnapshot = {
  items: OdinPendingItem[]
  snapshots: OdinScanSnapshot[]
  learning: OdinLearningEvent[]
}

export function useOdinResponsibility(userId?: string) {
  const [pendingItems, setPendingItems] = useState<OdinPendingItem[]>([])
  const [scanSnapshots, setScanSnapshots] = useState<OdinScanSnapshot[]>([])
  const [learningEvents, setLearningEvents] = useState<OdinLearningEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const refreshAndGet = useCallback(async (): Promise<OdinResponsibilitySnapshot> => {
    if (!userId) {
      return { items: [], snapshots: [], learning: [] }
    }
    setLoading(true)
    setError(null)
    try {
      const [items, snapshots, learning] = await Promise.all([
        listOdinPendingItems(userId),
        listOdinScanSnapshots(userId),
        listOdinLearningEvents(userId),
      ])
      setPendingItems(items)
      setScanSnapshots(snapshots)
      setLearningEvents(learning)
      return { items, snapshots, learning }
    } catch (err) {
      const nextError = err instanceof Error ? err : new Error("Could not load ODIN responsibility data.")
      setError(nextError)
      throw nextError
    } finally {
      setLoading(false)
    }
  }, [userId])

  const refresh = useCallback(async () => {
    await refreshAndGet()
  }, [refreshAndGet])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "council")) return
      void refresh()
    })
  }, [refresh])

  const signals = useMemo<OperationsSignal[]>(
    () => pendingItems.map(pendingItemToSignal),
    [pendingItems]
  )
  const sourceHealth = useMemo<OperationsSourceHealth[]>(
    () => scanSnapshotsToSourceHealth(scanSnapshots),
    [scanSnapshots]
  )
  const pendingSummary = useMemo<OdinPendingSummary>(
    () => summarizePending(pendingItems),
    [pendingItems]
  )
  const agentFreshness = useMemo<OdinAgentFreshness>(
    () => summarizeAgentFreshness(pendingItems),
    [pendingItems]
  )

  const setPendingStatus = useCallback(
    async (id: string, status: OperationsSignalStatus) => {
      await updateOdinPendingItemStatus(id, status)
      setPendingItems((items) =>
        items.map((item) =>
          item.id === id
            ? {
                ...item,
                status,
                bucket:
                  status === "handled" || status === "deferred"
                    ? "done_recently"
                    : status === "waiting"
                      ? "waiting_on_others"
                      : "needs_peter",
                updated_at: new Date().toISOString(),
              }
            : item
        )
      )
    },
    []
  )

  return {
    pendingItems,
    scanSnapshots,
    learningEvents,
    signals,
    sourceHealth,
    pendingSummary,
    loading,
    error,
    refresh,
    refreshAndGet,
    agentFreshness,
    setPendingStatus,
  }
}

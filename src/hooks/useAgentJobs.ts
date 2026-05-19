import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@/hooks/useAuth"
import {
  createAgentJob,
  listAgentJobs,
  type AgentJob,
  type AgentJobType,
} from "@/lib/agentJobs"

const POLL_MS = 12_000

export function useAgentJobs() {
  const { user } = useAuth()
  const [jobs, setJobs] = useState<AgentJob[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    if (!user) {
      setJobs([])
      return
    }
    setLoading(true)
    const { data, error: err } = await listAgentJobs(12)
    if (err) setError(new Error(err.message))
    else {
      setError(null)
      setJobs(data)
    }
    setLoading(false)
  }, [user])

  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void refresh()
    }
    const handleVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refresh()
      }
    }
    refresh()
    const interval = setInterval(tick, POLL_MS)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisible)
    }
    return () => {
      clearInterval(interval)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisible)
      }
    }
  }, [refresh])

  const queueJob = useCallback(
    async (type: AgentJobType, input: Record<string, unknown>) => {
      if (!user) throw new Error("Not signed in.")
      setCreating(true)
      const { data, error: err } = await createAgentJob(user.id, type, input)
      setCreating(false)
      if (err) {
        const next = new Error(err.message)
        setError(next)
        throw next
      }
      await refresh()
      return data
    },
    [refresh, user]
  )

  const latestJob = jobs[0] ?? null
  const latestBrowserResult = useMemo(
    () => jobs.find((job) => job.result?.source === "local_browser") ?? null,
    [jobs]
  )

  return {
    jobs,
    latestJob,
    latestBrowserResult,
    loading,
    creating,
    error,
    queueJob,
    refresh,
  }
}

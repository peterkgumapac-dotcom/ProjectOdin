import { createAgentJobResult, type BrowserScanResult } from "@/lib/agentJobs"

const DEFAULT_DAEMON_URL =
  import.meta.env.VITE_ODIN_BROWSER_DAEMON_URL ?? "http://127.0.0.1:8787"

export type BrowserDaemonStatus = {
  ok: boolean
  running: boolean
  provider: "local_playwright"
  hasSession: boolean
  profileDir: string
  url: string | null
  title: string
  loginRequired: boolean
  pendingActionCount: number
}

export type BrowserProposedAction = {
  id: string
  type: "click"
  label: string
  target: string
  risk: "normal" | "high"
  requires_confirmation: boolean
}

export type BrowserObservation = Omit<
  BrowserScanResult,
  "kind" | "url" | "title" | "loginRequired" | "proposed_actions"
> & {
  kind: "generic"
  url: string
  title: string
  loginRequired: boolean
  proposed_actions: BrowserProposedAction[]
}

type DaemonEnvelope<T> = {
  ok: boolean
  result?: T
  error?: string
}

async function daemonFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${DEFAULT_DAEMON_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  })
  const payload = (await response.json().catch(() => null)) as DaemonEnvelope<T> | null
  if (!response.ok || !payload?.ok) {
    throw new Error(
      payload?.error ??
        `ODIN Browser daemon is not reachable at ${DEFAULT_DAEMON_URL}. Run npm run worker:daemon.`
    )
  }
  return (payload.result ?? payload) as T
}

export async function getBrowserDaemonStatus() {
  return daemonFetch<BrowserDaemonStatus>("/status")
}

export async function openBrowserSession(url: string) {
  return daemonFetch<BrowserObservation>("/session/open", {
    method: "POST",
    body: JSON.stringify({ url }),
  })
}

export async function navigateBrowser(url: string) {
  return daemonFetch<BrowserObservation>("/navigate", {
    method: "POST",
    body: JSON.stringify({ url }),
  })
}

export async function observeBrowserPage() {
  return daemonFetch<BrowserObservation>("/observe", { method: "POST" })
}

export async function runBrowserTask(prompt: string, mode: "observe" | "act") {
  return daemonFetch<BrowserObservation>("/task", {
    method: "POST",
    body: JSON.stringify({ prompt, mode }),
  })
}

export async function confirmBrowserAction(actionId: string) {
  return daemonFetch<BrowserObservation>("/confirm", {
    method: "POST",
    body: JSON.stringify({ actionId }),
  })
}

export async function stopBrowserSession() {
  return daemonFetch<{ stopped: boolean }>("/stop", { method: "POST" })
}

export async function recordBrowserObservation(
  userId: string,
  type: "browser_open" | "browser_observe" | "browser_agent_task",
  input: Record<string, unknown>,
  result: BrowserObservation
) {
  await createAgentJobResult(userId, type, input, result)
}

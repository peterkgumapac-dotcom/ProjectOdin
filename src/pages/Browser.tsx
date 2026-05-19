import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Compass,
  Eye,
  Globe2,
  Loader2,
  LockKeyhole,
  MousePointerClick,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Terminal,
} from "lucide-react"
import {
  LightPageHeader,
  LightPageShell,
} from "@/components/dashboard/LightPageChrome"
import { useAuth } from "@/hooks/useAuth"
import { useAgentJobs } from "@/hooks/useAgentJobs"
import {
  confirmBrowserAction,
  getBrowserDaemonStatus,
  navigateBrowser,
  observeBrowserPage,
  openBrowserSession,
  recordBrowserObservation,
  runBrowserTask,
  stopBrowserSession,
  type BrowserDaemonStatus,
  type BrowserObservation,
  type BrowserProposedAction,
} from "@/lib/localBrowser"

type BrowserMode = "observe" | "act"

const DEFAULT_URL = "https://example.com"

function statusTone(status: BrowserDaemonStatus | null, error: string | null) {
  if (error) return "border-[#bd5a18] bg-[#fff2e8] text-[#9b3e12]"
  if (!status?.hasSession) return "border-[#dfcfb1] bg-[#fffaf1] text-[#6d5334]"
  if (status.loginRequired) return "border-[#d49b4c] bg-[#fff7e5] text-[#8b5c13]"
  return "border-[#74a75b] bg-[#eef7e8] text-[#41692d]"
}

function hostLabel(url: string | null | undefined) {
  if (!url) return "No page"
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function ActionRow({
  action,
  onConfirm,
  busy,
}: {
  action: BrowserProposedAction
  onConfirm: (id: string) => void
  busy: boolean
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#dfcfb1] bg-[#fffaf1] px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-extrabold text-[#2b1d0f]">{action.label}</p>
        <p className="mt-1 text-xs font-bold text-[#8a6b46]">
          {action.risk === "high" ? "Sensitive action. Confirmation required." : "Safe click proposal. Confirmation required."}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onConfirm(action.id)}
        disabled={busy}
        className={[
          "inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-xs font-extrabold transition disabled:opacity-55",
          action.risk === "high"
            ? "border border-[#bd5a18] bg-[#fff2e8] text-[#9b3e12] hover:bg-[#ffe3d1]"
            : "bg-[#b6531c] text-[#fffaf1] hover:bg-[#9f4618]",
        ].join(" ")}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <MousePointerClick size={14} />}
        Confirm click
      </button>
    </div>
  )
}

export function BrowserPage() {
  const { user } = useAuth()
  const { latestBrowserResult } = useAgentJobs()
  const [status, setStatus] = useState<BrowserDaemonStatus | null>(null)
  const [observation, setObservation] = useState<BrowserObservation | null>(null)
  const [url, setUrl] = useState(DEFAULT_URL)
  const [task, setTask] = useState("")
  const [mode, setMode] = useState<BrowserMode>("observe")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [persistError, setPersistError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const pageLabel = observation?.title || status?.title || hostLabel(status?.url)
  const actions = observation?.proposed_actions ?? []
  const currentUrl = observation?.url ?? status?.url ?? null

  const latestItems = useMemo(() => observation?.items?.slice(0, 8) ?? [], [observation])

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getBrowserDaemonStatus())
      setError(null)
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : "ODIN Browser daemon is offline.")
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    const interval = window.setInterval(() => void refreshStatus(), 6_000)
    return () => window.clearInterval(interval)
  }, [refreshStatus])

  useEffect(() => {
    if (observation || latestBrowserResult?.result?.kind !== "generic") return
    setObservation(latestBrowserResult.result as BrowserObservation)
  }, [latestBrowserResult, observation])

  async function persistResult(
    type: "browser_open" | "browser_observe" | "browser_agent_task",
    input: Record<string, unknown>,
    result: BrowserObservation
  ) {
    if (!user) return
    const { error: saveError } = await recordBrowserObservation(user.id, type, input, result)
      .then(() => ({ error: null }))
      .catch((err) => ({ error: err instanceof Error ? err : new Error(String(err)) }))
    if (saveError) {
      setPersistError(saveError.message)
      return
    }
    setPersistError(null)
    setSavedAt(new Date().toISOString())
  }

  async function runBrowserCall(
    label: string,
    call: () => Promise<BrowserObservation>,
    type: "browser_open" | "browser_observe" | "browser_agent_task",
    input: Record<string, unknown>
  ) {
    setBusy(label)
    setError(null)
    try {
      const result = await call()
      setObservation(result)
      if (result.url) setUrl(result.url)
      await persistResult(type, input, result)
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "ODIN Browser could not complete that request.")
    } finally {
      setBusy(null)
    }
  }

  const openSession = () =>
    runBrowserCall("open", () => openBrowserSession(url), "browser_open", { url })

  const navigate = () =>
    runBrowserCall("navigate", () => navigateBrowser(url), "browser_open", { url })

  const observe = () =>
    runBrowserCall("observe", observeBrowserPage, "browser_observe", { url: currentUrl })

  const resumeAfterLogin = () =>
    runBrowserCall("resume", observeBrowserPage, "browser_observe", {
      url: currentUrl,
      loginResume: true,
    })

  const runTask = () =>
    runBrowserCall(
      "task",
      () => runBrowserTask(task || "Observe this page and propose useful safe actions.", mode),
      "browser_agent_task",
      { prompt: task, mode, url: currentUrl }
    )

  const confirmAction = (actionId: string) =>
    runBrowserCall(
      actionId,
      () => confirmBrowserAction(actionId),
      "browser_agent_task",
      { actionId, confirmed: true, url: currentUrl }
    )

  async function stopSession() {
    setBusy("stop")
    setError(null)
    try {
      await stopBrowserSession()
      setObservation(null)
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "ODIN Browser could not stop.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <LightPageShell mainClassName="!px-5 !py-8 sm:!px-8 lg:!px-12">
      <div className="mx-auto w-full max-w-[1680px] space-y-8">
        <LightPageHeader
          title="Browser"
          subtitle="local computer-use"
          action={
            <button
              type="button"
              onClick={() => void refreshStatus()}
              className="odin-light-action h-11 px-5 text-sm"
            >
              <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
              Status
            </button>
          }
        />

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_360px]">
          <div className="odin-light-card rounded-[28px] p-6 md:p-7">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#b6531c]">
                  Local browser
                </p>
                <h2 className="mt-3 max-w-3xl text-4xl font-extrabold leading-[0.96] tracking-[-0.04em] text-[#2b1d0f] md:text-5xl">
                  {pageLabel || "Open a page for ODIN to observe."}
                </h2>
                <p className="mt-4 max-w-2xl text-sm font-bold leading-relaxed text-[#6d5334]">
                  Login stays in the visible browser. ODIN can observe the page and propose actions, but every click needs your confirmation.
                </p>
              </div>
              <div className={["rounded-2xl border px-4 py-3 text-sm font-extrabold", statusTone(status, error)].join(" ")}>
                {error ? "Daemon offline" : status?.loginRequired ? "Login required" : status?.hasSession ? "Session ready" : "No session"}
              </div>
            </div>

            <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
              <label className="grid gap-2">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
                  URL
                </span>
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  className="odin-light-control h-12 px-0 text-lg font-extrabold"
                  placeholder="https://example.com"
                />
              </label>
              <button
                type="button"
                onClick={openSession}
                disabled={Boolean(busy)}
                className="odin-light-action-primary mt-auto h-12 rounded-full px-5 text-sm font-extrabold disabled:opacity-55"
              >
                {busy === "open" ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                Open
              </button>
              <button
                type="button"
                onClick={navigate}
                disabled={Boolean(busy) || !status?.hasSession}
                className="odin-light-action mt-auto h-12 px-5 text-sm disabled:opacity-55"
              >
                <Compass size={15} />
                Navigate
              </button>
            </div>

            {error && (
              <div className="mt-5 rounded-2xl border border-[#bd5a18]/35 bg-[#fff2e8] p-4 text-sm font-bold leading-relaxed text-[#9b3e12]">
                <AlertTriangle size={16} className="mb-2" />
                {error}
                <p className="mt-2 font-mono-data text-xs">
                  Start it with: npm run worker:daemon
                </p>
              </div>
            )}

            <div className="mt-8 grid gap-5 lg:grid-cols-[minmax(280px,0.75fr)_minmax(0,1fr)]">
              <div className="rounded-[24px] border border-[#dfcfb1] bg-[#f8eddb] p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
                      Session
                    </p>
                    <h3 className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-[#2b1d0f]">
                      {hostLabel(currentUrl)}
                    </h3>
                  </div>
                  <Globe2 className="text-[#b6531c]" size={24} />
                </div>
                <div className="mt-5 grid gap-3 text-sm font-bold text-[#6d5334]">
                  <p className="break-all">{currentUrl ?? "No controlled page yet."}</p>
                  <p>Profile: {status?.profileDir ? ".odin/browser-profile" : "offline"}</p>
                  <p>Provider: {status?.provider ?? "local_playwright"}</p>
                  {savedAt && <p>Saved for ODIN: {new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>}
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={observe}
                    disabled={Boolean(busy) || !status?.hasSession}
                    className="odin-light-action h-10 px-4 text-xs disabled:opacity-55"
                  >
                    {busy === "observe" ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
                    Observe
                  </button>
                  <button
                    type="button"
                    onClick={resumeAfterLogin}
                    disabled={Boolean(busy) || !status?.hasSession}
                    className="odin-light-action h-10 px-4 text-xs disabled:opacity-55"
                  >
                    <LockKeyhole size={14} />
                    Resume
                  </button>
                  <button
                    type="button"
                    onClick={() => void stopSession()}
                    disabled={Boolean(busy) || !status?.hasSession}
                    className="odin-light-action h-10 px-4 text-xs disabled:opacity-55"
                  >
                    <Square size={13} />
                    Stop
                  </button>
                </div>
              </div>

              <div className="rounded-[24px] border border-[#dfcfb1] bg-[#fffaf1] p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
                      Computer-use task
                    </p>
                    <h3 className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-[#2b1d0f]">
                      {mode === "act" ? "Propose confirmed clicks" : "Observe and summarize"}
                    </h3>
                  </div>
                  <div className="rounded-full border border-[#dfcfb1] bg-[#f8eddb] p-1">
                    {(["observe", "act"] as BrowserMode[]).map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => setMode(item)}
                        className={[
                          "h-9 rounded-full px-4 text-xs font-extrabold capitalize transition",
                          mode === item ? "bg-[#b6531c] text-[#fffaf1]" : "text-[#6d5334] hover:bg-[#f0dec7]",
                        ].join(" ")}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  className="mt-5 min-h-28 w-full resize-none rounded-2xl border border-[#dfcfb1] bg-[#fffaf1] p-4 text-sm font-bold leading-relaxed text-[#2b1d0f] outline-none transition focus:border-[#b6531c]"
                  placeholder="Example: Find the billing page, or observe this page and tell me what needs attention."
                />
                <button
                  type="button"
                  onClick={runTask}
                  disabled={Boolean(busy) || !status?.hasSession}
                  className="odin-light-action-primary mt-4 h-11 rounded-full px-5 text-sm font-extrabold disabled:opacity-55"
                >
                  {busy === "task" ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />}
                  {mode === "act" ? "Propose actions" : "Observe page"}
                </button>
              </div>
            </div>
          </div>

          <aside className="odin-light-card rounded-[28px] p-6">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
              Safety contract
            </p>
            <h3 className="mt-4 text-3xl font-extrabold tracking-[-0.04em] text-[#2b1d0f]">
              You log in. ODIN resumes.
            </h3>
            <div className="mt-6 grid gap-4 text-sm font-bold leading-relaxed text-[#6d5334]">
              <p className="flex gap-3">
                <ShieldCheck className="mt-0.5 shrink-0 text-[#5b883f]" size={17} />
                Passwords, 2FA codes, payment data, and hidden inputs are not read or stored.
              </p>
              <p className="flex gap-3">
                <MousePointerClick className="mt-0.5 shrink-0 text-[#b6531c]" size={17} />
                Act mode only proposes clicks. You confirm before ODIN touches the page.
              </p>
              <p className="flex gap-3">
                <Terminal className="mt-0.5 shrink-0 text-[#9b815e]" size={17} />
                Local daemon only: 127.0.0.1, persistent local profile.
              </p>
            </div>
            {persistError && (
              <div className="mt-6 rounded-2xl border border-[#d49b4c] bg-[#fff7e5] p-4 text-xs font-bold leading-relaxed text-[#8b5c13]">
                Browser worked locally, but ODIN memory logging failed: {persistError}
              </div>
            )}
          </aside>
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="odin-light-card rounded-[28px] p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#b6531c]">
                  Evidence
                </p>
                <h3 className="mt-3 text-3xl font-extrabold tracking-[-0.04em] text-[#2b1d0f]">
                  Latest observation
                </h3>
              </div>
              {observation?.loginRequired ? (
                <LockKeyhole className="text-[#d07a1f]" size={24} />
              ) : (
                <CheckCircle2 className="text-[#5b883f]" size={24} />
              )}
            </div>
            <p className="mt-5 text-base font-bold leading-relaxed text-[#6d5334]">
              {observation?.summary ?? "Open a browser session, then observe the page."}
            </p>
            {observation?.warnings?.length ? (
              <div className="mt-5 grid gap-2">
                {observation.warnings.map((warning) => (
                  <p
                    key={warning}
                    className="rounded-2xl border border-[#d49b4c] bg-[#fff7e5] px-4 py-3 text-xs font-bold text-[#8b5c13]"
                  >
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="odin-light-card rounded-[28px] p-6">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
              Actions
            </p>
            <div className="mt-4 grid gap-3">
              {actions.length ? (
                actions.map((action) => (
                  <ActionRow
                    key={action.id}
                    action={action}
                    busy={busy === action.id}
                    onConfirm={(id) => void confirmAction(id)}
                  />
                ))
              ) : (
                <div className="rounded-2xl border border-[#dfcfb1] bg-[#f8eddb] px-4 py-5 text-sm font-bold text-[#6d5334]">
                  No pending confirmed-click proposals.
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="odin-light-card rounded-[28px] p-6">
          <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#9b815e]">
            Page controls found
          </p>
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {latestItems.length ? (
              latestItems.map((item, index) => (
                <div
                  key={`${item.title}-${index}`}
                  className="min-h-28 rounded-2xl border border-[#dfcfb1] bg-[#fffaf1] p-4"
                >
                  <p className="line-clamp-2 text-sm font-extrabold text-[#2b1d0f]">
                    {item.title}
                  </p>
                  <p className="mt-3 text-xs font-bold text-[#8a6b46]">
                    {item.snippet || item.source}
                  </p>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-[#dfcfb1] bg-[#f8eddb] px-4 py-5 text-sm font-bold text-[#6d5334] md:col-span-2 xl:col-span-4">
                ODIN has not observed controls yet.
              </div>
            )}
          </div>
        </section>
      </div>
    </LightPageShell>
  )
}

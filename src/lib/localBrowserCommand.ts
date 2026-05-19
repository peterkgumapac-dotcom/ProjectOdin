import {
  observeBrowserPage,
  openBrowserSession,
  recordBrowserObservation,
  runBrowserTask,
  type BrowserObservation,
} from "@/lib/localBrowser"
import type { OdinCommandResponse } from "@/lib/odinOrchestrator"
import type { OperationsSignal } from "@/types/operations"

const BROWSER_ROUTE = "/browser"
const OFFLINE_HINT =
  "Start it in this project with: npm run worker:daemon"

const explicitUrlPattern = /https?:\/\/[^\s<>"']+/i
const domainPattern =
  /^(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s]*)?$/i

function compact(value: string, max = 420) {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function cleanCandidate(value: string) {
  return value
    .replace(/^[\s,.:;-]+/, "")
    .replace(/\s+(?:in|with|using)\s+(?:the\s+)?(?:odin\s+)?(?:browser|web|internet|computer-use|computer use)$/i, "")
    .replace(/^(?:and\s+)?(?:please\s+)?/, "")
    .replace(/[),.;\s]+$/g, "")
    .trim()
}

function normalizeUrl(value: string) {
  const candidate = cleanCandidate(value)
  if (!candidate) return null
  if (/^https?:\/\//i.test(candidate)) return candidate
  if (!domainPattern.test(candidate)) return null
  return `https://${candidate}`
}

function hostLabel(url?: string | null) {
  if (!url) return "browser"
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function extractUrl(command: string) {
  const explicit = command.match(explicitUrlPattern)?.[0]
  if (explicit) return normalizeUrl(explicit)

  const candidates = [
    /\b(?:open|browse|visit|load|go to|navigate to)\s+(?:the\s+)?(?:site\s+)?(.+)$/i,
    /\b(?:open|browse|visit|load|go to|navigate to)\s+(.+?)\s+(?:in|with|using)\s+(?:the\s+)?(?:browser|web|computer-use|computer use)\b/i,
  ]

  for (const pattern of candidates) {
    const match = command.match(pattern)
    if (!match?.[1]) continue
    const url = normalizeUrl(match[1])
    if (url) return url
  }

  return null
}

function extractSearchQuery(command: string) {
  const patterns = [
    /\b(?:search(?:\s+the\s+(?:web|internet))?(?:\s+for)?|google|look\s+up|lookup|find\s+online|browse(?:\s+the\s+web)?(?:\s+for)?)\s+(.+)$/i,
    /\b(?:use\s+the\s+browser\s+to|browser\s+search)\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = command.match(pattern)
    if (!match?.[1]) continue
    const query = cleanCandidate(match[1])
      .replace(/^(?:and\s+)?search\s+/i, "")
      .replace(/^for\s+/i, "")
      .trim()
    if (query && !normalizeUrl(query)) return query
  }

  return null
}

function wantsBrowserRoute(command: string) {
  return /\b(?:open|show|go to|take me to)\s+(?:the\s+)?(?:odin\s+)?(?:browser|web browser|computer-use|computer use)\b/i.test(
    command
  )
}

function wantsObserve(command: string) {
  return /\b(?:observe|summari[sz]e|read|inspect|what'?s on|what is on|resume)\b/i.test(command) &&
    /\b(?:browser|page|site|website|web|screen)\b/i.test(command)
}

function wantsAct(command: string) {
  return /\b(?:act|click|press|fill|submit|send|delete|purchase|buy|change|select|choose|book|reserve|approve|cancel|find .*page|find .*button|find .*link)\b/i.test(
    command
  )
}

export function isLocalBrowserCommand(command: string) {
  const lower = command.toLowerCase()
  return Boolean(
    wantsBrowserRoute(command) ||
      extractUrl(command) ||
      extractSearchQuery(command) ||
      wantsObserve(command) ||
      /\b(?:browser|browse|web browser|computer-use|computer use)\b/.test(lower)
  )
}

function offlineResponse(error: unknown): OdinCommandResponse {
  const detail = error instanceof Error ? error.message : "ODIN Browser daemon is offline."
  const text =
    `The Browser module is installed, but the local browser daemon is offline. ${OFFLINE_HINT}.`
  return {
    spokenText:
      "The Browser module is installed, but the local browser daemon is offline. Start the worker daemon, then ask me to browse again.",
    displayText: `${text}\n\n${detail}`,
    signals: [],
    sourceLinks: [],
    drafts: [],
    warnings: [detail],
    toolRuns: [{ tool: "local_browser_daemon", status: "failed" }],
    suggestions: [
      "Open Browser.",
      "Start npm run worker:daemon.",
      "Then ask: search web for something.",
    ],
    conversationState: {
      activeTopic: "browser",
      unresolvedQuestion: "Local browser daemon is offline.",
    },
  }
}

function browserSignal(observation: BrowserObservation): OperationsSignal {
  return {
    id: `browser-${crypto.randomUUID()}`,
    source: "browser",
    category: observation.loginRequired ? "waiting" : "routine",
    title: observation.loginRequired
      ? `Login required on ${hostLabel(observation.url)}`
      : observation.title || `Browser: ${hostLabel(observation.url)}`,
    summary: compact(observation.summary || "ODIN observed the controlled browser page."),
    evidence: observation.url,
    nextAction: observation.loginRequired
      ? "Finish login in the visible browser, then say resume browser."
      : observation.proposed_actions.length
        ? "Open the Browser page and confirm the proposed action you want."
        : "Ask ODIN to propose actions if you want it to prepare clicks.",
    sourceUrl: observation.url,
    business: "Personal",
    status: observation.loginRequired ? "waiting" : "open",
  }
}

function responseFromObservation(
  observation: BrowserObservation,
  intro: string,
  recordWarning?: string
): OdinCommandResponse {
  const proposedCount = observation.proposed_actions.length
  const loginText = observation.loginRequired
    ? "Login is required. Complete it manually in the visible browser, then say “resume browser.”"
    : null
  const actionsText = proposedCount
    ? `${proposedCount} action${proposedCount === 1 ? "" : "s"} proposed. Confirm inside Browser before ODIN clicks.`
    : null
  const summary = compact(observation.summary || "The page is open.")
  const displayText = [
    intro,
    "",
    summary,
    loginText,
    actionsText,
    observation.url ? `Page: ${observation.url}` : null,
  ]
    .filter(Boolean)
    .join("\n")

  return {
    spokenText: compact(
      `${intro} ${loginText ?? summary} ${actionsText ?? ""}`,
      520
    ),
    displayText,
    signals: [browserSignal(observation)],
    sourceLinks: observation.url
      ? [{ label: observation.title || hostLabel(observation.url), url: observation.url, source: "browser" }]
      : [],
    drafts: [],
    warnings: [...(observation.warnings ?? []), ...(recordWarning ? [recordWarning] : [])],
    toolRuns: [{ tool: "local_browser_daemon", status: "ok" }],
    suggestions: observation.loginRequired
      ? ["Resume browser after login.", "Observe this page.", "Stop browser."]
      : proposedCount
        ? ["Open Browser.", "Confirm action in Browser.", "Observe again."]
        : ["Observe this page.", "Propose actions.", "Open Browser."],
    conversationState: {
      activeTopic: "browser",
      unresolvedQuestion: observation.loginRequired ? "Waiting for manual login." : null,
    },
  }
}

async function saveObservation(
  userId: string | undefined,
  type: "browser_open" | "browser_observe" | "browser_agent_task",
  input: Record<string, unknown>,
  result: BrowserObservation
) {
  if (!userId) return null
  try {
    await recordBrowserObservation(userId, type, input, result)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : "Browser result was not saved for ODIN."
  }
}

export async function runLocalBrowserCommand(
  command: string,
  options: { userId?: string } = {}
): Promise<{ response: OdinCommandResponse; route: string }> {
  if (wantsBrowserRoute(command)) {
    return {
      route: BROWSER_ROUTE,
      response: {
        spokenText: "Opening Browser, Peter.",
        displayText:
          "Opening Browser.\n\nUse it for local logged-in browsing, manual login, observation, and confirmed actions.",
        signals: [],
        sourceLinks: [],
        drafts: [],
        warnings: [],
        toolRuns: [{ tool: "local_browser_route", status: "ok" }],
        suggestions: ["Open a site.", "Search the web.", "Observe this page."],
        conversationState: { activeTopic: "browser", unresolvedQuestion: null },
      },
    }
  }

  try {
    const url = extractUrl(command)
    if (url) {
      const result = await openBrowserSession(url)
      const warning = await saveObservation(options.userId, "browser_open", { url }, result)
      return {
        route: BROWSER_ROUTE,
        response: responseFromObservation(result, `Opened ${hostLabel(result.url)} in the local browser.`, warning ?? undefined),
      }
    }

    const query = extractSearchQuery(command)
    if (query) {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`
      const result = await openBrowserSession(searchUrl)
      const warning = await saveObservation(options.userId, "browser_open", { query, url: searchUrl }, result)
      return {
        route: BROWSER_ROUTE,
        response: responseFromObservation(result, `Searching the web for “${compact(query, 90)}”.`, warning ?? undefined),
      }
    }

    if (wantsObserve(command)) {
      const result = await observeBrowserPage()
      const warning = await saveObservation(options.userId, "browser_observe", { command }, result)
      return {
        route: BROWSER_ROUTE,
        response: responseFromObservation(result, "Observed the current browser page.", warning ?? undefined),
      }
    }

    const mode = wantsAct(command) ? "act" : "observe"
    const result = await runBrowserTask(command, mode)
    const warning = await saveObservation(options.userId, "browser_agent_task", { command, mode }, result)
    return {
      route: BROWSER_ROUTE,
      response: responseFromObservation(
        result,
        mode === "act"
          ? "I prepared browser actions for confirmation."
          : "I observed the browser for that task.",
        warning ?? undefined
      ),
    }
  } catch (err) {
    return { route: BROWSER_ROUTE, response: offlineResponse(err) }
  }
}

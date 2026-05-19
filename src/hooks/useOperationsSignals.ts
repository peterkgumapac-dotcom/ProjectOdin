import { useCallback, useEffect, useMemo, useState } from "react"
import type { ConnectedAccount } from "@/hooks/useConnectedAccounts"
import type { CalendarEvent } from "@/lib/connectors/calendar"
import type {
  OperationsBusiness,
  OperationsSignal,
  OperationsSignalStatus,
  OperationsSourceHealth,
} from "@/types/operations"

const STATUS_KEY = "odin.operations.signal-status.v1"
const LEGACY_GMAIL_SIGNAL_CACHE_KEY = "odin.gmail.signals.last-seven-days.v1"
const ACCOUNT_FOCUS_RULE_ID = "account_focus_suppressed"

function isHallSuppressed(account: ConnectedAccount): boolean {
  return account.workflowRules.some(
    (rule) =>
      rule.enabled &&
      (rule.id === ACCOUNT_FOCUS_RULE_ID ||
        (rule.trigger === "new_email" &&
          rule.action === "skip_inbox" &&
          rule.condition.toLowerCase() === "account"))
  )
}

function readStatuses(): Record<string, OperationsSignalStatus> {
  if (typeof window === "undefined") return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STATUS_KEY) ?? "{}")
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeStatuses(statuses: Record<string, OperationsSignalStatus>) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STATUS_KEY, JSON.stringify(statuses))
}

function clearLegacyLocalSignals() {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(LEGACY_GMAIL_SIGNAL_CACHE_KEY)
}

function businessFromText(text: string): OperationsBusiness {
  const lower = text.toLowerCase()
  if (
    lower.includes("dinbnb") ||
    lower.includes("lev") ||
    lower.includes("oslo") ||
    lower.includes("bergen") ||
    lower.includes("guesty") ||
    lower.includes("hostaway") ||
    lower.includes("pricelabs") ||
    lower.includes("kg-") ||
    /\b(emil|jonas|kasper|nameda|diana|king emmanuel|rob|gerson|jane)\b/i.test(text) ||
    lower.includes("get team") ||
    lower.includes("apartment hotel")
  ) {
    return "Dinbnb"
  }
  if (
    lower.includes("stay minty") ||
    lower.includes("stayminty") ||
    lower.includes("smoky") ||
    lower.includes("smokies") ||
    lower.includes("nashville") ||
    lower.includes("stellara") ||
    lower.includes("dunn's creek") ||
    lower.includes("dunns creek") ||
    lower.includes("evermere") ||
    lower.includes("glamp") ||
    lower.includes("cabin") ||
    /\b(meredith|kelli|reveen|jessica|eric|andy|sean|brandi|shiela|skie)\b/i.test(text)
  ) {
    return "Stay Minty"
  }
  return "Personal"
}

function eventStart(event: CalendarEvent): Date | null {
  const raw = event.start?.dateTime ?? event.start?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function eventStartMs(event: CalendarEvent): number {
  const start = eventStart(event)
  return start ? start.getTime() : Number.MAX_SAFE_INTEGER
}

function timeLabel(date: Date | null): string {
  if (!date) return "today"
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function isAllDayEvent(event: CalendarEvent): boolean {
  return Boolean(event.start?.date && !event.start?.dateTime)
}

function upcomingCalendarEvents(events: CalendarEvent[], limit: number): CalendarEvent[] {
  const nowFloor = Date.now() - 15 * 60 * 1000
  const todayKey = localDateKey(new Date())
  return events
    .filter((event) => {
      if (isAllDayEvent(event)) {
        return event.start?.date === todayKey
      }
      const start = eventStart(event)
      return start instanceof Date && Number.isFinite(start.getTime()) && start.getTime() >= nowFloor
    })
    .sort((a, b) => eventStartMs(a) - eventStartMs(b))
    .slice(0, limit)
}

export function useOperationsSignals(args: {
  googleAccounts: ConnectedAccount[]
  slackAccounts: ConnectedAccount[]
  events: CalendarEvent[]
  eventsLoading: boolean
  eventsError: Error | null
  eventsCheckedAt?: string | null
}) {
  const { googleAccounts, slackAccounts, events, eventsLoading, eventsError } =
    args
  const hallGoogleAccounts = useMemo(
    () => googleAccounts.filter((account) => !isHallSuppressed(account)),
    [googleAccounts]
  )
  const hallSlackAccounts = useMemo(
    () => slackAccounts.filter((account) => !isHallSuppressed(account)),
    [slackAccounts]
  )
  const [statuses, setStatuses] = useState<Record<string, OperationsSignalStatus>>(
    () => readStatuses()
  )

  useEffect(() => {
    writeStatuses(statuses)
  }, [statuses])

  useEffect(() => {
    clearLegacyLocalSignals()
  }, [])

  const refresh = useCallback(async () => {
    clearLegacyLocalSignals()
  }, [])

  const setSignalStatus = useCallback(
    (id: string, status: OperationsSignalStatus) => {
      setStatuses((prev) => {
        const next = { ...prev }
        if (status === "open") {
          delete next[id]
        } else {
          next[id] = status
        }
        return next
      })
    },
    []
  )

  const sourceHealth = useMemo<OperationsSourceHealth[]>(
    () => [
      {
        id: "gmail",
        label: "Gmail",
        state: googleAccounts.length === 0 ? "disconnected" : "attention",
        detail:
          googleAccounts.length === 0
            ? "Connect Google in Accounts"
            : hallGoogleAccounts.length === 0
              ? "Connected, but muted from Hall source briefs."
              : `${hallGoogleAccounts.length} account${hallGoogleAccounts.length === 1 ? "" : "s"} connected. Priority email must come from a Claude/Codex agent brief.`,
      },
      {
        id: "slack",
        label: "Slack",
        state: slackAccounts.length === 0 ? "disconnected" : "attention",
        detail:
          slackAccounts.length === 0
            ? "Connect Slack in Accounts"
            : hallSlackAccounts.length === 0
              ? "Connected, but muted from Hall source briefs."
              : `${hallSlackAccounts.length} workspace${hallSlackAccounts.length === 1 ? "" : "s"} connected. Priority Slack must come from a Claude/Codex agent brief.`,
      },
      {
        id: "calendar",
        label: "Calendar",
        state:
          googleAccounts.length === 0
            ? "disconnected"
            : eventsLoading
              ? "syncing"
              : eventsError
                ? "attention"
                : "healthy",
        detail:
          googleAccounts.length === 0
            ? "Connect Google Calendar"
            : eventsLoading
              ? "Checking today"
              : eventsError
                ? eventsError.message
                : `${events.length} event${events.length === 1 ? "" : "s"} today${args.eventsCheckedAt ? " · last calendar read" : " · refresh calendar for today"}`,
        checkedAt: args.eventsCheckedAt ?? undefined,
      },
    ],
    [
      args.eventsCheckedAt,
      events.length,
      eventsError,
      eventsLoading,
      googleAccounts.length,
      hallGoogleAccounts.length,
      hallSlackAccounts.length,
      slackAccounts.length,
    ]
  )

  const signals = useMemo<OperationsSignal[]>(() => {
    const next: OperationsSignal[] = []
    const upcomingEvents = upcomingCalendarEvents(events, 3)

    if (googleAccounts.length === 0) {
      next.push({
        id: "system-connect-google",
        source: "system",
        category: "follow_up",
        title: "Connect Google",
        summary: "Gmail and Calendar are not available to the central hub yet.",
        nextAction: "Open Accounts and connect Google.",
        business: "Personal",
        status: "open",
      })
    } else if (hallGoogleAccounts.length === 0) {
      next.push({
        id: "gmail-muted",
        source: "system",
        category: "quiet",
        title: "Gmail muted from Hall priorities",
        summary:
          "Connected Gmail accounts remain available, but none are allowed into the Hall brief.",
        nextAction: "Re-include an account when you want it available to source briefs.",
        business: "Personal",
        status: "open",
      })
    }

    if (slackAccounts.length === 0) {
      next.push({
        id: "system-connect-slack",
        source: "system",
        category: "follow_up",
        title: "Connect Slack",
        summary: "Slack workspaces are not available to the central hub yet.",
        nextAction: "Open Accounts and connect Slack.",
        business: "Personal",
        status: "open",
      })
    } else if (hallSlackAccounts.length === 0) {
      next.push({
        id: "slack-muted",
        source: "system",
        category: "quiet",
        title: "Slack muted from Hall priorities",
        summary:
          "Connected Slack workspaces remain available, but none are allowed into the Hall brief.",
        nextAction: "Re-include a workspace when you want it available to source briefs.",
        business: "Personal",
        status: "open",
      })
    }

    if (eventsError) {
      next.push({
        id: "calendar-error",
        source: "calendar",
        category: "urgent",
        title: "Calendar needs attention",
        summary: eventsError.message,
        nextAction: "Reconnect Google Calendar or retry from Calendar.",
        business: "Personal",
        status: "open",
      })
    } else if (!eventsLoading && upcomingEvents.length > 0) {
      for (const event of upcomingEvents) {
        const start = eventStart(event)
        next.push({
          id: `calendar-${event.sourceAccountId ?? "account"}-${event.id}`,
          source: "calendar",
          category: "today",
          title: event.summary ?? "Calendar commitment",
          summary: `${timeLabel(start)}${event.sourceAccountLabel ? ` · ${event.sourceAccountLabel}` : ""}`,
          evidence: event.location || event.organizer?.email,
          nextAction: "Use this to anchor today's schedule and follow-ups.",
          dueAt: start?.toISOString(),
          business: businessFromText(
            `${event.summary ?? ""} ${event.sourceAccountLabel ?? ""} ${event.location ?? ""}`
          ),
          status: "open",
        })
      }
    } else if (!eventsLoading && googleAccounts.length > 0 && events.length > 0) {
      next.push({
        id: "calendar-loaded-today",
        source: "calendar",
        category: "today",
        title: `${events.length} calendar event${events.length === 1 ? "" : "s"} today`,
        summary: "Calendar is connected and today has meetings. Open Calendar to review upcoming times.",
        nextAction: "Open Calendar and review remaining events for today.",
        business: "Personal",
        status: "open",
      })
    } else if (!eventsLoading && googleAccounts.length > 0) {
      next.push({
        id: "calendar-clear-today",
        source: "calendar",
        category: "quiet",
        title: "Calendar is clear today",
        summary: "No remaining Google Calendar events are scheduled today.",
        business: "Personal",
        status: "open",
      })
    }

    return next.map((signal) => ({
      ...signal,
      status: statuses[signal.id] ?? signal.status,
    }))
  }, [
    events,
    eventsError,
    eventsLoading,
    googleAccounts.length,
    hallGoogleAccounts.length,
    hallSlackAccounts.length,
    slackAccounts.length,
    statuses,
  ])

  return {
    signals,
    sourceHealth,
    setSignalStatus,
    gmailUnreadTotal: 0,
    slackUnreadTotal: 0,
    loading: eventsLoading,
    refresh,
  }
}

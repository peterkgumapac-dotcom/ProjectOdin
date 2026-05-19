import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { supabase } from "@/lib/supabaseClient"
import {
  formatOdinResponse,
  invokeOdinCommand,
  type OdinCommandMode,
  type OdinScanSource,
} from "@/lib/odinOrchestrator"
import { toneForMode } from "@/lib/odinPersona"
import {
  isLocalBrowserCommand,
  runLocalBrowserCommand,
} from "@/lib/localBrowserCommand"
import { resolveWeatherLocationForOdin } from "@/lib/weatherLocation"
import { useAuth } from "@/hooks/useAuth"
import { createOdinDecisionMemory } from "@/lib/odinMemory"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const HISTORY_LIMIT = 12
const CONTEXT_LIMIT = 12
type ChatRole = "user" | "assistant"
type DigestPhase = "idle" | "received" | "routing" | "digesting" | "saving" | "ready" | "error"
const QUICK_PROMPTS = [
  "What matters now?",
  "Give me a morning brief.",
  "Scan Slack DMs.",
  "Read my calendar.",
]

interface ChatRow {
  id: string
  role: ChatRole | "system"
  content: string
  created_at: string
}

interface DecisionCandidate {
  title: string
  chosen: string
  suggested: string
  topic: string
}

interface ChatPanelProps {
  initialDraft?: string
  autoSubmitKey?: number
}

function isVisibleRole(role: string): role is ChatRow["role"] {
  return role === "user" || role === "assistant" || role === "system"
}

function modeForPrompt(prompt: string): OdinCommandMode {
  const lower = prompt.toLowerCase()
  const mentionsSlack = /\b(slack|dm|dms|channel|council)\b/.test(lower)
  const mentionsGmail = /\b(gmail|email|emails|inbox|mail)\b/.test(lower)
  const mentionsCalendar = /\b(calendar|schedule|meeting|agenda|event|events)\b/.test(lower)
  const mentionsHealth = /\b(vital|vitals|health|withings|heart|pulse|bpm|steps|calories|sleep|resting|watch)\b/.test(lower)
  const mentionsWeather = /\b(weather|forecast|temperature|rain|raining|storm|hot|cold|humidity|outside|umbrella)\b/.test(lower)
  const mentionsBrowser =
    /\b(browser|browse|web browser|computer-use|computer use|visible page)\b/.test(lower) ||
    /https?:\/\/\S+/i.test(prompt)
  if (/\b(wake up odin|good morning odin|morning brief|start my day)\b/.test(lower)) {
    return "brief"
  }
  if (/\b(research|investigate|analyze|analyse|process|summari[sz]e|compare|strategy|think through|break down)\b/.test(lower)) {
    return "research"
  }
  const sourceCount = [mentionsSlack, mentionsGmail, mentionsCalendar, mentionsHealth, mentionsWeather, mentionsBrowser].filter(Boolean).length
  if (sourceCount > 1) return "combined"
  if (mentionsSlack) return "slack"
  if (mentionsGmail) return "gmail"
  if (mentionsCalendar) return "calendar"
  if (mentionsHealth) return "health"
  if (mentionsWeather) return "weather"
  if (mentionsBrowser) return "browser"
  if (/\b(brief|scan|what needs|attention|priority|priorities|today|now|daily|my day|operations|ops|anything urgent|what matters)\b/.test(lower)) {
    return "brief"
  }
  return "chat"
}

function promptNeedsWeather(prompt: string): boolean {
  return /\b(weather|forecast|temperature|rain|raining|storm|hot|cold|humidity|outside|umbrella)\b/i.test(prompt)
}

function promptRequestsFreshSource(prompt: string): boolean {
  return /\b(read|check|scan|refresh|pull|look at|priority|priorities|what matters|needs attention|urgent)\b/i.test(prompt)
}

function scanSourcesForPrompt(mode: OdinCommandMode, prompt: string): OdinScanSource[] | undefined {
  if (mode === "weather") return ["weather"]
  if (!promptRequestsFreshSource(prompt)) return undefined

  const lower = prompt.toLowerCase()
  const sources = new Set<OdinScanSource>()
  if (mode === "gmail" || /\b(gmail|email|emails|inbox|mail)\b/.test(lower)) sources.add("gmail")
  if (mode === "slack" || /\b(slack|dm|dms|channel|council)\b/.test(lower)) sources.add("slack")
  if (mode === "calendar" || /\b(calendar|schedule|meeting|agenda|event|events)\b/.test(lower)) sources.add("calendar")
  if (mode === "health" || /\b(vital|vitals|health|withings|heart|pulse|bpm|steps|calories|sleep|resting|watch)\b/.test(lower)) sources.add("health")
  if (mode === "combined") {
    if (/\b(gmail|email|emails|inbox|mail)\b/.test(lower)) sources.add("gmail")
    if (/\b(slack|dm|dms|channel|council)\b/.test(lower)) sources.add("slack")
    if (/\b(calendar|schedule|meeting|agenda|event|events)\b/.test(lower)) sources.add("calendar")
    if (/\b(vital|vitals|health|withings|heart|pulse|bpm|steps|calories|sleep|resting|watch)\b/.test(lower)) sources.add("health")
  }

  return sources.size ? [...sources] : undefined
}

function promptIsContextualFollowUp(prompt: string): boolean {
  return /\b(first|second|third|that|this|those|it|them|more|explain|why|draft|reply|tell me more|yes|no|continue|go on|keep going|what about|how about|okay|ok|sure|details|more details|do it|sounds good|what do you mean)\b/i.test(
    prompt
  )
}

function digestLabel(phase: DigestPhase) {
  if (phase === "received") return "received"
  if (phase === "routing") return "routing"
  if (phase === "digesting") return "digesting"
  if (phase === "saving") return "saving"
  if (phase === "ready") return "ready"
  if (phase === "error") return "needs attention"
  return "standby"
}

function digestDetail(phase: DigestPhase) {
  if (phase === "received") return "Your command landed."
  if (phase === "routing") return "ODIN is classifying intent and needed sources."
  if (phase === "digesting") return "ODIN is reading live context, memory, and source summaries."
  if (phase === "saving") return "Answer received; saving the conversation."
  if (phase === "ready") return "Answer is ready."
  if (phase === "error") return "ODIN hit a fault; your message is still visible."
  return "ODIN is standing by."
}

function formatDigestElapsed(ms: number) {
  if (ms <= 0) return "0.0s"
  return `${(ms / 1000).toFixed(1)}s`
}

function messageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function splitSections(content: string) {
  const headings = new Set(["Signals:", "Source links:", "Drafts:", "Try next:", "Warnings:"])
  const sections: Array<{ title: string; lines: string[] }> = [
    { title: "Answer", lines: [] },
  ]

  content.split("\n").forEach((rawLine) => {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()
    if (headings.has(trimmed)) {
      sections.push({ title: trimmed.replace(":", ""), lines: [] })
      return
    }
    sections[sections.length - 1].lines.push(line)
  })

  return sections
    .map((section) => ({
      ...section,
      lines: section.lines.filter((line, index, lines) => {
        if (line.trim()) return true
        return Boolean(lines[index - 1]?.trim() && lines[index + 1]?.trim())
      }),
    }))
    .filter((section) => section.lines.some((line) => line.trim()))
}

function renderLinkedLine(line: string) {
  const urlMatch = line.match(/https?:\/\/\S+/)
  if (!urlMatch) return line
  const url = urlMatch[0]
  const before = line.slice(0, urlMatch.index)
  const after = line.slice((urlMatch.index ?? 0) + url.length)
  return (
    <>
      {before}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-gold underline underline-offset-4 hover:text-foreground"
      >
        source
      </a>
      {after}
    </>
  )
}

function compactText(value: string, max = 220): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function firstSentence(value: string): string {
  return compactText(value.split(/(?<=[.!?])\s+/)[0] ?? value, 180)
}

function inferDecisionCandidate(
  userPrompt: string,
  previousAssistant?: string
): DecisionCandidate | null {
  const prompt = userPrompt.trim()
  const lower = prompt.toLowerCase()
  const decisionPattern =
    /\b(no\b|yes\b|instead|actually|always|never|case by case|just this once|don't|do not|dont|go with|choose|approve|decline|reject|accept|dispute|cancel|defer|skip|mute|suppress|notify|lock the eye|draft it|send that|same approach)\b/i
  if (!decisionPattern.test(prompt)) return null
  if (prompt.endsWith("?") && !/\b(always|never|instead|same approach|go with|choose|dispute|cancel|approve|decline|lock the eye)\b/i.test(prompt)) {
    return null
  }

  const topic =
    previousAssistant
      ? firstSentence(previousAssistant)
      : "ODIN conversation choice"
  const title =
    /\b(chargeback|dispute|cancel)\b/.test(lower)
      ? "Chargeback strategy"
      : /\b(lock the eye|nap|sleep|rest)\b/.test(lower)
        ? "Personal ops override"
        : /\b(always|never|notify|mute|suppress)\b/.test(lower)
          ? "Operational preference"
          : "Conversation decision"

  return {
    title,
    chosen: compactText(prompt, 260),
    suggested: previousAssistant ? compactText(previousAssistant, 360) : "No prior ODIN suggestion captured in this chat.",
    topic,
  }
}

function memoryContentForDecision(
  candidate: DecisionCandidate,
  scope: "Always do this" | "Case by case" | "Just this once"
): string {
  return [
    `Scope: ${scope}.`,
    `Topic/context: ${candidate.topic}`,
    `ODIN suggested/context: ${candidate.suggested}`,
    `Peter chose: ${candidate.chosen}`,
    "Use this as decision memory next time a similar situation appears; ask for confirmation if stakes are high or context differs.",
  ].join(" ")
}

function MessageContent({ content }: { content: string }) {
  const sections = splitSections(content)

  return (
    <div className="space-y-3">
      {sections.map((section) => {
        const paragraphs = section.lines
          .join("\n")
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)

        if (section.title !== "Answer") {
          return (
            <div
              key={section.title}
              className="rounded-md border border-border/60 bg-background/35 p-3"
            >
              <p className="label-track text-[10px] text-gold">{section.title}</p>
              <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                {section.lines
                  .filter((line) => line.trim())
                  .slice(0, 8)
                  .map((line, index) => (
                    <p key={`${section.title}-${index}`} className="break-words">
                      {renderLinkedLine(line.replace(/^[-\d.]+\s*/, ""))}
                    </p>
                  ))}
              </div>
            </div>
          )
        }

        return (
          <div key={section.title} className="space-y-3">
            {paragraphs.map((paragraph, index) => (
              <p key={index} className="break-words">
                {renderLinkedLine(paragraph)}
              </p>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function ChatMessage({ message }: { message: ChatRow }) {
  if (message.role === "system") {
    return (
      <div className="mx-auto max-w-[70%] rounded-full border border-border/60 bg-background/40 px-3 py-1 text-center text-[11px] text-muted-foreground">
        {message.content}
      </div>
    )
  }

  const isUser = message.role === "user"

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <article
        className={[
          "min-w-0 max-w-full rounded-lg border px-4 py-3 shadow-[0_12px_36px_rgba(0,0,0,0.18)]",
          isUser
            ? "w-fit max-w-[68%] border-gold/45 bg-gold/15 text-foreground"
            : "w-[min(900px,100%)] border-border/80 bg-card/95 text-card-foreground",
        ].join(" ")}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span
            className={[
              "label-track text-[10px]",
              isUser ? "text-gold" : "text-frost",
            ].join(" ")}
          >
            {isUser ? "Peter" : "ODIN"}
          </span>
          <time className="text-[10px] text-tertiary">
            {messageTime(message.created_at)}
          </time>
        </div>
        <div className="overflow-hidden text-sm leading-6">
          {isUser ? (
            <p className="break-words">{message.content}</p>
          ) : (
            <MessageContent content={message.content} />
          )}
        </div>
      </article>
    </div>
  )
}

export function ChatPanel({ initialDraft, autoSubmitKey = 0 }: ChatPanelProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [messages, setMessages] = useState<ChatRow[]>([])
  const [prompt, setPrompt] = useState(initialDraft ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [decisionCandidate, setDecisionCandidate] = useState<DecisionCandidate | null>(null)
  const [decisionSaving, setDecisionSaving] = useState(false)
  const [digestPhase, setDigestPhase] = useState<DigestPhase>("idle")
  const [digestStartedAt, setDigestStartedAt] = useState<number | null>(null)
  const [digestElapsedMs, setDigestElapsedMs] = useState(0)
  const messagesViewportRef = useRef<HTMLDivElement | null>(null)
  const latestMessageRef = useRef<HTMLDivElement | null>(null)
  const lastAutoSubmitKeyRef = useRef(0)
  const decisionTimerRef = useRef<number | null>(null)

  const scrollToLatestMessage = useCallback(() => {
    window.requestAnimationFrame(() => {
      const viewport = messagesViewportRef.current
      if (viewport) {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: "smooth",
        })
        return
      }
      latestMessageRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      })
    })
  }, [])

  useEffect(() => {
    setPrompt(initialDraft ?? "")
  }, [initialDraft])

  useEffect(() => {
    if (!user) {
      setLoadingHistory(false)
      return
    }
    let mounted = true

    async function loadHistory() {
      const { data, error: loadError } = await supabase
        .from("chat_messages")
        .select("id, role, content, created_at")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT)

      if (!mounted) return
      if (loadError) {
        setError(loadError.message)
        setLoadingHistory(false)
        return
      }
      const rows = (data ?? [])
        .filter((row) => isVisibleRole(row.role))
        .reverse() as ChatRow[]
      setMessages(rows)
      setLoadingHistory(false)
    }

    loadHistory()
    return () => {
      mounted = false
    }
  }, [user])

  useEffect(() => {
    scrollToLatestMessage()
  }, [messages.length, scrollToLatestMessage])

  useEffect(() => {
    return () => {
      if (decisionTimerRef.current) window.clearTimeout(decisionTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!digestStartedAt || !["received", "routing", "digesting", "saving"].includes(digestPhase)) {
      return
    }
    setDigestElapsedMs(Date.now() - digestStartedAt)
    const timer = window.setInterval(() => {
      setDigestElapsedMs(Date.now() - digestStartedAt)
    }, 160)
    return () => window.clearInterval(timer)
  }, [digestPhase, digestStartedAt])

  const beginDigest = useCallback((phase: DigestPhase = "received") => {
    setDigestStartedAt(Date.now())
    setDigestElapsedMs(0)
    setDigestPhase(phase)
  }, [])

  const finishDigest = useCallback((phase: "ready" | "error") => {
    setDigestPhase(phase)
    if (digestStartedAt) setDigestElapsedMs(Date.now() - digestStartedAt)
  }, [digestStartedAt])

  const sendPrompt = useCallback(async (rawPrompt: string) => {
    const trimmed = rawPrompt.trim()
    if (!trimmed || !user) return

    setBusy(true)
    setError(null)
    setPrompt("")
    beginDigest("received")

    const optimisticUser: ChatRow = {
      id: `optimistic-user-${Date.now()}`,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    }
    const previousAssistant = [...messages].reverse().find((message) => message.role === "assistant")
    const possibleDecision = inferDecisionCandidate(trimmed, previousAssistant?.content)
    setMessages((prev) => [...prev, optimisticUser])
    if (decisionTimerRef.current) window.clearTimeout(decisionTimerRef.current)
    if (possibleDecision) {
      decisionTimerRef.current = window.setTimeout(() => {
        setDecisionCandidate(possibleDecision)
      }, 2000)
    } else {
      setDecisionCandidate(null)
    }

    const { data: userRow, error: userInsertError } = await supabase
      .from("chat_messages")
      .insert({ user_id: user.id, role: "user", content: trimmed })
      .select("id, role, content, created_at")
      .single()

    if (userInsertError) {
      setError(`Failed to save your message: ${userInsertError.message}`)
      finishDigest("error")
      setBusy(false)
      return
    }
    setDigestPhase("routing")

    setMessages((prev) =>
      prev.map((message) =>
        message.id === optimisticUser.id ? (userRow as ChatRow) : message
      )
    )

    const conversation = [
      ...messages.slice(-CONTEXT_LIMIT + 1),
      optimisticUser,
    ]
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n")

    let replyText = ""
    let assistantModel = "odin-orchestrator"
    let routeToOpen: string | null = null
    try {
      let response
      if (isLocalBrowserCommand(trimmed)) {
        setDigestPhase("digesting")
        const browserResult = await runLocalBrowserCommand(trimmed, { userId: user.id })
        routeToOpen = browserResult.route
        response = browserResult.response
        assistantModel = "odin-local-browser"
      } else {
        const mode = modeForPrompt(trimmed)
        setDigestPhase("routing")
        const weatherLocation = promptNeedsWeather(trimmed)
          ? await resolveWeatherLocationForOdin({ requestPermission: true })
          : null
        setDigestPhase("digesting")
        const scanSources = scanSourcesForPrompt(mode, trimmed)
        const shouldCarryConversation = promptIsContextualFollowUp(trimmed)
        response = await invokeOdinCommand({
          query: trimmed,
          source: "text",
          timezone: "Asia/Manila",
          mode,
          tone: toneForMode(mode),
          weatherLocation: weatherLocation?.location,
          recentContext: shouldCarryConversation ? conversation || undefined : undefined,
          conversationHistory: shouldCarryConversation ? conversation || undefined : undefined,
          useFreshScan: scanSources?.length ? true : undefined,
          scanSources,
        })
        if (weatherLocation?.warning) {
          response = {
            ...response,
            warnings: [weatherLocation.warning, ...response.warnings],
          }
        }
      }
      replyText = formatOdinResponse(response)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "ODIN could not complete the request."
      )
      finishDigest("error")
      setBusy(false)
      return
    }

    setDigestPhase("saving")
    const { data: assistantRow, error: assistantInsertError } = await supabase
      .from("chat_messages")
      .insert({
        user_id: user.id,
        role: "assistant",
        content: replyText,
        model: assistantModel,
      })
      .select("id, role, content, created_at")
      .single()

    if (assistantInsertError) {
      setError(`Reply received but not saved: ${assistantInsertError.message}`)
    }

    setMessages((prev) => [
      ...prev,
      (assistantRow as ChatRow) ?? {
        id: `local-assistant-${Date.now()}`,
        role: "assistant",
        content: replyText,
        created_at: new Date().toISOString(),
      },
    ])
    finishDigest("ready")
    setBusy(false)
    if (routeToOpen) navigate(routeToOpen)
  }, [beginDigest, finishDigest, messages, navigate, user])

  const saveDecision = async (
    scope: "Always do this" | "Case by case" | "Just this once"
  ) => {
    if (!user || !decisionCandidate) return
    setDecisionSaving(true)
    try {
      await createOdinDecisionMemory({
        userId: user.id,
        title: decisionCandidate.title,
        content: memoryContentForDecision(decisionCandidate, scope),
      })
      setDecisionCandidate(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log this decision.")
    } finally {
      setDecisionSaving(false)
    }
  }

  useEffect(() => {
    if (
      !autoSubmitKey ||
      autoSubmitKey === lastAutoSubmitKeyRef.current ||
      loadingHistory ||
      busy ||
      !initialDraft?.trim()
    ) {
      return
    }
    lastAutoSubmitKeyRef.current = autoSubmitKey
    void sendPrompt(initialDraft)
  }, [autoSubmitKey, busy, initialDraft, loadingHistory, sendPrompt])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    await sendPrompt(prompt)
  }

  const handleClear = async () => {
    if (!user) return
    if (!window.confirm("Delete all ODIN chat history? This cannot be undone.")) {
      return
    }
    const { error: deleteError } = await supabase
      .from("chat_messages")
      .delete()
      .eq("user_id", user.id)
    if (deleteError) {
      setError(deleteError.message)
      return
    }
    setMessages([])
  }

  return (
    <Card className="relative flex h-[min(82vh,780px)] max-h-[calc(100vh-7rem)] w-full min-w-0 flex-col overflow-hidden border-border bg-surface/95 text-foreground shadow-[0_28px_90px_rgba(0,0,0,0.58)]">
      <CardHeader className="shrink-0 border-b border-border/70 px-5 py-4">
        <div className="flex items-start justify-between gap-4 pr-10">
          <div className="min-w-0">
            <CardTitle className="font-display tracking-[0.18em] text-gold">
              Ask ODIN
            </CardTitle>
            <CardDescription className="mt-1">
              Operations conversation. Recent context stays active; details scroll here.
            </CardDescription>
          </div>
          <div className="hidden rounded-full border border-gold/35 bg-gold/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-gold md:block">
            Read + drafts only
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
        <div
          ref={messagesViewportRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden overscroll-contain bg-background/35 px-5 py-4 scrollbar-thin"
        >
          {loadingHistory ? (
            <p className="text-sm text-muted-foreground">Loading history...</p>
          ) : messages.length === 0 ? (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
              <p className="font-display text-2xl text-foreground">ODIN is ready.</p>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Ask for a brief, a Slack/Gmail scan, calendar read, research pass,
                or a decision summary. Details stay readable here.
              </p>
            </div>
          ) : (
            messages.map((message, index) => (
              <div
                key={message.id}
                ref={index === messages.length - 1 ? latestMessageRef : undefined}
                className="scroll-mt-4"
              >
                <ChatMessage message={message} />
              </div>
            ))
          )}
          {busy && (
            <div className="flex justify-start">
              <div className="w-[min(520px,100%)] rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 label-track text-[10px] text-gold">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-gold shadow-[0_0_12px_rgba(227,176,79,0.7)]" />
                    ODIN digest
                  </span>
                  <span className="font-mono-data text-[10px] uppercase tracking-[0.14em] text-gold/80">
                    {digestLabel(digestPhase)} · {formatDigestElapsed(digestElapsedMs)}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed">
                  {digestDetail(digestPhase)}
                </p>
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="mx-5 mt-3 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="shrink-0 border-t border-border/70 bg-surface/98 px-5 py-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {QUICK_PROMPTS.map((quickPrompt) => (
              <button
                key={quickPrompt}
                type="button"
                onClick={() => setPrompt(quickPrompt)}
                disabled={busy || loadingHistory}
                className="rounded-full border border-border/80 bg-background/45 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-gold/45 hover:text-gold disabled:opacity-50"
              >
                {quickPrompt}
              </button>
            ))}
          </div>
          <form onSubmit={handleSubmit} className="flex min-w-0 gap-2">
            <Input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask ODIN what matters now..."
              disabled={busy || loadingHistory}
              autoComplete="off"
              className="h-12 min-w-0 bg-background/60 text-base"
            />
            <Button type="submit" disabled={busy || !prompt.trim()} className="h-12 px-5">
              {busy ? "Thinking" : "Ask"}
            </Button>
          </form>
          {messages.length > 0 && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={handleClear}
                className="text-xs text-muted-foreground underline underline-offset-4 hover:text-destructive"
              >
                Clear history
              </button>
            </div>
          )}
        </div>
      </CardContent>
      {decisionCandidate && (
        <div className="fixed bottom-6 left-6 z-[90] w-[min(390px,calc(100vw-3rem))] rounded-lg border border-gold/35 bg-background/90 p-4 text-sm shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="label-track text-gold">Log this choice?</p>
              <p className="mt-2 leading-6 text-foreground">
                “{decisionCandidate.chosen}”
              </p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                ODIN will remember the reasoning and ask before applying it in high-stakes cases.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDecisionCandidate(null)}
              className="text-tertiary hover:text-foreground"
              aria-label="Skip logging this choice"
            >
              ×
            </button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {(["Always do this", "Case by case", "Just this once"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                disabled={decisionSaving}
                onClick={() => void saveDecision(scope)}
                className="rounded-md border border-border/80 bg-card/70 px-3 py-2 text-left text-xs font-semibold text-muted-foreground transition hover:border-gold/50 hover:text-gold disabled:opacity-50"
              >
                {scope}
              </button>
            ))}
            <button
              type="button"
              disabled={decisionSaving}
              onClick={() => setDecisionCandidate(null)}
              className="rounded-md border border-border/80 bg-card/40 px-3 py-2 text-left text-xs font-semibold text-tertiary transition hover:border-destructive/50 hover:text-destructive disabled:opacity-50"
            >
              Skip
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}

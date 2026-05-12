import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { supabase } from "@/lib/supabaseClient"
import { invokeClaude, extractText } from "@/lib/claudeClient"
import type { ClaudeMessage, ClaudeRole } from "@/lib/claudeClient"
import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const SYSTEM_PROMPT =
  "You are Jarvis, a concise personal assistant aggregating the user's email, calendar, Slack, and personal routines. Reply in 1-3 sentences unless the user asks for detail. If you don't have data for what's asked, say so plainly and suggest what to connect."

const HISTORY_LIMIT = 30
const CONTEXT_LIMIT = 12

interface ChatRow {
  id: string
  role: ClaudeRole | "system"
  content: string
  created_at: string
}

function isVisibleRole(role: string): role is ChatRow["role"] {
  return role === "user" || role === "assistant" || role === "system"
}

export function ChatPanel() {
  const { user } = useAuth()
  const [messages, setMessages] = useState<ChatRow[]>([])
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

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
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT)

      if (!mounted) return
      if (loadError) {
        setError(loadError.message)
        setLoadingHistory(false)
        return
      }
      const rows = (data ?? [])
        .filter((r) => isVisibleRole(r.role))
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
    scrollToBottom()
  }, [messages.length, scrollToBottom])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = prompt.trim()
    if (!trimmed || !user) return

    setBusy(true)
    setError(null)
    setPrompt("")

    const optimisticUser: ChatRow = {
      id: `optimistic-user-${Date.now()}`,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimisticUser])

    const { data: userRow, error: userInsertError } = await supabase
      .from("chat_messages")
      .insert({ user_id: user.id, role: "user", content: trimmed })
      .select("id, role, content, created_at")
      .single()

    if (userInsertError) {
      setError(`Failed to save your message: ${userInsertError.message}`)
      setBusy(false)
      return
    }

    setMessages((prev) =>
      prev.map((m) =>
        m.id === optimisticUser.id ? (userRow as ChatRow) : m
      )
    )

    const conversation: ClaudeMessage[] = [
      ...messages.slice(-CONTEXT_LIMIT + 1),
      optimisticUser,
    ]
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as ClaudeRole, content: m.content }))

    const result = await invokeClaude({
      messages: conversation,
      system: SYSTEM_PROMPT,
      maxTokens: 512,
    })

    if (result.error || !result.data) {
      setError(result.error?.message ?? "Empty response.")
      setBusy(false)
      return
    }

    const replyText = extractText(result.data)
    const usage = result.data.usage

    const { data: assistantRow, error: assistantInsertError } = await supabase
      .from("chat_messages")
      .insert({
        user_id: user.id,
        role: "assistant",
        content: replyText,
        model: result.data.model,
        tokens_input: usage?.input_tokens ?? null,
        tokens_output: usage?.output_tokens ?? null,
      })
      .select("id, role, content, created_at")
      .single()

    if (assistantInsertError) {
      setError(
        `Reply received but not saved: ${assistantInsertError.message}`
      )
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
    setBusy(false)
  }

  const handleClear = async () => {
    if (!user) return
    if (!window.confirm("Delete all Jarvis chat history? This cannot be undone.")) {
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
    <Card>
      <CardHeader>
        <CardTitle>Ask Jarvis</CardTitle>
        <CardDescription>
          Conversation history persists across sessions. Last {HISTORY_LIMIT} messages
          shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          ref={scrollRef}
          className="max-h-96 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 space-y-3"
        >
          {loadingHistory ? (
            <p className="text-sm text-muted-foreground">Loading history...</p>
          ) : messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No history yet. Say hi.
            </p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.role === "user"
                    ? "flex justify-end"
                    : "flex justify-start"
                }
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[80%] rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap"
                      : "max-w-[80%] rounded-lg bg-card border border-border px-3 py-2 text-sm whitespace-pre-wrap"
                  }
                >
                  {m.content}
                </div>
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What's on my plate today?"
            disabled={busy || loadingHistory}
            autoComplete="off"
          />
          <Button type="submit" disabled={busy || !prompt.trim()}>
            {busy ? "Thinking..." : "Ask"}
          </Button>
        </form>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {messages.length > 0 && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleClear}
              className="text-xs text-muted-foreground hover:text-destructive underline"
            >
              Clear history
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

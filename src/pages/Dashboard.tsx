import { useState } from "react"
import type { FormEvent } from "react"
import { useAuth } from "@/hooks/useAuth"
import { invokeClaude, extractText } from "@/lib/claudeClient"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

interface Section {
  title: string
  description: string
}

const sections: ReadonlyArray<Section> = [
  { title: "Email", description: "Gmail accounts, unified inbox." },
  { title: "Slack", description: "All workspaces in one place." },
  { title: "Calendar", description: "Google Calendar events." },
  { title: "Today", description: "Priorities, routines, focus." },
]

function AskClaudePanel() {
  const [prompt, setPrompt] = useState("")
  const [reply, setReply] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAsk = async (e: FormEvent) => {
    e.preventDefault()
    if (!prompt.trim()) return
    setBusy(true)
    setError(null)
    setReply(null)
    const result = await invokeClaude({
      messages: [{ role: "user", content: prompt }],
      system:
        "You are Jarvis, a concise personal assistant. Reply in 1-2 sentences.",
      maxTokens: 256,
    })
    setBusy(false)
    if (result.error) {
      setError(result.error.message)
      return
    }
    if (!result.data) {
      setError("No response received.")
      return
    }
    setReply(extractText(result.data))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask Jarvis</CardTitle>
        <CardDescription>
          Smoke test for the Claude edge function. Temporary surface.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleAsk} className="flex gap-2">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What's on my plate today?"
            disabled={busy}
            autoComplete="off"
          />
          <Button type="submit" disabled={busy || !prompt.trim()}>
            {busy ? "Thinking..." : "Ask"}
          </Button>
        </form>
        {error && (
          <p className="text-sm text-destructive mt-3" role="alert">
            {error}
          </p>
        )}
        {reply && (
          <p className="text-sm text-foreground mt-3 whitespace-pre-wrap">
            {reply}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export function Dashboard() {
  const { user, signOut } = useAuth()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Jarvis</h1>
            <p className="text-sm text-muted-foreground">
              {user?.email ?? "Signed in"}
            </p>
          </div>
          <Button variant="outline" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <AskClaudePanel />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {sections.map((s) => (
            <Card key={s.title}>
              <CardHeader>
                <CardTitle>{s.title}</CardTitle>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">Coming soon.</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    </div>
  )
}

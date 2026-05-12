import { useState } from "react"
import type { FormEvent } from "react"
import { useNavigate } from "react-router-dom"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Mode = "signin" | "signup"

export function Login() {
  const { signIn, signUp, signInWithMagicLink } = useAuth()
  const navigate = useNavigate()

  const [mode, setMode] = useState<Mode>("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [magicEmail, setMagicEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const handlePassword = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    const result =
      mode === "signin"
        ? await signIn(email, password)
        : await signUp(email, password)
    setBusy(false)
    if (result.error) {
      setError(result.error.message)
      return
    }
    if (mode === "signup") {
      setInfo("Check your email to confirm your account.")
      return
    }
    navigate("/dashboard", { replace: true })
  }

  const handleMagicLink = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    const result = await signInWithMagicLink(magicEmail)
    setBusy(false)
    if (result.error) {
      setError(result.error.message)
      return
    }
    setInfo("Magic link sent. Check your inbox.")
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Jarvis</CardTitle>
          <CardDescription>Your personal command center.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="password" className="w-full">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="password">Password</TabsTrigger>
              <TabsTrigger value="magic">Magic link</TabsTrigger>
            </TabsList>

            <TabsContent value="password">
              <form onSubmit={handlePassword} className="space-y-4 pt-4">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete={
                    mode === "signin" ? "current-password" : "new-password"
                  }
                />
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy
                    ? "Working..."
                    : mode === "signin"
                      ? "Sign in"
                      : "Create account"}
                </Button>
                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-foreground underline w-full text-center"
                  onClick={() =>
                    setMode(mode === "signin" ? "signup" : "signin")
                  }
                >
                  {mode === "signin"
                    ? "Need an account? Sign up"
                    : "Have an account? Sign in"}
                </button>
              </form>
            </TabsContent>

            <TabsContent value="magic">
              <form onSubmit={handleMagicLink} className="space-y-4 pt-4">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={magicEmail}
                  onChange={(e) => setMagicEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? "Sending..." : "Send magic link"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          {error && (
            <p className="text-sm text-destructive mt-4" role="alert">
              {error}
            </p>
          )}
          {info && !error && (
            <p className="text-sm text-muted-foreground mt-4">{info}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

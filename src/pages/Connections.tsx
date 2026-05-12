import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useAuth } from "@/hooks/useAuth"
import {
  useConnectedAccounts,
  type ConnectedAccount,
} from "@/hooks/useConnectedAccounts"
import { connectGoogle, disconnectGoogle, GOOGLE_PROVIDER } from "@/lib/connectors/google"
import { Button } from "@/components/ui/button"
import { ProviderCard } from "@/components/connectors/ProviderCard"

interface CallbackBanner {
  kind: "ok" | "error"
  text: string
}

function readBanner(provider: string | null, status: string | null, reason: string | null): CallbackBanner | null {
  if (!provider || !status) return null
  if (status === "ok") {
    return { kind: "ok", text: `${provider} connected successfully.` }
  }
  return {
    kind: "error",
    text: `${provider} connection failed${reason ? `: ${reason}` : ""}.`,
  }
}

function googleScopeSummary(account: ConnectedAccount): string[] {
  const scopes = account.scopes ?? []
  const labels: string[] = []
  if (scopes.some((s) => s.includes("gmail."))) labels.push("Gmail")
  if (scopes.some((s) => s.includes("calendar"))) labels.push("Calendar")
  if (scopes.some((s) => s.includes("drive"))) labels.push("Drive")
  return labels
}

export function Connections() {
  const { user, signOut } = useAuth()
  const { accounts, loading, isConnected, refresh } = useConnectedAccounts()
  const [searchParams, setSearchParams] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const banner = useMemo(
    () =>
      readBanner(
        searchParams.get("provider"),
        searchParams.get("status"),
        searchParams.get("reason")
      ),
    [searchParams]
  )

  useEffect(() => {
    if (banner?.kind === "ok") {
      refresh()
    }
  }, [banner, refresh])

  const googleAccount = accounts.find((a) => a.provider === GOOGLE_PROVIDER)
  const googleScopes = googleAccount ? googleScopeSummary(googleAccount) : []

  const handleConnectGoogle = async () => {
    setError(null)
    setBusy(true)
    try {
      await connectGoogle()
      // connectGoogle redirects away; no further state changes here.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start Google connect")
      setBusy(false)
    }
  }

  const handleDisconnectGoogle = async () => {
    if (!user) return
    if (!window.confirm("Disconnect Google? Cached tokens will be deleted.")) return
    setError(null)
    setBusy(true)
    try {
      await disconnectGoogle(user.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed")
    } finally {
      setBusy(false)
    }
  }

  const dismissBanner = () => {
    searchParams.delete("provider")
    searchParams.delete("status")
    searchParams.delete("reason")
    setSearchParams(searchParams, { replace: true })
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-semibold">Jarvis</h1>
            <nav className="flex items-center gap-4 text-sm">
              <Link to="/dashboard" className="text-muted-foreground hover:text-foreground">
                Dashboard
              </Link>
              <Link to="/connections" className="font-medium">
                Connections
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground hidden sm:inline">
              {user?.email}
            </span>
            <Button variant="outline" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {banner && (
          <div
            className={
              banner.kind === "ok"
                ? "rounded-md border border-primary/40 bg-primary/10 text-primary px-4 py-3 text-sm flex items-center justify-between"
                : "rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm flex items-center justify-between"
            }
            role="status"
          >
            <span>{banner.text}</span>
            <button
              type="button"
              onClick={dismissBanner}
              className="underline text-xs"
            >
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm"
            role="alert"
          >
            {error}
          </div>
        )}

        <div>
          <h2 className="text-lg font-semibold">Connect your services</h2>
          <p className="text-sm text-muted-foreground">
            Jarvis only reads what you connect. Tokens stay on the server and never
            reach the browser.
          </p>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading connected accounts...</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <ProviderCard
              name="Google"
              description="Gmail + Calendar + Drive under one consent."
              connected={isConnected(GOOGLE_PROVIDER)}
              busy={busy}
              onConnect={handleConnectGoogle}
              onDisconnect={handleDisconnectGoogle}
            >
              {googleAccount && (
                <div className="text-xs text-muted-foreground space-y-1">
                  {(googleAccount.metadata.email as string | undefined) && (
                    <div>Account: {googleAccount.metadata.email as string}</div>
                  )}
                  <div>
                    Active scopes:{" "}
                    {googleScopes.length === 0 ? "(none)" : googleScopes.join(", ")}
                  </div>
                  <div>
                    Drive scope not yet granted in Google consent screen. Add{" "}
                    <code>drive.readonly</code> in the OAuth consent screen and
                    reconnect to enable.
                  </div>
                </div>
              )}
              {!googleAccount && (
                <p className="text-xs text-muted-foreground">
                  Sign in with your Google account. Testing-mode app — Google may show
                  an unverified-app warning; click <em>Advanced</em> → <em>Continue</em>.
                </p>
              )}
            </ProviderCard>

            <ProviderCard
              name="Slack"
              description="Workspaces, channels, mentions."
              connected={false}
              onConnect={() => setError("Slack connector ships in Phase 7.")}
              onDisconnect={() => {}}
            >
              <p className="text-xs text-muted-foreground">Coming in Phase 7.</p>
            </ProviderCard>

            <ProviderCard
              name="Spotify"
              description="Now playing, controls, playlists."
              connected={false}
              onConnect={() => setError("Spotify connector ships in Phase 8.")}
              onDisconnect={() => {}}
            >
              <p className="text-xs text-muted-foreground">Coming in Phase 8.</p>
            </ProviderCard>
          </div>
        )}
      </main>
    </div>
  )
}

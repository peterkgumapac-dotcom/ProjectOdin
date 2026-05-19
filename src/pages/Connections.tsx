import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Plus, Settings as SettingsIcon, Star } from "lucide-react"
import { useAuth } from "@/hooks/useAuth"
import {
  useConnectedAccounts,
  type ConnectedAccount,
  type Provider,
} from "@/hooks/useConnectedAccounts"
import { connectGoogle, disconnectGoogle } from "@/lib/connectors/google"
import { connectSlack, disconnectSlack } from "@/lib/connectors/slack"
import {
  connectWithings,
  disconnectWithings,
} from "@/lib/connectors/withings"
import { connectSpotify, disconnectSpotify } from "@/lib/connectors/spotify"
import { odinRouteUrl } from "@/lib/desktopRoute"
import { Button } from "@/components/ui/button"
import {
  LightPageHeader,
  LightPageShell,
} from "@/components/dashboard/LightPageChrome"
import { AddAccountDialog } from "@/components/connectors/AddAccountDialog"
import { WorkflowEditor } from "@/components/connectors/WorkflowEditor"

interface CallbackBanner {
  kind: "ok" | "error"
  text: string
}

function friendlyConnectionReason(provider: string, reason: string | null): string {
  if (!reason) return ""
  if (
    provider === "spotify" &&
    (reason === "spotify_user_not_allowlisted_or_premium_required" ||
      reason === "profile_fetch_failed")
  ) {
    return "Spotify blocked the profile check. Add this Spotify account under the ODIN app's Users Management allowlist and make sure the app owner has Spotify Premium, then reconnect."
  }
  if (provider === "spotify" && reason === "spotify_profile_unauthorized") {
    return "Spotify rejected the profile token. Reconnect Spotify and approve ODIN's requested access."
  }
  if (provider === "spotify" && reason === "spotify_rate_limited") {
    return "Spotify rate-limited the profile check. Wait a minute, then reconnect."
  }
  return reason
}

function readBanner(
  provider: string | null,
  status: string | null,
  reason: string | null
): CallbackBanner | null {
  if (!provider || !status) return null
  const providerLabel =
    provider === "spotify" ? "Spotify" : provider.charAt(0).toUpperCase() + provider.slice(1)
  if (status === "ok") {
    return { kind: "ok", text: `${providerLabel} connected successfully.` }
  }
  const friendlyReason = friendlyConnectionReason(provider, reason)
  return {
    kind: "error",
    text: `${providerLabel} connection failed${friendlyReason ? `: ${friendlyReason}` : ""}`,
  }
}

function googleScopeChips(account: ConnectedAccount): string[] {
  const scopes = account.scopes ?? []
  const labels: string[] = []
  if (scopes.some((s) => s.includes("gmail."))) labels.push("Gmail")
  if (scopes.some((s) => s.includes("calendar"))) labels.push("Calendar")
  if (scopes.some((s) => s.includes("drive"))) labels.push("Drive")
  return labels
}

function activeRuleCount(account: ConnectedAccount): number {
  return account.workflowRules.filter((r) => r.enabled).length
}

export function Connections() {
  const { user } = useAuth()
  const { google, slack, spotify, withings, loading, refresh } =
    useConnectedAccounts()
  const [searchParams, setSearchParams] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [addDialog, setAddDialog] = useState<Provider | null>(null)
  const [workflowAccount, setWorkflowAccount] = useState<ConnectedAccount | null>(
    null
  )

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
    if (banner?.kind === "ok") refresh()
  }, [banner, refresh])

  const dismissBanner = () => {
    searchParams.delete("provider")
    searchParams.delete("status")
    searchParams.delete("reason")
    searchParams.delete("account")
    setSearchParams(searchParams, { replace: true })
  }

  const handleAddGoogle = async (label: string) => {
    await connectGoogle({ label, mode: "add" })
  }

  const handleAddSlack = async (label: string) => {
    await connectSlack({ label })
  }

  const handleAddSpotify = async (label: string) => {
    await connectSpotify({ label, redirectTo: odinRouteUrl("/connections") })
  }

  const handleDisconnect = async (account: ConnectedAccount) => {
    if (!user) return
    const name =
      account.accountEmail ?? account.workspaceName ?? account.accountLabel
    if (!window.confirm(`Disconnect ${name}? Cached tokens will be deleted.`)) {
      return
    }
    setError(null)
    try {
      if (account.provider === "google") {
        await disconnectGoogle(user.id, account.id)
      } else if (account.provider === "slack") {
        await disconnectSlack(user.id, account.id)
      } else if (account.provider === "withings") {
        await disconnectWithings(user.id, account.id)
      } else if (account.provider === "spotify") {
        await disconnectSpotify(user.id, account.id)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed.")
    }
  }

  return (
    <LightPageShell>
      <div className="mx-auto w-full max-w-[1800px] space-y-10">
        {banner && (
          <div
            className={
              banner.kind === "ok"
                ? "rounded-md border border-gold/40 bg-gold/10 text-gold px-4 py-3 text-sm flex items-center justify-between"
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

        <LightPageHeader title="Connect" subtitle="your services" />
        <p className="-mt-6 max-w-3xl text-2xl font-medium leading-tight text-muted-foreground">
            ODIN only reads what you connect. Tokens stay on the server and
            never reach the browser.
        </p>

        {/* GOOGLE */}
        <ProviderSection
          title="GOOGLE ACCOUNTS"
          addLabel="+ Add Google Account"
          onAdd={() => setAddDialog("google")}
        >
          {loading && google.length === 0 ? (
            <p className="text-xs text-tertiary py-3">Loading accounts...</p>
          ) : google.length === 0 ? (
            <EmptyState
              text="No Google accounts connected yet."
              cta="Connect first Google account"
              onClick={() => setAddDialog("google")}
            />
          ) : (
            <ul className="space-y-2">
              {google.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  primaryLabel={account.accountEmail ?? "Google Account"}
                  metaLine={googleScopeChips(account).join(" · ")}
                  rulesCount={activeRuleCount(account)}
                  onEditWorkflow={() => setWorkflowAccount(account)}
                  onDisconnect={() => handleDisconnect(account)}
                />
              ))}
            </ul>
          )}
        </ProviderSection>

        {/* SLACK */}
        <ProviderSection
          title="SLACK WORKSPACES"
          addLabel="+ Add Workspace"
          onAdd={() => setAddDialog("slack")}
        >
          {loading && slack.length === 0 ? (
            <p className="text-xs text-tertiary py-3">Loading workspaces...</p>
          ) : slack.length === 0 ? (
            <EmptyState
              text="No Slack workspaces connected yet."
              cta="Connect first workspace"
              onClick={() => setAddDialog("slack")}
            />
          ) : (
            <ul className="space-y-2">
              {slack.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  primaryLabel={account.workspaceName ?? "Slack Workspace"}
                  metaLine="Workspace"
                  rulesCount={activeRuleCount(account)}
                  onEditWorkflow={() => setWorkflowAccount(account)}
                  onDisconnect={() => handleDisconnect(account)}
                />
              ))}
            </ul>
          )}
        </ProviderSection>

        {/* WITHINGS */}
        <ProviderSection
          title="WITHINGS HEALTH"
          addLabel="+ Connect Withings"
          onAdd={() => {
            setError(null)
            void connectWithings({ redirectTo: odinRouteUrl("/connections") }).catch(
              (err) =>
                setError(
                  err instanceof Error
                    ? err.message
                    : "Failed to start Withings connect."
                )
            )
          }}
        >
          {loading && withings.length === 0 ? (
            <p className="text-xs text-tertiary py-3">Loading health sources...</p>
          ) : withings.length === 0 ? (
            <EmptyState
              text="No Withings account connected yet."
              cta="Connect Withings"
              onClick={() => {
                setError(null)
                void connectWithings({
                  redirectTo: odinRouteUrl("/connections"),
                }).catch((err) =>
                  setError(
                    err instanceof Error
                      ? err.message
                      : "Failed to start Withings connect."
                  )
                )
              }}
            />
          ) : (
            <ul className="space-y-2">
              {withings.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  primaryLabel={account.workspaceName ?? "Withings"}
                  metaLine={(account.scopes ?? []).join(" · ")}
                  rulesCount={activeRuleCount(account)}
                  onDisconnect={() => handleDisconnect(account)}
                />
              ))}
            </ul>
          )}
        </ProviderSection>

        {/* SPOTIFY */}
        <ProviderSection
          title="SPOTIFY"
          addLabel="+ Connect Spotify"
          onAdd={() => setAddDialog("spotify")}
          secondaryAction={
            <Link to="/music" className="text-xs font-bold uppercase tracking-[0.14em] text-[#9b815e] hover:text-[#b6531c]">
              Music UI
            </Link>
          }
        >
          {spotify.length === 0 ? (
            <EmptyState
              text="No Spotify account connected yet."
              cta="Connect Spotify"
              onClick={() => setAddDialog("spotify")}
            />
          ) : (
            <ul className="space-y-2">
              {spotify.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  primaryLabel={account.accountEmail ?? "Spotify"}
                  metaLine={(account.scopes ?? []).join(" · ")}
                  rulesCount={activeRuleCount(account)}
                  onDisconnect={() => handleDisconnect(account)}
                />
              ))}
            </ul>
          )}
        </ProviderSection>
      </div>

      <AddAccountDialog
        open={addDialog === "google"}
        onOpenChange={(o) => !o && setAddDialog(null)}
        provider="google"
        defaultLabel={google.length === 0 ? "Personal" : ""}
        onConfirm={handleAddGoogle}
      />
      <AddAccountDialog
        open={addDialog === "slack"}
        onOpenChange={(o) => !o && setAddDialog(null)}
        provider="slack"
        onConfirm={handleAddSlack}
      />
      <AddAccountDialog
        open={addDialog === "spotify"}
        onOpenChange={(o) => !o && setAddDialog(null)}
        provider="spotify"
        defaultLabel={spotify.length === 0 ? "Music" : ""}
        onConfirm={handleAddSpotify}
      />

      <WorkflowEditor
        open={!!workflowAccount}
        onOpenChange={(o) => !o && setWorkflowAccount(null)}
        account={workflowAccount}
        onSaved={() => {
          refresh()
        }}
      />
    </LightPageShell>
  )
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function ProviderSection({
  title,
  addLabel,
  onAdd,
  secondaryAction,
  children,
}: {
  title: string
  addLabel: string
  onAdd: () => void
  secondaryAction?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-end justify-between">
        <h3 className="text-4xl font-extrabold tracking-[-0.04em] text-foreground">
          {title
            .toLowerCase()
            .replace(/\b\w/g, (char) => char.toUpperCase())}
        </h3>
        <div className="flex items-center gap-3">
          {secondaryAction}
          <button
            type="button"
            onClick={onAdd}
            className="odin-light-action px-5 py-2 text-sm"
          >
            {addLabel}
          </button>
        </div>
      </div>
      <div>{children}</div>
    </section>
  )
}

function AccountRow({
  account,
  primaryLabel,
  metaLine,
  rulesCount,
  onEditWorkflow,
  onDisconnect,
}: {
  account: ConnectedAccount
  primaryLabel: string
  metaLine: string
  rulesCount: number
  onEditWorkflow?: () => void
  onDisconnect: () => void
}) {
  return (
    <li className="odin-light-card rounded-3xl p-7 transition-colors hover:border-border-accent">
      <div className="flex items-center justify-between gap-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="truncate text-2xl font-extrabold tracking-[-0.03em] text-foreground">
              {primaryLabel}
            </span>
            <span className="rounded-full border border-gold px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-gold">
              {account.accountLabel}
            </span>
            {account.isPrimary && (
              <span
                className="flex items-center gap-1 rounded-full border border-gold bg-gold px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-primary-foreground"
                title="Primary account"
              >
                <Star size={10} /> Primary
              </span>
            )}
            <span className="ml-auto text-[11px] font-bold uppercase tracking-[0.14em] text-success">
              ● Connected
            </span>
          </div>

          {metaLine && (
            <p className="mt-2 font-mono-data text-sm text-muted-foreground">
              {metaLine}
            </p>
          )}

          <p className="mt-1 font-mono-data text-sm text-tertiary">
            Workflow:{" "}
            {rulesCount > 0
              ? `${rulesCount} rule${rulesCount === 1 ? "" : "s"} active`
              : "No rules yet"}
          </p>

          <div className="mt-4 flex items-center gap-3">
            {onEditWorkflow && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onEditWorkflow}
                className="rounded-full border border-foreground/70 bg-transparent px-4 text-sm font-bold text-foreground hover:bg-secondary"
              >
                <SettingsIcon size={12} className="mr-1" />
                Edit Workflow
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDisconnect}
              className="text-sm font-semibold text-tertiary hover:text-destructive"
            >
              Disconnect
            </Button>
          </div>
        </div>
      </div>
    </li>
  )
}

function EmptyState({
  text,
  cta,
  onClick,
}: {
  text: string
  cta: string
  onClick: () => void
}) {
  return (
    <div className="rounded-md border border-dashed border-border bg-surface/30 p-6 text-center space-y-3">
      <p className="text-sm text-tertiary">{text}</p>
      <Button
        type="button"
        variant="ghost"
        onClick={onClick}
        className="text-gold hover:bg-gold/10 border border-gold/40"
      >
        <Plus size={14} className="mr-1" />
        {cta}
      </Button>
    </div>
  )
}

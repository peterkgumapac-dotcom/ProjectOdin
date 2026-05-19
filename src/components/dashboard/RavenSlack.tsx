import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { RavenIcon } from "./RavenIcon"
import { useSlackMessages } from "@/hooks/useSlackMessages"
import type { ConnectedAccount } from "@/hooks/useConnectedAccounts"

interface RavenSlackProps {
  slackAccounts: ConnectedAccount[]
}

export function RavenSlack({ slackAccounts }: RavenSlackProps) {
  const navigate = useNavigate()
  const { workspaces, totalUnread, loading } = useSlackMessages(60_000)
  const [activeId, setActiveId] = useState<string | null>(null)

  const connected = slackAccounts.length > 0
  const multi = slackAccounts.length > 1

  useEffect(() => {
    if (slackAccounts.length === 0) {
      setActiveId(null)
      return
    }
    if (!activeId || !slackAccounts.some((a) => a.id === activeId)) {
      const primary = slackAccounts.find((a) => a.isPrimary)
      setActiveId(primary?.id ?? slackAccounts[0].id)
    }
  }, [slackAccounts, activeId])

  const active = workspaces.find((w) => w.accountId === activeId) ?? null
  const signalMessages =
    active?.messages.filter((msg) =>
      /(approval|owner|deposit|signature|billable|work order|vendor|blocked|cannot|can't|maintenance|guest|last minute booking|last minute reservation|refund|claim|cancel|warning|urgent|escalat|payroll|safety|fire|flood|leak)/i.test(
        `${msg.channelName} ${msg.text}`
      )
    ) ?? []

  const badgeText = !connected
    ? "OFFLINE"
    : loading && totalUnread === 0
      ? "SYNCING"
      : signalMessages.length > 0
        ? `${signalMessages.length} SIGNAL${signalMessages.length === 1 ? "" : "S"}`
        : "QUIET"

  return (
    <section className="glass-card rounded-lg p-4 flex flex-col">
      <header className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-frost">
            <RavenIcon variant="muninn" size={20} />
          </span>
          <span className="label-track text-foreground">RAVEN: SLACK</span>
        </div>
        <span className="px-2 py-0.5 rounded-full bg-gold/10 border border-gold/40 text-gold font-mono-data text-[10px] tracking-wider">
          {badgeText}
        </span>
      </header>

      {!connected ? (
        <p className="text-xs text-tertiary">
          Connect a Slack workspace in Ravens to surface messages here.
        </p>
      ) : (
        <>
          {multi && (
            <div className="flex gap-1 mb-3 border-b border-border/60">
              {slackAccounts.map((a) => {
                const ws = workspaces.find((w) => w.accountId === a.id)
                const isActive = a.id === activeId
                const unread = ws?.totalUnread ?? 0
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setActiveId(a.id)}
                    className={[
                      "px-2 py-1.5 text-[11px] tracking-wider uppercase border-b-2 transition-colors flex items-center gap-1.5",
                      isActive
                        ? "border-gold text-gold"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    <span>{(a.workspaceName ?? a.accountLabel).toString()}</span>
                    {unread > 0 && (
                      <span className="px-1 rounded bg-frost/15 text-frost text-[9px] font-mono-data">
                        {unread}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          <div className="flex-1 rounded-md border border-border/60 bg-background/25 p-3">
            {!active || active.loading ? (
              <div className="space-y-2 animate-pulse">
                <div className="h-3 w-24 rounded bg-tertiary/20" />
                <div className="h-3 w-full rounded bg-tertiary/10" />
              </div>
            ) : active.error ? (
              <p className="text-xs text-destructive">
                Failed to load: {active.error}
              </p>
            ) : active.messages.length === 0 ? (
              <p className="text-xs text-tertiary">
                No recent activity in this workspace.
              </p>
            ) : signalMessages.length > 0 ? (
              <>
                <p className="font-mono-data text-2xl text-gold">
                  {signalMessages.length}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Slack signal{signalMessages.length === 1 ? "" : "s"} elevated.
                  Open Council for the raw feed.
                </p>
              </>
            ) : (
              <>
                <p className="font-mono-data text-2xl text-success">0</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Recent Slack exists, but no owner, vendor, guest, approval,
                  billable, or blocker signal is elevated.
                </p>
              </>
            )}
          </div>
        </>
      )}

      <footer className="mt-4 pt-3 border-t border-border/60">
        <button
          type="button"
          onClick={() => navigate("/council")}
          className="label-track text-tertiary hover:text-gold transition-colors"
        >
          OPEN COUNCIL →
        </button>
      </footer>
    </section>
  )
}

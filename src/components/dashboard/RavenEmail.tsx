import { useNavigate } from "react-router-dom"
import { RavenIcon } from "./RavenIcon"
import type { ConnectedAccount } from "@/hooks/useConnectedAccounts"

interface RavenEmailProps {
  googleAccounts: ConnectedAccount[]
}

function accountSummary(accounts: ConnectedAccount[]): string {
  if (accounts.length === 0) return "No Google accounts connected"
  if (accounts.length === 1) return "1 Google account connected"
  return `${accounts.length} Google accounts connected`
}

export function RavenEmail({ googleAccounts }: RavenEmailProps) {
  const navigate = useNavigate()
  const primary = googleAccounts.find((account) => account.isPrimary) ?? googleAccounts[0]

  return (
    <section className="glass-card rounded-lg p-4 flex flex-col">
      <header className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-gold">
            <RavenIcon variant="huginn" size={20} />
          </span>
          <span className="label-track text-foreground">RAVEN: EMAIL</span>
        </div>
        <span className="px-2 py-0.5 rounded-full bg-gold/10 border border-gold/40 text-gold font-mono-data text-[10px] tracking-wider">
          AGENT BRIEF
        </span>
      </header>

      <div className="flex-1 rounded-md border border-border/60 bg-background/25 p-3">
        <p className="font-mono-data text-xl text-gold">
          {accountSummary(googleAccounts)}
        </p>
        {primary ? (
          <p className="mt-1 text-[11px] text-tertiary">
            Primary: {primary.accountEmail ?? primary.accountLabel}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground leading-relaxed">
          Email priority no longer comes from Gmail unread counters. Claude and
          Codex must scan Peter&apos;s Gmail sources and post a
          structured source brief into ODIN before email can appear as current.
        </p>
      </div>

      <footer className="mt-4 pt-3 border-t border-border/60 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate("/council")}
          className="label-track text-tertiary hover:text-gold transition-colors"
        >
          OPEN QUEUE →
        </button>
        <button
          type="button"
          onClick={() => navigate("/connections")}
          className="label-track text-tertiary hover:text-frost transition-colors"
        >
          SOURCES →
        </button>
      </footer>
    </section>
  )
}

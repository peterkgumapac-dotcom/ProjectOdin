import { Link } from "react-router-dom"
import { useAuth } from "@/hooks/useAuth"
import { useConnectedAccounts } from "@/hooks/useConnectedAccounts"
import { useUnreadEmailCount } from "@/hooks/useUnreadEmailCount"
import { useTodayEvents } from "@/hooks/useTodayEvents"
import { ChatPanel } from "@/components/chat/ChatPanel"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { GOOGLE_PROVIDER } from "@/lib/connectors/google"
import type { CalendarEvent } from "@/lib/connectors/calendar"

function eventTimeLabel(event: CalendarEvent): string {
  const dt = event.start?.dateTime ?? event.start?.date
  if (!dt) return ""
  const d = new Date(dt)
  if (event.start?.date && !event.start?.dateTime) {
    return "All day"
  }
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

function EmailCard({ googleConnected }: { googleConnected: boolean }) {
  const { total, unread, loading, error } = useUnreadEmailCount(googleConnected)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>Gmail inbox snapshot.</CardDescription>
      </CardHeader>
      <CardContent>
        {!googleConnected && (
          <p className="text-sm text-muted-foreground">
            <Link to="/connections" className="underline">
              Connect Google
            </Link>{" "}
            to see your inbox.
          </p>
        )}
        {googleConnected && error && (
          <p className="text-sm text-destructive">{error.message}</p>
        )}
        {googleConnected && !error && (
          <div className="space-y-1">
            <p className="text-3xl font-semibold">
              {loading && unread === null ? "—" : (unread ?? 0)}
            </p>
            <p className="text-xs text-muted-foreground">
              Unread of {total ?? "—"} inbox messages.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CalendarCard({ googleConnected }: { googleConnected: boolean }) {
  const { events, loading, error } = useTodayEvents(googleConnected)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Calendar</CardTitle>
        <CardDescription>Today's events.</CardDescription>
      </CardHeader>
      <CardContent>
        {!googleConnected && (
          <p className="text-sm text-muted-foreground">
            <Link to="/connections" className="underline">
              Connect Google
            </Link>{" "}
            to see today.
          </p>
        )}
        {googleConnected && error && (
          <p className="text-sm text-destructive">{error.message}</p>
        )}
        {googleConnected && !error && events.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground">Nothing scheduled today.</p>
        )}
        {googleConnected && events.length > 0 && (
          <ul className="space-y-2">
            {events.slice(0, 6).map((e) => (
              <li key={e.id} className="flex justify-between gap-3 text-sm">
                <span className="truncate">{e.summary ?? "(no title)"}</span>
                <span className="text-muted-foreground shrink-0">
                  {eventTimeLabel(e)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function Dashboard() {
  const { user, signOut } = useAuth()
  const { isConnected, loading: accountsLoading } = useConnectedAccounts()
  const googleConnected = isConnected(GOOGLE_PROVIDER)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-semibold">Jarvis</h1>
            <nav className="flex items-center gap-4 text-sm">
              <Link to="/dashboard" className="font-medium">
                Dashboard
              </Link>
              <Link
                to="/connections"
                className="text-muted-foreground hover:text-foreground"
              >
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
        <ChatPanel />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <EmailCard googleConnected={!accountsLoading && googleConnected} />
          <Card>
            <CardHeader>
              <CardTitle>Slack</CardTitle>
              <CardDescription>All workspaces in one place.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Coming in Phase 7.</p>
            </CardContent>
          </Card>
          <CalendarCard googleConnected={!accountsLoading && googleConnected} />
          <Card>
            <CardHeader>
              <CardTitle>Today</CardTitle>
              <CardDescription>Priorities, routines, focus.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Aggregated view ships once Slack + rules are wired.
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}

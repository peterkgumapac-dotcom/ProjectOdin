import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

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

      <main className="max-w-6xl mx-auto px-6 py-8">
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

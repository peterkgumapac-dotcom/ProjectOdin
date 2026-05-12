import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export interface ProviderCardProps {
  name: string
  description: string
  connected: boolean
  busy?: boolean
  onConnect: () => void
  onDisconnect: () => void
  children?: ReactNode
}

export function ProviderCard({
  name,
  description,
  connected,
  busy = false,
  onConnect,
  onDisconnect,
  children,
}: ProviderCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{name}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {connected ? (
            <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium">
              Connected
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs font-medium">
              Not connected
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {children}
        <div className="flex gap-2">
          {connected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onDisconnect}
              disabled={busy}
            >
              {busy ? "Disconnecting..." : "Disconnect"}
            </Button>
          ) : (
            <Button size="sm" onClick={onConnect} disabled={busy}>
              {busy ? "Connecting..." : "Connect"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

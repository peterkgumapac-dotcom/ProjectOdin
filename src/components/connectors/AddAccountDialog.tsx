import { useEffect, useState, type FormEvent, type MouseEvent } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: "google" | "slack" | "spotify"
  defaultLabel?: string
  /** Async — usually starts the OAuth redirect. */
  onConfirm: (label: string) => Promise<void>
}

const TITLES: Record<AddAccountDialogProps["provider"], string> = {
  google: "Add Google Account",
  slack: "Add Slack Workspace",
  spotify: "Add Spotify Account",
}

const HELP: Record<AddAccountDialogProps["provider"], string> = {
  google:
    "Give this account a short label (e.g. Personal, Work, Client). Google will prompt you to pick which Gmail address to connect.",
  slack:
    "Give this workspace a short label. Slack will prompt you to pick which workspace to authorize.",
  spotify:
    "Give this Spotify account a short label. Spotify will ask which account ODIN can use for playback, playlists, and currently playing tracks.",
}

const FALLBACK_LABELS: Record<AddAccountDialogProps["provider"], string> = {
  google: "Personal",
  slack: "Workspace",
  spotify: "Music",
}

export function AddAccountDialog({
  open,
  onOpenChange,
  provider,
  defaultLabel,
  onConfirm,
}: AddAccountDialogProps) {
  const initialLabel = defaultLabel ?? FALLBACK_LABELS[provider]
  const [label, setLabel] = useState(initialLabel)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setLabel(defaultLabel ?? FALLBACK_LABELS[provider])
      setError(null)
      setBusy(false)
    }
  }, [open, defaultLabel, provider])

  const submit = async () => {
    if (busy) return
    const trimmed = label.trim()
    if (!trimmed) {
      setError("Label is required.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onConfirm(trimmed)
      // onConfirm typically navigates to the OAuth provider — no further work.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start connect.")
      setBusy(false)
    }
  }

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    void submit()
  }

  const handleButtonClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    void submit()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-[0.2em] text-gold">
            {TITLES[provider]}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">{HELP[provider]}</p>
        </DialogHeader>

        <form onSubmit={handleFormSubmit} noValidate className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <label className="label-track text-tertiary" htmlFor="account-label">
              Label
            </label>
            <Input
              id="account-label"
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={FALLBACK_LABELS[provider]}
              maxLength={60}
            />
          </div>

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleButtonClick}
              disabled={busy || !label.trim()}
            >
              {busy ? "Redirecting..." : "Connect"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

import { Component, type ErrorInfo, type ReactNode } from "react"
import { logFatalError } from "@/lib/diagnostics"

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logFatalError(error, { source: "react.errorBoundary", extra: { componentStack: info.componentStack ?? "" } })
  }

  handleReload = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload()
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return <RouteErrorFallback error={this.state.error} onReload={this.handleReload} />
    }
    return this.props.children
  }
}

interface FallbackProps {
  error: Error
  onReload?: () => void
}

export function RouteErrorFallback({ error, onReload }: FallbackProps) {
  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-background text-foreground p-8">
      <div className="max-w-md w-full rounded-2xl border border-white/10 bg-black/40 p-6 shadow-2xl space-y-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.18em] text-amber-200/80">Something broke</p>
          <h1 className="text-xl font-semibold">ODIN hit an unexpected error.</h1>
        </div>
        <pre className="text-xs whitespace-pre-wrap break-words text-white/70 bg-black/30 rounded-lg p-3 max-h-48 overflow-auto">
          {error.message}
        </pre>
        <p className="text-xs text-white/50">
          The error was logged locally. Reload to recover; if it repeats, check{" "}
          <code className="text-white/70">~/Library/Application Support/ODIN/odin-diag.log</code>.
        </p>
        <button
          type="button"
          onClick={onReload}
          className="w-full rounded-full bg-amber-500/90 text-black font-semibold text-sm py-2 hover:bg-amber-400 transition"
        >
          Reload ODIN
        </button>
      </div>
    </div>
  )
}

import { useEffect, useState, type ReactNode } from "react"
import { ArrowLeft } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Sidebar } from "./Sidebar"

function formatOpsMeta(date: Date): string {
  const time = date.toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  const day = date.toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    weekday: "short",
    day: "2-digit",
    month: "short",
  })
  return `${time} · Manila · ${day}`
}

export function ManilaMeta({ className = "" }: { className?: string }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <span
      className={[
        "font-mono-data text-sm font-semibold tracking-[0.08em] text-[#9b815e]",
        className,
      ].join(" ")}
    >
      {formatOpsMeta(now)}
    </span>
  )
}

export function LightPageShell({
  children,
  showSidebar = true,
  mainClassName,
}: {
  children: ReactNode
  showSidebar?: boolean
  mainClassName?: string
}) {
  return (
    <div
      className="odin-light-shell pointer-events-auto"
      style={{
        display: "grid",
        gridTemplateColumns: showSidebar ? "96px minmax(0, 1fr)" : "minmax(0, 1fr)",
        gridTemplateAreas: showSidebar ? `"sidebar main"` : `"main"`,
      }}
    >
      {showSidebar && <Sidebar />}
      <main
        className={["odin-light-main scrollbar-thin", mainClassName]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </main>
    </div>
  )
}

export function LightPageHeader({
  title,
  subtitle,
  action,
  meta,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  meta?: ReactNode
}) {
  const navigate = useNavigate()

  return (
    <header className="mb-10 flex flex-wrap items-start justify-between gap-5">
      <div>
        <button
          type="button"
          onClick={() => navigate("/dashboard?portal=open")}
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.14em] text-[#9b815e] transition hover:text-[#b6531c]"
        >
          <ArrowLeft size={13} />
          Hall
        </button>
        <div className="flex flex-wrap items-end gap-4">
          <h1 className="odin-light-page-title text-[#2b1d0f]">{title}</h1>
          {subtitle && (
            <p className="pb-2 text-2xl font-semibold text-[#9b815e]">
              — {subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-6">
        {meta ?? <ManilaMeta />}
        {action}
      </div>
    </header>
  )
}

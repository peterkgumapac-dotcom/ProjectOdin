import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Download,
  FileText,
  Folder,
  HeartPulse,
  ListChecks,
  Mic2,
  Music2,
  Play,
  SkipBack,
  SkipForward,
  Sparkles,
  X,
} from "lucide-react"
import {
  OdinIsland,
  OdinIslandScenarioPicker,
  type IslandScenario,
} from "@/components/desktop/OdinIsland"
import { ManilaMeta } from "@/components/dashboard/LightPageChrome"

const SCENARIOS: IslandScenario[] = [
  "live",
  "collapsed",
  "expanded",
  "voice",
  "blocked",
  "ops",
  "health",
  "music",
]

const COMPACT_SIZE = { mode: "idle" } as const
const TRAY_SIZE = { mode: "tray" } as const
const COLLAPSE_DELAY_MS = 560

interface NotchGeometry {
  notchX: number
  notchY: number
  notchWidth: number
  notchHeight: number
  leftSafeWidth: number
  rightSafeWidth: number
  menuBarHeight: number
  screenWidth: number
  screenHeight: number
  hasNotch: boolean
}

function scenarioFromSearch(value: string | null): IslandScenario {
  return SCENARIOS.includes(value as IslandScenario)
    ? (value as IslandScenario)
    : "live"
}

function resizeIsland(expanded: boolean) {
  const size = expanded ? TRAY_SIZE : COMPACT_SIZE
  void size
}

function openOdinRoute(route: string) {
  if (window.odinDesktop?.openRoute) {
    void window.odinDesktop.openRoute(route)
    return
  }
  window.location.assign(route)
}

function openPath(pathKey: "downloads" | "screenshots" | "documents" | "recent") {
  void window.odinDesktop?.openPath?.(pathKey)
}

function OdinSphere({ size = 32 }: { size?: number }) {
  return (
    <span
      className="odin-sphere relative grid shrink-0 place-items-center rounded-full"
      style={{ width: size, height: size }}
    >
      <span className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_30%_24%,rgba(255,255,255,0.9)_0_7%,transparent_8%),radial-gradient(circle_at_42%_50%,#f2a536_0_9%,#8f4b08_34%,#090807_72%)] shadow-[0_0_22px_rgba(239,144,24,0.8)]" />
      <span className="absolute left-[32%] top-1/2 h-px w-[50%] -translate-y-1/2 bg-white/45" />
      <span className="absolute left-1/2 top-[52%] h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/72" />
    </span>
  )
}

function TrayCard({
  children,
  className = "",
  icon,
  title,
  onClick,
}: {
  children: React.ReactNode
  className?: string
  icon: React.ReactNode
  title: string
  onClick?: () => void
}) {
  return (
    <section
      className={`odin-card min-h-0 rounded-[25px] border border-white/[0.075] bg-white/[0.055] p-4 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_16px_44px_rgba(0,0,0,0.32)] ${className}`}
      onClick={onClick}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.22em] text-white/58">
          <span className="text-[#efa12b]">{icon}</span>
          {title}
        </div>
        <ChevronRight size={18} className="text-white/28" />
      </div>
      {children}
    </section>
  )
}

export function OdinNotchOverlay() {
  const [expanded, setExpanded] = useState(false)
  const [notchGeometry, setNotchGeometry] = useState<NotchGeometry | null>(null)
  const collapseTimer = useRef<number | null>(null)

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimer.current === null) return
    window.clearTimeout(collapseTimer.current)
    collapseTimer.current = null
  }, [])

  const expand = useCallback(() => {
    clearCollapseTimer()
    setExpanded(true)
  }, [clearCollapseTimer])

  const collapse = useCallback(() => {
    clearCollapseTimer()
    setExpanded(false)
  }, [clearCollapseTimer])

  const scheduleCollapse = useCallback(() => {
    clearCollapseTimer()
    collapseTimer.current = window.setTimeout(() => {
      setExpanded(false)
      collapseTimer.current = null
    }, COLLAPSE_DELAY_MS)
  }, [clearCollapseTimer])

  useEffect(() => {
    resizeIsland(expanded)
  }, [expanded])

  useEffect(() => {
    const handleNativeExpand = () => expand()
    const handleNativeCollapse = () => collapse()
    const handleNotchGeometry = (event: Event) => {
      const detail = (event as CustomEvent<NotchGeometry>).detail
      if (detail && typeof detail.notchWidth === "number") {
        setNotchGeometry(detail)
      }
    }
    window.addEventListener("odin:island-expand", handleNativeExpand)
    window.addEventListener("odin:island-collapse", handleNativeCollapse)
    window.addEventListener("odin:notch-geometry", handleNotchGeometry)
    return () => {
      window.removeEventListener("odin:island-expand", handleNativeExpand)
      window.removeEventListener("odin:island-collapse", handleNativeCollapse)
      window.removeEventListener("odin:notch-geometry", handleNotchGeometry)
      clearCollapseTimer()
    }
  }, [clearCollapseTimer, collapse, expand])

  const notchBridgeStyle = notchGeometry?.hasNotch
    ? {
        width: `${notchGeometry.notchWidth}px`,
        height: `${notchGeometry.notchHeight}px`,
      }
    : undefined

  const notchSpacerStyle = notchGeometry?.hasNotch
    ? { width: `${notchGeometry.notchWidth}px` }
    : undefined

  if (!expanded) {
    return (
      <main className="grid h-screen w-screen place-items-center bg-transparent">
        <style>{notchOverlayCss}</style>
        <button
          type="button"
          aria-label="Open ODIN notch"
          className="group relative isolate grid h-11 w-11 place-items-center overflow-visible rounded-full border-0 bg-transparent p-0"
          onClick={expand}
          onMouseEnter={expand}
        >
          <OdinSphere size={31} />
        </button>
      </main>
    )
  }

  return (
    <main
      className="h-screen w-screen bg-transparent text-white"
      onMouseEnter={clearCollapseTimer}
      onMouseLeave={scheduleCollapse}
    >
      <style>{notchOverlayCss}</style>
      <section className="relative h-full w-full overflow-hidden rounded-b-[38px] border border-white/[0.075] bg-[rgba(12,12,13,0.88)] shadow-[0_30px_80px_rgba(0,0,0,0.52),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-[28px]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[54px] bg-[linear-gradient(180deg,rgba(92,92,96,0.42),rgba(18,18,20,0.78))]" />
        {notchGeometry?.hasNotch ? (
        <div className="pointer-events-none absolute left-1/2 top-0 z-20 -translate-x-1/2 rounded-b-[24px] border-x border-b border-white/[0.055] bg-[rgba(35,35,38,0.98)] shadow-[0_14px_36px_rgba(0,0,0,0.5),inset_0_-1px_0_rgba(255,255,255,0.05)]" style={notchBridgeStyle}>
          <span className="absolute left-1/2 top-[18px] h-[6px] w-[6px] -translate-x-1/2 rounded-full bg-white/18" />
        </div>
        ) : null}

        <header className="relative z-30 flex h-[58px] items-center justify-between px-7">
          <button
            type="button"
            className="flex h-11 items-center gap-3 rounded-full bg-black/34 px-3 pr-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
            onClick={() => openOdinRoute("/dashboard?portal=open")}
          >
            <OdinSphere size={31} />
            <span className="text-sm font-black tracking-[0.12em] text-[#efa12b]">ODIN</span>
            <ChevronDown size={15} className="text-white/42" />
          </button>

          <div className="pointer-events-none h-11" style={notchSpacerStyle} aria-hidden="true" />

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex h-10 items-center gap-2 rounded-full bg-white/10 px-4 text-[13px] font-bold text-white/82 hover:bg-white/15"
              onClick={() => openOdinRoute("/dashboard?portal=open&voice=start")}
            >
              <Mic2 size={15} />
              Talk
            </button>
            <button
              type="button"
              aria-label="Collapse ODIN notch"
              className="grid h-10 w-10 place-items-center rounded-full bg-white/8 text-white/70 hover:bg-white/14"
              onClick={collapse}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="relative z-10 grid h-[168px] grid-cols-[1.14fr_1fr_1fr_1fr_0.92fr] gap-3 px-5 pb-4">
          <TrayCard
            className="border-[#b16b18]/70 bg-[linear-gradient(145deg,rgba(255,168,42,0.10),rgba(255,255,255,0.045))]"
            icon={<Music2 size={17} />}
            title="Music"
            onClick={() => openOdinRoute("/dashboard/music")}
          >
            <div className="flex items-center gap-4">
              <div className="grid h-[74px] w-[74px] place-items-center rounded-2xl border border-white/10 bg-[#3a332a] text-[#efa12b] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                <Music2 size={32} />
              </div>
              <div className="min-w-0">
                <span className="mb-2 inline-flex rounded-full bg-[#1db954]/20 px-3 py-1 text-[12px] font-black text-[#69ef8c]">
                  Spotify
                </span>
                <p className="truncate text-[22px] font-black leading-tight">No track</p>
                <p className="truncate text-[15px] font-bold text-white/48">Connect Spotify</p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-center gap-6">
              <button type="button" className="text-white/72 hover:text-white" aria-label="Previous track">
                <SkipBack size={22} />
              </button>
              <button type="button" className="grid h-12 w-12 place-items-center rounded-full bg-white text-black shadow-[0_12px_30px_rgba(255,255,255,0.16)]" aria-label="Play music">
                <Play size={24} fill="currentColor" />
              </button>
              <button type="button" className="text-white/72 hover:text-white" aria-label="Next track">
                <SkipForward size={22} />
              </button>
            </div>
            <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/12">
              <div className="h-full w-[12%] rounded-full bg-[#efa12b]" />
            </div>
          </TrayCard>

          <TrayCard icon={<CalendarDays size={17} />} title="Today" onClick={() => openOdinRoute("/dashboard/calendar")}>
            <div className="flex items-center gap-4">
              <div className="grid h-[66px] w-[58px] place-items-center rounded-2xl bg-white/9 text-center">
                <span className="block text-[12px] font-black text-[#efa12b]">SUN</span>
                <span className="-mt-2 block text-[30px] font-black">17</span>
              </div>
              <div>
                <p className="text-[17px] font-black">Nothing for today</p>
                <p className="mt-1 text-sm font-semibold text-white/45">Calendar is quiet</p>
              </div>
            </div>
            <button type="button" className="mt-5 h-11 w-full rounded-2xl bg-white/10 text-sm font-black hover:bg-white/15" onClick={(event) => { event.stopPropagation(); openOdinRoute("/dashboard/calendar") }}>
              Open Calendar
            </button>
          </TrayCard>

          <TrayCard icon={<ListChecks size={17} />} title="Priorities" onClick={() => openOdinRoute("/dashboard?portal=open")}>
            <p className="mb-3 text-[16px] font-black text-white/80">Ops quiet</p>
            <div className="space-y-2">
              <div className="flex h-10 items-center justify-between rounded-2xl bg-white/8 px-3 text-[15px] font-black text-[#ff4f45]">
                0 overdue <ChevronRight size={16} className="text-white/28" />
              </div>
              <div className="flex h-10 items-center justify-between rounded-2xl bg-white/8 px-3 text-[15px] font-black text-[#ffb13d]">
                0 today <ChevronRight size={16} className="text-white/28" />
              </div>
              <div className="flex h-10 items-center justify-between rounded-2xl bg-white/8 px-3 text-[15px] font-black text-white/70">
                0 upcoming <ChevronRight size={16} className="text-white/28" />
              </div>
            </div>
          </TrayCard>

          <TrayCard icon={<HeartPulse size={17} />} title="Health" onClick={() => openOdinRoute("/dashboard/health")}>
            <div className="mb-3 flex items-center justify-between text-sm font-black">
              <span className="text-white/48">Readiness --</span>
              <span className="text-[#74ec86]">Connect</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {["Heart Rate", "Sleep", "Steps", "Weight"].map((label) => (
                <div key={label} className="rounded-2xl bg-white/8 p-3">
                  <p className="text-xs font-bold text-white/38">{label}</p>
                  <p className="mt-2 text-lg font-black">--</p>
                </div>
              ))}
            </div>
          </TrayCard>

          <TrayCard icon={<Download size={17} />} title="Files">
            <div className="space-y-2">
              <button type="button" className="flex h-10 w-full items-center gap-2 rounded-2xl bg-white/10 px-3 text-left text-sm font-black hover:bg-white/15" onClick={() => openPath("downloads")}>
                <Folder size={17} />
                Downloads
              </button>
              <button type="button" className="flex h-10 w-full items-center gap-2 rounded-2xl bg-white/10 px-3 text-left text-sm font-black hover:bg-white/15" onClick={() => openPath("screenshots")}>
                <Sparkles size={17} />
                Screenshots
              </button>
              <button type="button" className="flex h-10 w-full items-center gap-2 rounded-2xl bg-white/10 px-3 text-left text-sm font-black hover:bg-white/15" onClick={() => openPath("documents")}>
                <FileText size={17} />
                Documents
              </button>
              <button type="button" className="flex h-10 w-full items-center gap-2 rounded-2xl bg-white/10 px-3 text-left text-sm font-black hover:bg-white/15" onClick={() => openPath("recent")}>
                <CircleDot size={17} />
                Recent Files
              </button>
            </div>
          </TrayCard>
        </div>
      </section>
    </main>
  )
}

const notchOverlayCss = `
html, body, #root {
  background: transparent !important;
  margin: 0 !important;
  overflow: hidden !important;
}
button {
  -webkit-appearance: none;
}
@keyframes odinSpherePulse {
  0%, 100% { transform: scale(1); opacity: 0.82; }
  50% { transform: scale(1.14); opacity: 1; }
}
@keyframes odinCardIn {
  from { opacity: 0; transform: translateY(12px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.odin-sphere { animation: odinSpherePulse 2.15s ease-in-out infinite; }
.odin-card {
  animation: odinCardIn 420ms cubic-bezier(.18,.86,.18,1) both;
}
.odin-card:nth-child(2) { animation-delay: 40ms; }
.odin-card:nth-child(3) { animation-delay: 80ms; }
.odin-card:nth-child(4) { animation-delay: 120ms; }
.odin-card:nth-child(5) { animation-delay: 160ms; }
`

export function IslandPage() {
  const [params] = useSearchParams()
  const overlay = params.get("overlay") === "1"
  const scenario = useMemo(
    () => scenarioFromSearch(params.get("state")),
    [params]
  )

  useEffect(() => {
    if (!overlay) return
    const previousBodyBackground = document.body.style.background
    const previousBodyImage = document.body.style.backgroundImage
    const previousHtmlBackground = document.documentElement.style.background
    const rootEl = document.getElementById("root")
    const previousRootBackground = rootEl?.style.background
    const previousRootOverflow = rootEl?.style.overflow
    document.body.style.background = "transparent"
    document.body.style.backgroundImage = "none"
    document.documentElement.style.background = "transparent"
    if (rootEl) {
      rootEl.style.background = "transparent"
      rootEl.style.overflow = "hidden"
    }
    return () => {
      document.body.style.background = previousBodyBackground
      document.body.style.backgroundImage = previousBodyImage
      document.documentElement.style.background = previousHtmlBackground
      if (rootEl) {
        rootEl.style.background = previousRootBackground ?? ""
        rootEl.style.overflow = previousRootOverflow ?? ""
      }
    }
  }, [overlay])

  if (overlay) {
    return <OdinIsland scenario={scenario} overlay />
  }

  return (
    <main className="min-h-screen bg-[#f4ecdd] px-8 py-10 text-[#2b1d0f]">
      <header className="mx-auto mb-10 flex max-w-[1120px] flex-wrap items-start justify-between gap-5">
        <div>
          <p className="mb-3 text-xs font-extrabold uppercase tracking-[0.14em] text-[#9b815e]">
            Desktop preview
          </p>
          <h1 className="text-6xl font-extrabold leading-none">ODIN Island</h1>
          <p className="mt-3 max-w-2xl text-lg font-semibold text-[#7d6547]">
            Warm Hall quick access for Ops, Health, Voice, and Music.
          </p>
        </div>
        <ManilaMeta className="mt-2" />
      </header>

      <OdinIslandScenarioPicker scenario={scenario} />
      <OdinIsland scenario={scenario} />
    </main>
  )
}

import { NavLink } from "react-router-dom"
import {
  Home,
  Cable,
  MessageSquare,
  Calendar,
  HeartPulse,
  Globe2,
  Music2,
  Settings,
} from "lucide-react"
import { motion } from "framer-motion"
import type { ComponentType, SVGProps } from "react"
import { OdinEyeMark } from "./OdinEyeMark"
import { useAuth } from "@/hooks/useAuth"

interface NavItem {
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  to?: string
}

const ITEMS: NavItem[] = [
  { label: "Hall", icon: Home, to: "/dashboard?portal=open" },
  { label: "Slack Scan", icon: MessageSquare, to: "/council" },
  { label: "Today", icon: Calendar, to: "/calendar" },
  { label: "Health", icon: HeartPulse, to: "/health" },
  { label: "Browser", icon: Globe2, to: "/browser" },
  { label: "Music", icon: Music2, to: "/music" },
  { label: "Accounts", icon: Cable, to: "/connections" },
  { label: "Rules", icon: Settings, to: "/settings" },
]

interface SidebarProps {
  onHallClick?: () => void
}

export function Sidebar({ onHallClick }: SidebarProps) {
  const { user } = useAuth()
  const initials =
    user?.email
      ?.split("@")[0]
      ?.split(/[._-]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "PE"

  return (
    <aside
      className="flex h-full min-h-screen w-24 flex-col items-center border-r border-[#dfcfb1] bg-[#efe3cf] py-6"
      style={{ gridArea: "sidebar" }}
    >
      <div className="mb-9 flex h-12 w-12 items-center justify-center rounded-full border border-[#2b1d0f]/35 bg-[#fffaf1] text-[#b6531c] shadow-[0_8px_20px_-16px_rgba(62,39,12,0.55)]">
        <OdinEyeMark className="h-8 w-8" />
      </div>

      <nav className="flex flex-1 flex-col items-center gap-4">
        {ITEMS.map((item) => {
          const Icon = item.icon
          const content = (active: boolean) => (
            <div
              className={[
                "relative flex h-14 w-14 items-center justify-center rounded-2xl transition-colors duration-200",
                active
                  ? "bg-[#f2d9c5] text-[#b6531c]"
                  : "text-[#6f5a3d] hover:bg-[#f7efe3] hover:text-[#2b1d0f]",
              ].join(" ")}
              title={item.label}
            >
              {active && (
                <span className="absolute left-[-21px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-[#b6531c]" />
              )}
              <Icon size={16} className="shrink-0" />
              <span className="sr-only">{item.label}</span>
            </div>
          )

          if (item.label === "Hall" && onHallClick) {
            return (
              <button
                key={item.label}
                type="button"
                onClick={onHallClick}
                aria-label={item.label}
              >
                {content(false)}
              </button>
            )
          }

          if (item.to) {
            return (
              <NavLink key={item.label} to={item.to} end aria-label={item.label}>
                {({ isActive }) => content(isActive)}
              </NavLink>
            )
          }
          return (
            <button
              key={item.label}
              type="button"
              className="cursor-not-allowed opacity-80"
              disabled
              title="Coming soon"
              aria-label={item.label}
            >
              {content(false)}
            </button>
          )
        })}
      </nav>

      <div
        className="relative flex h-11 w-11 items-center justify-center rounded-full bg-[#b6531c] text-xs font-bold text-[#fffaf1] shadow-[0_10px_22px_-16px_rgba(181,83,28,0.7)]"
        title={user?.email ?? "Peter"}
      >
        {initials.slice(0, 2)}
        <motion.span
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[#5b883f]"
          animate={{ scale: [1, 1.35, 1], opacity: [0.65, 1, 0.65] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    </aside>
  )
}

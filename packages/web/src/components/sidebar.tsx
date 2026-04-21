"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState, useEffect } from "react"
import {
  Sun,
  Moon,
  Palette,
  ArrowLeftRight,
} from "lucide-react"
import { useTheme } from "@/app/providers"
import { useSettings } from "@/app/settings-provider"
import { THEMES } from "@/lib/themes"
import { NAV_ITEMS } from "@/lib/nav"
import type { ThemeId } from "@/lib/themes"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Theme icon helper
// ---------------------------------------------------------------------------

function ThemeIcon({ theme }: { theme: ThemeId }) {
  switch (theme) {
    case "light":
      return <Sun size={18} />
    case "dark":
      return <Moon size={18} />
    default:
      return <Palette size={18} />
  }
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar() {
  const pathname = usePathname()
  const { theme, setTheme } = useTheme()
  const { settings } = useSettings()
  const [hovered, setHovered] = useState(false)
  const [instances, setInstances] = useState<Array<{ name: string; port: number; running: boolean; current: boolean }>>([])
  const [showSwitcher, setShowSwitcher] = useState(false)

  const emoji = settings.portalEmoji ?? "\u{1F9DE}"
  const portalName = settings.portalName ?? "Ryoko"

  // Fetch available instances
  useEffect(() => {
    fetch("/api/instances")
      .then(r => r.json())
      .then(setInstances)
      .catch(() => {})
  }, [])

  function cycleTheme() {
    const ids = THEMES.map((t) => t.id)
    const idx = ids.indexOf(theme)
    const next = ids[(idx + 1) % ids.length]
    setTheme(next)
  }

  return (
    <aside
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "fixed inset-y-0 left-0 hidden overflow-hidden border-r border-border bg-[var(--bg-secondary)] transition-[width,z-index] duration-200 ease-out lg:flex lg:flex-col",
        hovered ? "z-[110] w-[200px]" : "z-[60] w-14"
      )}
    >
      <div className="flex min-h-14 shrink-0 items-center gap-2.5 px-3.5 pb-3 pt-4">
        <span className="w-7 shrink-0 text-center text-2xl leading-none">{emoji}</span>
        <span className={cn("whitespace-nowrap text-[17px] font-semibold text-foreground transition-opacity duration-200", hovered ? "opacity-100" : "opacity-0")}>
          {portalName}
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
          const Icon = item.icon

          return (
            <a
              key={item.href}
              href={item.href}
              className={cn(
                "group flex h-10 items-center gap-2.5 rounded-md px-3 text-[13px] whitespace-nowrap transition-colors",
                isActive
                  ? "bg-[var(--accent-fill)] font-semibold text-[var(--accent)]"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon size={18} className="shrink-0" />
              <span className={cn("transition-opacity duration-200", hovered ? "opacity-100" : "opacity-0")}>
                {item.label}
              </span>
            </a>
          )
        })}
      </nav>

      {instances.length > 1 && (
        <div className="relative shrink-0 px-2 pt-1">
          <button
            onClick={() => setShowSwitcher(v => !v)}
            aria-label="Switch instance"
            className="flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftRight size={18} className="shrink-0" />
            <span className={cn("transition-opacity duration-200", hovered ? "opacity-100" : "opacity-0")}>
              Switch
            </span>
          </button>
          {showSwitcher && hovered && (
            <div className="absolute bottom-full left-2 z-100 mb-1 min-w-[180px] rounded-xl border border-border bg-[var(--material-thick)] p-1 shadow-[var(--shadow-overlay)] backdrop-blur-xl">
              {instances.map(inst => (
                <button
                  key={inst.port}
                  onClick={() => {
                    if (!inst.current && inst.running) {
                      window.location.href = `http://localhost:${inst.port}/chat`
                    }
                    setShowSwitcher(false)
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                    inst.current
                      ? "bg-[var(--accent-fill)] font-semibold text-[var(--accent)]"
                      : inst.running
                        ? "text-foreground hover:bg-accent"
                        : "cursor-default text-[var(--text-quaternary)]"
                  )}
                >
                  <span>{inst.name}</span>
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: inst.running ? "var(--system-green)" : "var(--text-quaternary)" }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="shrink-0 px-2 pb-3 pt-2">
        <button
          onClick={cycleTheme}
          aria-label={`Theme: ${theme}. Click to cycle.`}
          className="flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="shrink-0">
            <ThemeIcon theme={theme} />
          </span>
          <span className={cn("capitalize transition-opacity duration-200", hovered ? "opacity-100" : "opacity-0")}>
            {theme}
          </span>
        </button>
      </div>
    </aside>
  )
}

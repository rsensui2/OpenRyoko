"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useSettings } from "@/app/settings-provider"
import { Sidebar } from "./sidebar"
import { GlobalSearch } from "./global-search"
import { LiveStreamWidget } from "./live-stream-widget"
import { OnboardingWizard } from "./onboarding-wizard"
import {
  Home,
  MessageSquare,
  Layers,
  Users,
  Clock,
  LayoutGrid,
  DollarSign,
  Activity,
  Zap,
  Settings,
  Menu,
  X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/sessions", label: "Sessions", icon: Layers },
  { href: "/org", label: "Organization", icon: Users },
  { href: "/kanban", label: "Kanban", icon: LayoutGrid },
  { href: "/cron", label: "Cron", icon: Clock },
  { href: "/costs", label: "Costs", icon: DollarSign },
  { href: "/logs", label: "Activity", icon: Activity },
  { href: "/skills", label: "Skills", icon: Zap },
  { href: "/settings", label: "Settings", icon: Settings },
]

function MobileHeader() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const { settings } = useSettings()
  const emoji = settings.portalEmoji ?? "\u{1F916}"
  const portalName = settings.portalName ?? "Jinn"

  return (
    <>
      <div
        className="lg:hidden"
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          borderBottom: "1px solid var(--separator)",
          background: "var(--material-thick)",
          flexShrink: 0,
          position: "relative",
          zIndex: 60,
        }}
      >
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          style={{
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--text-primary)",
          }}
        >
          <Menu size={20} />
        </button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <span style={{ fontSize: 18, marginRight: 6 }}>{emoji}</span>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>{portalName}</span>
        </div>
        <div style={{ width: 36 }} />
      </div>

      {/* Drawer overlay */}
      {open && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
          }}
          className="lg:hidden"
        >
          {/* Backdrop */}
          <div
            style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)" }}
            onClick={() => setOpen(false)}
          />
          {/* Drawer */}
          <nav
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              bottom: 0,
              width: 260,
              background: "var(--bg-secondary)",
              borderRight: "1px solid var(--separator)",
              display: "flex",
              flexDirection: "column",
              animation: "slideInLeft 200ms ease",
            }}
          >
            {/* Drawer header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--separator)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 22 }}>{emoji}</span>
                <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>{portalName}</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                style={{
                  width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center",
                  background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)",
                }}
              >
                <X size={18} />
              </button>
            </div>
            {/* Nav items */}
            <div style={{ flex: 1, padding: "8px", display: "flex", flexDirection: "column", gap: 2 }}>
              {NAV_ITEMS.map((item) => {
                const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      height: 44,
                      padding: "0 14px",
                      borderRadius: 10,
                      textDecoration: "none",
                      color: isActive ? "var(--accent)" : "var(--text-secondary)",
                      background: isActive ? "var(--accent-fill)" : "transparent",
                      fontWeight: isActive ? 600 : 400,
                      fontSize: 15,
                    }}
                  >
                    <Icon size={18} style={{ flexShrink: 0 }} />
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </nav>
        </div>
      )}

      {/* CSS animation */}
      <style jsx global>{`
        @keyframes slideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </>
  )
}

export function PageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden" style={{ background: 'var(--bg)' }}>
      <Sidebar />
      <GlobalSearch />
      <main className="flex-1 overflow-hidden lg:ml-[56px]">
        <MobileHeader />
        {children}
      </main>
      <LiveStreamWidget />
      <OnboardingWizard />
    </div>
  )
}

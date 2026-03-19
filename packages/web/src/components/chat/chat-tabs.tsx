"use client"

import { useRef, type MouseEvent, type ReactNode } from 'react'
import { X, Plus } from 'lucide-react'
import { NotificationBell } from '@/components/notifications/notification-bell'
import type { ChatTab } from '@/hooks/use-chat-tabs'
import { cn } from '@/lib/utils'

interface ChatTabBarProps {
  tabs: ChatTab[]
  activeIndex: number
  onSwitch: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  toolbarActions?: ReactNode
}

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-zinc-500',
}

export function ChatTabBar({ tabs, activeIndex, onSwitch, onClose, onNew, toolbarActions }: ChatTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const handleMiddleClick = (e: MouseEvent, index: number) => {
    if (e.button === 1) { e.preventDefault(); onClose(index) }
  }

  return (
    <div className="relative z-[100] flex h-10 shrink-0 items-center border-b border-border bg-[var(--bg-secondary)]">
      {tabs.length > 0 && (
        <div
          ref={scrollRef}
          className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab, i) => (
            <button
              key={tab.sessionId}
              onClick={() => onSwitch(i)}
              onMouseDown={(e) => handleMiddleClick(e, i)}
              className={cn(
                "group flex h-10 max-w-[180px] shrink-0 items-center gap-1.5 border-r border-border px-3 text-xs font-medium whitespace-nowrap transition-colors",
                i === activeIndex
                  ? "border-b-2 border-b-[var(--accent)] bg-background text-foreground"
                  : "text-muted-foreground hover:bg-[var(--fill-quaternary)] hover:text-foreground",
                tab.unread && i !== activeIndex && "font-bold"
              )}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[tab.status] || STATUS_COLORS.idle}`} />
              {tab.emoji && <span className="text-sm">{tab.emoji}</span>}
              <span className="truncate">{tab.label}</span>
              <span
                onClick={(e) => { e.stopPropagation(); onClose(i) }}
                className="ml-auto rounded-sm p-0.5 opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100"
              >
                <X size={12} />
              </span>
            </button>
          ))}
        </div>
      )}
      {tabs.length === 0 && <div className="flex-1" />}
      <button
        onClick={onNew}
        className="flex size-10 shrink-0 items-center justify-center text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-quaternary)] hover:text-foreground"
        title="New Chat"
      >
        <Plus size={14} />
      </button>

      {toolbarActions && (
        <div className="hidden shrink-0 items-center gap-2 border-l border-border px-3 lg:flex">
          {toolbarActions}
          <NotificationBell />
        </div>
      )}
    </div>
  )
}

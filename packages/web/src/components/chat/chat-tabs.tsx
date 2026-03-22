"use client"

import { useRef, useState, type MouseEvent, type DragEvent, type ReactNode } from 'react'
import { X, Plus, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { NotificationBell } from '@/components/notifications/notification-bell'
import type { ChatTab } from '@/hooks/use-chat-tabs'
import { cn } from '@/lib/utils'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { cleanPreview } from '@/lib/clean-preview'

interface ChatTabBarProps {
  tabs: ChatTab[]
  activeIndex: number
  onSwitch: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  onPin?: (index: number) => void
  onMove?: (from: number, to: number) => void
  toolbarActions?: ReactNode
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-zinc-500',
}

export function ChatTabBar({ tabs, activeIndex, onSwitch, onClose, onNew, onPin, onMove, toolbarActions, sidebarCollapsed, onToggleSidebar }: ChatTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)

  const handleMiddleClick = (e: MouseEvent, index: number) => {
    if (e.button === 1) { e.preventDefault(); onClose(index) }
  }

  const handleDoubleClick = (index: number) => {
    onPin?.(index)
  }

  // --- Drag & drop ---
  const handleDragStart = (e: DragEvent, index: number) => {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    // Make the drag ghost semi-transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5'
    }
  }

  const handleDragEnd = (e: DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
    setDragIndex(null)
    setDropTarget(null)
  }

  const handleDragOver = (e: DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (index !== dragIndex) {
      setDropTarget(index)
    }
  }

  const handleDrop = (e: DragEvent, toIndex: number) => {
    e.preventDefault()
    const fromIndex = dragIndex
    setDragIndex(null)
    setDropTarget(null)
    if (fromIndex !== null && fromIndex !== toIndex) {
      onMove?.(fromIndex, toIndex)
    }
  }

  return (
    <div className="relative z-[100] flex h-10 shrink-0 items-center border-b border-border bg-[var(--bg-secondary)]">
      {onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          className="flex size-10 shrink-0 items-center justify-center border-r border-border text-muted-foreground transition-colors hover:bg-[var(--fill-quaternary)] hover:text-foreground"
        >
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      )}
      {tabs.length > 0 && (
        <div
          ref={scrollRef}
          className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab, i) => (
            <button
              key={tab.sessionId}
              onClick={() => onSwitch(i)}
              onDoubleClick={() => handleDoubleClick(i)}
              onMouseDown={(e) => handleMiddleClick(e, i)}
              draggable
              onDragStart={(e) => handleDragStart(e, i)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              className={cn(
                "group flex h-10 max-w-[180px] shrink-0 items-center gap-1.5 border-r border-border px-3 text-xs whitespace-nowrap transition-colors",
                i === activeIndex
                  ? "border-b-2 border-b-[var(--accent)] bg-background text-foreground"
                  : "text-muted-foreground hover:bg-[var(--fill-quaternary)] hover:text-foreground",
                tab.unread && i !== activeIndex && "font-bold",
                // Drop target indicator
                dropTarget === i && dragIndex !== null && dragIndex !== i && "border-l-2 border-l-[var(--accent)]",
              )}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[tab.status] || STATUS_COLORS.idle}`} />
              {tab.employeeName && <EmployeeAvatar name={tab.employeeName} size={16} />}
              <span className={cn(
                "truncate",
                tab.pinned ? "font-medium" : "font-normal italic",
              )}>
                {cleanPreview(tab.label)}
              </span>
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
        title="New Chat (N)"
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

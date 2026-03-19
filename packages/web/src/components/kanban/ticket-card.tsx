"use client"

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { KanbanTicket } from '@/lib/kanban/types'
import { PRIORITY_COLORS } from '@/lib/kanban/types'

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

interface TicketCardProps {
  ticket: KanbanTicket
  assigneeName: string | null
  onClick: () => void
  onDelete?: () => void
}

export function TicketCard({ ticket, assigneeName, onClick, onDelete }: TicketCardProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  function handleDragStart(e: React.DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData('text/plain', ticket.id)
    e.dataTransfer.effectAllowed = 'move'
    setIsDragging(true)
  }

  function handleDragEnd() {
    setIsDragging(false)
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="relative bg-[var(--material-regular)] rounded-[var(--radius-md)] p-[var(--space-3)] border border-[var(--separator)] flex flex-col gap-[var(--space-2)] select-none transition-opacity duration-150 ease-[var(--ease-smooth)]"
      style={{
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.6 : 1,
        borderLeft: `3px solid ${PRIORITY_COLORS[ticket.priority]}`,
      }}
    >
      {/* Delete button (visible on hover) */}
      {isHovered && onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          aria-label="Delete ticket"
          title="Delete ticket"
          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-[var(--radius-sm)] flex items-center justify-center text-[var(--system-red)] border-none cursor-pointer p-0 z-[1]"
          style={{
            background: 'color-mix(in srgb, var(--system-red) 12%, transparent)',
          }}
        >
          <Trash2 size={13} />
        </button>
      )}

      {/* Priority + Title */}
      <div className="flex items-start gap-[var(--space-2)]">
        <span
          className="inline-flex items-center gap-[3px] text-[length:var(--text-caption2)] font-semibold shrink-0 mt-0.5"
          style={{ color: PRIORITY_COLORS[ticket.priority] }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: PRIORITY_COLORS[ticket.priority] }}
          />
          {PRIORITY_LABELS[ticket.priority]}
        </span>
        <span className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)] leading-[1.3] line-clamp-2 overflow-hidden break-words">
          {ticket.title}
        </span>
      </div>

      {/* Description preview */}
      {ticket.description && (
        <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] leading-[1.4] line-clamp-2 overflow-hidden break-words">
          {ticket.description}
        </div>
      )}

      {/* Bottom row: assignee + timestamp */}
      <div className="flex items-center gap-[var(--space-2)] flex-wrap">
        {assigneeName && (
          <span className="text-[length:var(--text-caption2)] font-[var(--weight-medium)] text-[var(--text-secondary)] bg-[var(--fill-tertiary)] rounded-[var(--radius-sm)] py-px px-[var(--space-2)] leading-[1.5]">
            {assigneeName}
          </span>
        )}

        <span
          className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)] ml-auto"
          title={new Date(ticket.createdAt).toLocaleString()}
        >
          {relativeTime(ticket.createdAt)}
        </span>
      </div>
    </div>
  )
}

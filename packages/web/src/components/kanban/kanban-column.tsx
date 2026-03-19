"use client"

import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { KanbanColumn as KanbanColumnType, KanbanTicket, TicketStatus } from '@/lib/kanban/types'

interface KanbanColumnProps {
  column: KanbanColumnType
  tickets: KanbanTicket[]
  onDrop: (ticketId: string, status: TicketStatus) => void
  onCreateTicket?: () => void
  renderTicket: (ticket: KanbanTicket) => React.ReactNode
}

export function KanbanColumn({
  column,
  tickets,
  onDrop,
  onCreateTicket,
  renderTicket,
}: KanbanColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false)

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only set false when leaving the column itself, not a child
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const ticketId = e.dataTransfer.getData('text/plain')
    if (ticketId) {
      onDrop(ticketId, column.id)
    }
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="flex flex-col min-w-[280px] max-w-[320px] flex-[1_0_280px] h-full rounded-[var(--radius-lg)] transition-[background,border-color] duration-200 ease-[var(--ease-smooth)]"
      style={{
        background: isDragOver ? 'var(--fill-secondary)' : 'var(--fill-tertiary)',
        border: isDragOver
          ? '2px dashed var(--accent)'
          : '2px dashed transparent',
      }}
    >
      {/* Column header */}
      <div className="flex items-center justify-between p-[var(--space-3)_var(--space-4)] shrink-0">
        <div className="flex items-center gap-[var(--space-2)]">
          <span className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)] tracking-[-0.01em]">
            {column.title}
          </span>
          <span className="text-[length:var(--text-caption2)] font-[var(--weight-medium)] text-[var(--text-tertiary)] bg-[var(--fill-secondary)] rounded-[var(--radius-sm)] py-px px-1.5 min-w-[20px] text-center">
            {tickets.length}
          </span>
        </div>

        {column.id === 'backlog' && onCreateTicket && (
          <button
            onClick={onCreateTicket}
            aria-label="Create new ticket"
            className="flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-secondary)] cursor-pointer p-0 transition-colors duration-150 ease-[var(--ease-smooth)]"
          >
            <Plus size={16} />
          </button>
        )}
      </div>

      {/* Scrollable ticket area */}
      <div className="flex-1 overflow-y-auto px-[var(--space-2)] pb-[var(--space-2)] flex flex-col gap-[var(--space-2)]">
        {tickets.map((ticket) => (
          <div key={ticket.id}>
            {renderTicket(ticket)}
          </div>
        ))}

        {/* Empty state */}
        {tickets.length === 0 && (
          <div className="py-[var(--space-8)] px-[var(--space-4)] text-center text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            No tickets
          </div>
        )}
      </div>
    </div>
  )
}

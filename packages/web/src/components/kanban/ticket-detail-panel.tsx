"use client"

import { useEffect, useRef } from 'react'
import type { Employee } from '@/lib/api'
import type { KanbanTicket, TicketStatus, TicketPriority } from '@/lib/kanban/types'
import { PRIORITY_COLORS, COLUMNS } from '@/lib/kanban/types'
import { EmployeePicker } from './employee-picker'

/* Priority badge */
function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span
      className="inline-flex items-center gap-[var(--space-1)] text-[length:var(--text-caption2)] font-semibold uppercase tracking-[0.5px]"
      style={{ color: PRIORITY_COLORS[priority] }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: PRIORITY_COLORS[priority] }}
      />
      {priority}
    </span>
  )
}

/* Status badge */
function StatusBadge({ status }: { status: TicketStatus }) {
  const label = COLUMNS.find(c => c.id === status)?.title ?? status
  return (
    <span className="text-[length:var(--text-caption2)] font-semibold text-[var(--text-secondary)] bg-[var(--fill-tertiary)] px-[var(--space-2)] py-[2px] rounded-[var(--radius-sm)] uppercase tracking-[0.3px]">
      {label}
    </span>
  )
}

/* Main component */
interface TicketDetailPanelProps {
  ticket: KanbanTicket
  employees: Employee[]
  onClose: () => void
  onStatusChange: (status: TicketStatus) => void
  onAssigneeChange: (employeeName: string | null) => void
  onDelete: () => void
}

export function TicketDetailPanel({
  ticket,
  employees,
  onClose,
  onStatusChange,
  onAssigneeChange,
  onDelete,
}: TicketDetailPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // Escape key to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Focus close button on mount
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  function handleDelete() {
    onDelete()
  }

  const assignee = employees.find(e => e.name === ticket.assigneeId) ?? null
  const accentColor = 'var(--accent)'

  return (
    <div
      className="absolute top-0 right-0 bottom-0 z-30"
    >
      <div
        className="w-[420px] max-w-[100vw] h-full bg-[var(--material-regular)] shadow-[-4px_0_24px_rgba(0,0,0,0.25)] flex flex-col"
      >
        {/* Color strip */}
        <div className="h-[3px] bg-[var(--accent)] shrink-0" />

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Panel controls */}
          <div className="pt-[var(--space-4)] px-[var(--space-5)] pb-0 flex justify-end gap-[var(--space-2)]">
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close detail panel"
              className="w-7 h-7 rounded-full flex items-center justify-center bg-[var(--fill-secondary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-footnote)] transition-all duration-150 ease-[var(--ease-spring)]"
            >
              &#x2715;
            </button>
          </div>

          {/* Title + meta */}
          <div className="pt-[var(--space-2)] px-[var(--space-5)] pb-[var(--space-4)]">
            <h2 className="text-[length:var(--text-title3)] font-bold tracking-[-0.3px] text-[var(--text-primary)] m-0 leading-[1.25]">
              {ticket.title}
            </h2>

            <div className="flex items-center gap-[var(--space-3)] mt-[var(--space-2)]">
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
            </div>

            {/* Assignee */}
            {assignee ? (
              <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                <span>{assignee.displayName}</span>
                <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] bg-[var(--fill-secondary)] rounded-[var(--radius-sm)] px-1">
                  {assignee.rank}
                </span>
              </div>
            ) : (
              <div className="mt-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)] italic">
                Unassigned
              </div>
            )}
          </div>

          {/* Status controls */}
          <div className="px-[var(--space-5)] pb-[var(--space-4)]">
            <div className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)]">
              Move to
            </div>
            <div className="flex gap-[var(--space-1)] flex-wrap">
              {COLUMNS.map(col => {
                const isCurrent = col.id === ticket.status
                return (
                  <button
                    key={col.id}
                    onClick={() => { if (!isCurrent) onStatusChange(col.id) }}
                    disabled={isCurrent}
                    className="text-[length:var(--text-caption2)] font-semibold py-[3px] px-[var(--space-2)] rounded-[var(--radius-sm)] border-none transition-all duration-[120ms] ease-linear"
                    style={{
                      cursor: isCurrent ? 'default' : 'pointer',
                      background: isCurrent ? accentColor : 'var(--fill-tertiary)',
                      color: isCurrent ? '#fff' : 'var(--text-secondary)',
                      opacity: isCurrent ? 1 : 0.8,
                    }}
                  >
                    {col.title}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Assignee picker */}
          <div className="px-[var(--space-5)] pb-[var(--space-4)]">
            <div className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)]">
              Assignee
            </div>
            <EmployeePicker
              employees={employees}
              value={ticket.assigneeId ?? ''}
              onChange={(name) => onAssigneeChange(name || null)}
            />
          </div>

          {/* Description */}
          {ticket.description && (
            <div className="px-[var(--space-5)] pb-[var(--space-4)]">
              <div className="h-px bg-[var(--separator)] mb-[var(--space-3)]" />
              <div className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)]">
                Description
              </div>
              <div className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] leading-[1.5] whitespace-pre-wrap">
                {ticket.description}
              </div>
            </div>
          )}
        </div>

        {/* Delete button */}
        <div className="shrink-0 py-[var(--space-2)] px-[var(--space-5)] pb-[var(--space-4)] border-t border-[var(--separator)]">
          <button
            onClick={handleDelete}
            className="w-full py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--system-red)] bg-transparent text-[var(--system-red)] text-[length:var(--text-footnote)] font-semibold cursor-pointer transition-all duration-[120ms] ease-linear"
          >
            Delete Ticket
          </button>
        </div>
      </div>
    </div>
  )
}

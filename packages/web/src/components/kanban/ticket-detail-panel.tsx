"use client"

import { useEffect, useRef } from 'react'
import type { Employee } from '@/lib/api'
import type { KanbanTicket, TicketStatus, TicketPriority } from '@/lib/kanban/types'
import { PRIORITY_COLORS, COLUMNS } from '@/lib/kanban/types'
import { EmployeePicker } from './employee-picker'

/* Priority badge */
function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--space-1)',
      fontSize: 'var(--text-caption2)',
      fontWeight: 600,
      color: PRIORITY_COLORS[priority],
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: PRIORITY_COLORS[priority],
      }} />
      {priority}
    </span>
  )
}

/* Status badge */
function StatusBadge({ status }: { status: TicketStatus }) {
  const label = COLUMNS.find(c => c.id === status)?.title ?? status
  return (
    <span style={{
      fontSize: 'var(--text-caption2)',
      fontWeight: 600,
      color: 'var(--text-secondary)',
      background: 'var(--fill-tertiary)',
      padding: '2px var(--space-2)',
      borderRadius: 'var(--radius-sm)',
      textTransform: 'uppercase',
      letterSpacing: '0.3px',
    }}>
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
    if (window.confirm(`Delete ticket "${ticket.title}"? This cannot be undone.`)) {
      onDelete()
    }
  }

  const assignee = employees.find(e => e.name === ticket.assigneeId) ?? null
  const accentColor = 'var(--accent)'

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: 30,
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: '100vw',
          height: '100%',
          background: 'var(--material-regular)',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Color strip */}
        <div style={{ height: 3, background: accentColor, flexShrink: 0 }} />

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* Panel controls */}
          <div style={{
            padding: 'var(--space-4) var(--space-5) 0',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--space-2)',
          }}>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close detail panel"
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--fill-secondary)',
                color: 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
                fontSize: 'var(--text-footnote)',
                transition: 'all 150ms var(--ease-spring)',
              }}
            >
              &#x2715;
            </button>
          </div>

          {/* Title + meta */}
          <div style={{ padding: 'var(--space-2) var(--space-5) var(--space-4)' }}>
            <h2 style={{
              fontSize: 'var(--text-title3)',
              fontWeight: 700,
              letterSpacing: '-0.3px',
              color: 'var(--text-primary)',
              margin: 0,
              lineHeight: 1.25,
            }}>
              {ticket.title}
            </h2>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              marginTop: 'var(--space-2)',
            }}>
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
            </div>

            {/* Assignee */}
            {assignee ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                marginTop: 'var(--space-3)',
                fontSize: 'var(--text-footnote)',
                color: 'var(--text-secondary)',
              }}>
                <span>{assignee.displayName}</span>
                <span style={{
                  fontSize: 'var(--text-caption2)',
                  color: 'var(--text-tertiary)',
                  background: 'var(--fill-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0 4px',
                }}>
                  {assignee.rank}
                </span>
              </div>
            ) : (
              <div style={{
                marginTop: 'var(--space-3)',
                fontSize: 'var(--text-footnote)',
                color: 'var(--text-tertiary)',
                fontStyle: 'italic',
              }}>
                Unassigned
              </div>
            )}
          </div>

          {/* Status controls */}
          <div style={{
            padding: '0 var(--space-5) var(--space-4)',
          }}>
            <div style={{
              fontSize: 'var(--text-caption1)',
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: 'var(--space-2)',
            }}>
              Move to
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
              {COLUMNS.map(col => {
                const isCurrent = col.id === ticket.status
                return (
                  <button
                    key={col.id}
                    onClick={() => { if (!isCurrent) onStatusChange(col.id) }}
                    disabled={isCurrent}
                    style={{
                      fontSize: 'var(--text-caption2)',
                      fontWeight: 600,
                      padding: '3px var(--space-2)',
                      borderRadius: 'var(--radius-sm)',
                      border: 'none',
                      cursor: isCurrent ? 'default' : 'pointer',
                      background: isCurrent ? accentColor : 'var(--fill-tertiary)',
                      color: isCurrent ? '#fff' : 'var(--text-secondary)',
                      opacity: isCurrent ? 1 : 0.8,
                      transition: 'all 120ms ease',
                    }}
                  >
                    {col.title}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Assignee picker */}
          <div style={{ padding: '0 var(--space-5) var(--space-4)' }}>
            <div style={{
              fontSize: 'var(--text-caption1)',
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: 'var(--space-2)',
            }}>
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
            <div style={{ padding: '0 var(--space-5) var(--space-4)' }}>
              <div style={{
                height: 1,
                background: 'var(--separator)',
                marginBottom: 'var(--space-3)',
              }} />
              <div style={{
                fontSize: 'var(--text-caption1)',
                fontWeight: 600,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                marginBottom: 'var(--space-2)',
              }}>
                Description
              </div>
              <div style={{
                fontSize: 'var(--text-footnote)',
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
              }}>
                {ticket.description}
              </div>
            </div>
          )}
        </div>

        {/* Delete button */}
        <div style={{
          flexShrink: 0,
          padding: 'var(--space-2) var(--space-5) var(--space-4)',
          borderTop: '1px solid var(--separator)',
        }}>
          <button
            onClick={handleDelete}
            style={{
              width: '100%',
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--system-red)',
              background: 'transparent',
              color: 'var(--system-red)',
              fontSize: 'var(--text-footnote)',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 120ms ease',
            }}
          >
            Delete Ticket
          </button>
        </div>
      </div>
    </div>
  )
}

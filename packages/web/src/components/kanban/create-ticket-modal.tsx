"use client"

import { useState, useCallback } from 'react'
import { Plus } from 'lucide-react'
import type { Employee } from '@/lib/api'
import type { TicketPriority } from '@/lib/kanban/types'
import { PRIORITY_COLORS } from '@/lib/kanban/types'
import { EmployeePicker } from './employee-picker'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'

interface CreateTicketModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  employees: Employee[]
  onSubmit: (ticket: {
    title: string
    description: string
    priority: TicketPriority
    assigneeId: string | null
  }) => void
}

const PRIORITIES: TicketPriority[] = ['low', 'medium', 'high']
const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const initialState = {
  title: '',
  description: '',
  priority: 'medium' as TicketPriority,
  assigneeId: '' as string,
}

export function CreateTicketModal({
  open,
  onOpenChange,
  employees,
  onSubmit,
}: CreateTicketModalProps) {
  const [form, setForm] = useState(initialState)

  const resetForm = useCallback(() => {
    setForm(initialState)
  }, [])

  function handleOpenChange(next: boolean) {
    if (!next) resetForm()
    onOpenChange(next)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) return

    onSubmit({
      title: form.title.trim(),
      description: form.description.trim(),
      priority: form.priority,
      assigneeId: form.assigneeId || null,
    })

    resetForm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          maxWidth: 480,
        }}
      >
        <DialogHeader>
          <DialogTitle
            style={{
              fontSize: 'var(--text-title3)',
              fontWeight: 'var(--weight-bold)',
              color: 'var(--text-primary)',
            }}
          >
            Create Ticket
          </DialogTitle>
          <DialogDescription
            style={{
              fontSize: 'var(--text-caption1)',
              color: 'var(--text-tertiary)',
            }}
          >
            Add a new ticket to the backlog.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          {/* Title */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <label
              htmlFor="ticket-title"
              style={{
                fontSize: 'var(--text-caption1)',
                fontWeight: 'var(--weight-medium)',
                color: 'var(--text-secondary)',
              }}
            >
              Title
            </label>
            <input
              id="ticket-title"
              type="text"
              placeholder="What needs to be done?"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              required
              autoFocus
              style={{
                fontSize: 'var(--text-body)',
                color: 'var(--text-primary)',
                padding: '8px 12px',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--fill-tertiary)',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
          </div>

          {/* Description */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <label
              htmlFor="ticket-description"
              style={{
                fontSize: 'var(--text-caption1)',
                fontWeight: 'var(--weight-medium)',
                color: 'var(--text-secondary)',
              }}
            >
              Description
            </label>
            <textarea
              id="ticket-description"
              placeholder="Add details..."
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              style={{
                fontSize: 'var(--text-body)',
                color: 'var(--text-primary)',
                resize: 'vertical',
                minHeight: 72,
                padding: '8px 12px',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--fill-tertiary)',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
          </div>

          {/* Priority */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <span
              style={{
                fontSize: 'var(--text-caption1)',
                fontWeight: 'var(--weight-medium)',
                color: 'var(--text-secondary)',
              }}
            >
              Priority
            </span>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              {PRIORITIES.map((p) => {
                const isSelected = form.priority === p
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, priority: p }))}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 'var(--space-1)',
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 'var(--radius-md)',
                      border: isSelected
                        ? `2px solid ${PRIORITY_COLORS[p]}`
                        : '2px solid var(--separator)',
                      background: isSelected ? 'var(--fill-tertiary)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: 'var(--text-caption1)',
                      fontWeight: 'var(--weight-medium)',
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      transition: 'all 150ms var(--ease-smooth)',
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: PRIORITY_COLORS[p],
                        flexShrink: 0,
                      }}
                    />
                    {PRIORITY_LABELS[p]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Assignee */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <label
              style={{
                fontSize: 'var(--text-caption1)',
                fontWeight: 'var(--weight-medium)',
                color: 'var(--text-secondary)',
              }}
            >
              Assignee
            </label>
            <EmployeePicker
              employees={employees}
              value={form.assigneeId}
              onChange={(name) => setForm((f) => ({ ...f, assigneeId: name }))}
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={!form.title.trim()}
            style={{
              borderRadius: 'var(--radius-md)',
              padding: '12px 20px',
              width: '100%',
              fontSize: 'var(--text-body)',
              fontWeight: 'var(--weight-semibold)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-2)',
              background: 'var(--accent)',
              color: '#fff',
              cursor: form.title.trim() ? 'pointer' : 'default',
              opacity: form.title.trim() ? 1 : 0.5,
              transition: 'opacity 150ms ease',
            }}
          >
            <Plus size={16} />
            Create Ticket
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

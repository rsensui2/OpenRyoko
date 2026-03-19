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
        className="bg-[var(--bg)] border border-[var(--separator)] rounded-[var(--radius-lg)] shadow-[var(--shadow-card)] max-w-[480px]"
      >
        <DialogHeader>
          <DialogTitle
            className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)]"
          >
            Create Ticket
          </DialogTitle>
          <DialogDescription
            className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
          >
            Add a new ticket to the backlog.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-[var(--space-4)]"
        >
          {/* Title */}
          <div className="flex flex-col gap-[var(--space-1)]">
            <label
              htmlFor="ticket-title"
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
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
              className="text-[length:var(--text-body)] text-[var(--text-primary)] py-2 px-3 border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] outline-none font-[inherit]"
            />
          </div>

          {/* Description */}
          <div className="flex flex-col gap-[var(--space-1)]">
            <label
              htmlFor="ticket-description"
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
            >
              Description
            </label>
            <textarea
              id="ticket-description"
              placeholder="Add details..."
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="text-[length:var(--text-body)] text-[var(--text-primary)] resize-y min-h-[72px] py-2 px-3 border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] outline-none font-[inherit]"
            />
          </div>

          {/* Priority */}
          <div className="flex flex-col gap-[var(--space-2)]">
            <span
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
            >
              Priority
            </span>
            <div className="flex gap-[var(--space-2)]">
              {PRIORITIES.map((p) => {
                const isSelected = form.priority === p
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, priority: p }))}
                    className="flex-1 flex items-center justify-center gap-[var(--space-1)] py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-md)] cursor-pointer text-[length:var(--text-caption1)] font-[var(--weight-medium)] transition-all duration-150 ease-[var(--ease-smooth)]"
                    style={{
                      border: isSelected
                        ? `2px solid ${PRIORITY_COLORS[p]}`
                        : '2px solid var(--separator)',
                      background: isSelected ? 'var(--fill-tertiary)' : 'transparent',
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: PRIORITY_COLORS[p] }}
                    />
                    {PRIORITY_LABELS[p]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Assignee */}
          <div className="flex flex-col gap-[var(--space-1)]">
            <label
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
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
            className="rounded-[var(--radius-md)] py-3 px-5 w-full text-[length:var(--text-body)] font-[var(--weight-semibold)] border-none flex items-center justify-center gap-[var(--space-2)] mt-[var(--space-2)] bg-[var(--accent)] text-white transition-opacity duration-150 ease-linear"
            style={{
              cursor: form.title.trim() ? 'pointer' : 'default',
              opacity: form.title.trim() ? 1 : 0.5,
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

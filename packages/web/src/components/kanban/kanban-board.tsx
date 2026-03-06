"use client"

import { COLUMNS } from '@/lib/kanban/types'
import type { KanbanTicket, TicketStatus } from '@/lib/kanban/types'
import type { KanbanStore } from '@/lib/kanban/store'
import { getTicketsByStatus } from '@/lib/kanban/store'
import type { Employee } from '@/lib/api'
import { KanbanColumn } from './kanban-column'
import { TicketCard } from './ticket-card'

interface KanbanBoardProps {
  tickets: KanbanStore
  employees: Employee[]
  onTicketClick: (ticket: KanbanTicket) => void
  onMoveTicket: (ticketId: string, status: TicketStatus) => void
  onCreateTicket: () => void
  filterEmployeeId?: string | null
}

export function KanbanBoard({
  tickets,
  employees,
  onTicketClick,
  onMoveTicket,
  onCreateTicket,
  filterEmployeeId,
}: KanbanBoardProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        height: '100%',
        overflowX: 'auto',
        overflowY: 'hidden',
        padding: 'var(--space-2) 0',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {COLUMNS.map((column) => {
        const allColumnTickets = getTicketsByStatus(tickets, column.id)
        const columnTickets = filterEmployeeId
          ? allColumnTickets.filter((t) => t.assigneeId === filterEmployeeId)
          : allColumnTickets

        return (
          <KanbanColumn
            key={column.id}
            column={column}
            tickets={columnTickets}
            onDrop={onMoveTicket}
            onCreateTicket={column.id === 'backlog' ? onCreateTicket : undefined}
            renderTicket={(ticket) => {
              const emp = employees.find((e) => e.name === ticket.assigneeId)
              return (
                <TicketCard
                  ticket={ticket}
                  assigneeName={emp?.displayName ?? null}
                  onClick={() => onTicketClick(ticket)}
                />
              )
            }}
          />
        )
      })}
    </div>
  )
}

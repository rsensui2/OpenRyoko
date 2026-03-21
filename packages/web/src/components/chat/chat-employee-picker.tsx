"use client"

import { useState } from 'react'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { cn } from '@/lib/utils'
import type { Employee } from '@/lib/api'

type PickerEmployee = Pick<Employee, 'name' | 'displayName' | 'department' | 'rank'>

interface ChatEmployeePickerProps {
  employees: PickerEmployee[]
  selectedEmployee: string | null
  onSelect: (employeeName: string | null) => void
  portalName: string
}

const VISIBLE_COUNT = 7

export function ChatEmployeePicker({
  employees,
  selectedEmployee,
  onSelect,
  portalName,
}: ChatEmployeePickerProps) {
  const [expanded, setExpanded] = useState(false)
  const hasMore = employees.length > VISIBLE_COUNT
  const visibleEmployees = expanded ? employees : employees.slice(0, VISIBLE_COUNT)

  return (
    <div className="flex flex-col items-center gap-4 px-4">
      <p className="text-sm text-[var(--text-secondary)]">
        Who do you want to talk to?
      </p>

      <div className="flex flex-wrap justify-center gap-2">
        {/* COO chip */}
        <button
          type="button"
          aria-pressed={selectedEmployee === null}
          aria-label={portalName}
          onClick={() => onSelect(null)}
          className={cn(
            "flex items-center gap-2 rounded-full px-3 py-2 text-sm transition-all",
            "border cursor-pointer",
            selectedEmployee === null
              ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text-primary)]"
              : "border-[var(--separator)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
          )}
        >
          <span className="text-base">🧞</span>
          <span className="font-medium">{portalName}</span>
          <span className="text-xs text-[var(--text-tertiary)]">COO</span>
        </button>

        {/* Employee chips */}
        {visibleEmployees.map((emp) => {
          const isSelected = selectedEmployee === emp.name
          return (
            <button
              key={emp.name}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(emp.name)}
              className={cn(
                "flex items-center gap-2 rounded-full px-3 py-2 text-sm transition-all",
                "border cursor-pointer",
                isSelected
                  ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text-primary)]"
                  : "border-[var(--separator)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
              )}
            >
              <EmployeeAvatar name={emp.name} size={20} />
              <span className="font-medium">{emp.displayName}</span>
              <span className="text-xs text-[var(--text-tertiary)]">{emp.department}</span>
            </button>
          )
        })}
      </div>

      {/* More/Less toggle */}
      {hasMore && (
        <button
          type="button"
          aria-label={expanded ? 'Show less' : 'Show more'}
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-[var(--accent)] font-medium cursor-pointer bg-transparent border-none hover:underline"
        >
          {expanded ? 'Less' : `More (+${employees.length - VISIBLE_COUNT})`}
        </button>
      )}
    </div>
  )
}

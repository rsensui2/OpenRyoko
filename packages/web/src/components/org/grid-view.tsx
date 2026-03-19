"use client"

import type { Employee } from "@/lib/api"
import { Card, CardContent } from "@/components/ui/card"

interface GridViewProps {
  employees: Employee[]
  selectedName: string | null
  onSelect: (employee: Employee) => void
}

const RANK_EMOJI: Record<string, string> = {
  executive: "\uD83C\uDFAF",
  manager: "\uD83D\uDCCB",
  senior: "\u2B50",
  employee: "\uD83D\uDC64",
}

function EmployeeCard({
  employee,
  selected,
  onSelect,
}: {
  employee: Employee
  selected: boolean
  onSelect: () => void
}) {
  const emoji = RANK_EMOJI[employee.rank] || RANK_EMOJI.employee

  return (
    <button
      onClick={onSelect}
      className={`flex items-center gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md,12px)] bg-[var(--material-regular)] cursor-pointer w-full text-left transition-all duration-150 ease-in-out ${selected ? "border-[1.5px] border-[var(--accent)]" : "border border-[var(--separator)]"}`}
      style={{
        boxShadow: selected
          ? "0 0 0 1px var(--accent), var(--shadow-subtle)"
          : "var(--shadow-subtle)",
      }}
    >
      <span className="text-2xl leading-none shrink-0">
        {emoji}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis leading-[var(--leading-tight)]">
          {employee.displayName || employee.name}
        </div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] whitespace-nowrap overflow-hidden text-ellipsis mt-px">
          {employee.department}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)] bg-[var(--accent-fill)] px-[7px] py-px rounded-[10px]">
          {employee.engine}
        </span>
        <span className="text-[length:var(--text-caption2)] font-[var(--weight-medium)] text-[var(--text-quaternary)] bg-[var(--fill-quaternary)] px-[7px] py-px rounded-[10px]">
          {employee.model}
        </span>
      </div>
    </button>
  )
}

function DepartmentSection({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: React.ReactNode
}) {
  return (
    <Card className="p-0 shadow-none bg-[var(--bg-secondary)] rounded-[var(--radius-lg,16px)] border border-[var(--separator)]">
      <CardContent className="p-4 flex flex-col gap-[var(--space-2)]">
        {/* Header */}
        <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
          <span className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)]">
            {label}
          </span>
          <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)] ml-auto">
            {count} employee{count !== 1 ? "s" : ""}
          </span>
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

export function GridView({ employees, selectedName, onSelect }: GridViewProps) {
  // Group by department
  const deptMap = new Map<string, Employee[]>()
  const ungrouped: Employee[] = []

  for (const emp of employees) {
    if (emp.department) {
      const list = deptMap.get(emp.department) || []
      list.push(emp)
      deptMap.set(emp.department, list)
    } else {
      ungrouped.push(emp)
    }
  }

  // Find executive
  const executive = employees.find((e) => e.rank === "executive")

  return (
    <div className="overflow-y-auto p-[var(--space-6)] h-full">
      {/* Executive banner */}
      {executive && (
        <button
          onClick={() => onSelect(executive)}
          className={`flex items-center gap-[var(--space-5)] w-full px-[var(--space-6)] py-[var(--space-5)] rounded-[var(--radius-xl,20px)] bg-[var(--material-regular)] cursor-pointer text-left mb-[var(--space-6)] transition-all duration-150 ease-in-out ${selectedName === executive.name ? "border-[1.5px] border-[var(--accent)]" : "border border-[var(--separator)]"}`}
          style={{
            boxShadow:
              selectedName === executive.name
                ? "0 0 0 1px var(--accent), var(--shadow-card)"
                : "var(--shadow-card)",
          }}
        >
          <span className="text-[40px] leading-none">
            {RANK_EMOJI.executive}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] tracking-[var(--tracking-tight)] leading-[var(--leading-tight)]">
              {executive.displayName || executive.name}
            </div>
            <div className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] mt-0.5">
              {executive.department}
            </div>
          </div>
          <div className="flex gap-[var(--space-4)] shrink-0">
            <div className="text-center">
              <div className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)] leading-none">
                {employees.length}
              </div>
              <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mt-0.5">
                employees
              </div>
            </div>
            <div className="w-px self-stretch bg-[var(--separator)]" />
            <div className="text-center">
              <div className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)] leading-none">
                {deptMap.size}
              </div>
              <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mt-0.5">
                depts
              </div>
            </div>
          </div>
        </button>
      )}

      {/* Department columns */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-[var(--space-5)] items-start">
        {Array.from(deptMap.entries()).map(([dept, members]) => {
          const filtered = members.filter((m) => m.name !== executive?.name)
          if (filtered.length === 0) return null
          return (
            <DepartmentSection
              key={dept}
              label={dept}
              count={filtered.length}
            >
              {filtered.map((emp) => (
                <EmployeeCard
                  key={emp.name}
                  employee={emp}
                  selected={selectedName === emp.name}
                  onSelect={() => onSelect(emp)}
                />
              ))}
            </DepartmentSection>
          )
        })}

        {ungrouped.length > 0 && (
          <DepartmentSection
            label="Unassigned"
            count={ungrouped.filter((u) => u.name !== executive?.name).length}
          >
            {ungrouped
              .filter((u) => u.name !== executive?.name)
              .map((emp) => (
                <EmployeeCard
                  key={emp.name}
                  employee={emp}
                  selected={selectedName === emp.name}
                  onSelect={() => onSelect(emp)}
                />
              ))}
          </DepartmentSection>
        )}
      </div>
    </div>
  )
}

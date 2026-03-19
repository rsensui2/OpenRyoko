"use client"

import { useState, useRef, useEffect, useCallback } from 'react'
import type { Employee } from '@/lib/api'

interface EmployeePickerProps {
  employees: Employee[]
  value: string // employee name or ''
  onChange: (employeeName: string) => void
}

const RANK_LABELS: Record<string, string> = {
  executive: 'Exec',
  manager: 'Mgr',
  senior: 'Sr',
  employee: '',
}

export function EmployeePicker({ employees, value, onChange }: EmployeePickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = employees.find(e => e.name === value) ?? null

  // Filter employees by search
  const filtered = search.trim()
    ? employees.filter(e => {
        const q = search.toLowerCase()
        return (
          e.name.toLowerCase().includes(q) ||
          e.displayName.toLowerCase().includes(q) ||
          e.department.toLowerCase().includes(q)
        )
      })
    : employees

  // Include "Unassigned" option at the top
  const hasUnassigned = !search.trim() || 'unassigned'.includes(search.toLowerCase())

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIdx(0)
  }, [search])

  // Focus search when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 0)
    } else {
      setSearch('')
    }
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return
    const items = listRef.current.querySelectorAll('[data-employee-option]')
    const item = items[highlightIdx]
    if (item) item.scrollIntoView({ block: 'nearest' })
  }, [highlightIdx, open])

  const totalOptions = (hasUnassigned ? 1 : 0) + filtered.length

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx(i => Math.min(i + 1, totalOptions - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (hasUnassigned && highlightIdx === 0) {
        onChange('')
      } else {
        const empIdx = hasUnassigned ? highlightIdx - 1 : highlightIdx
        if (filtered[empIdx]) {
          onChange(filtered[empIdx].name)
        }
      }
      setOpen(false)
    }
  }, [open, highlightIdx, totalOptions, hasUnassigned, filtered, onChange])

  function selectEmployee(employeeName: string) {
    onChange(employeeName)
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`w-full flex items-center gap-[var(--space-2)] py-2 pl-3 pr-9 text-[length:var(--text-body)] cursor-pointer text-left border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] bg-[url("data:image/svg+xml,%3Csvg_xmlns='http://www.w3.org/2000/svg'_width='12'_height='12'_viewBox='0_0_24_24'_fill='none'_stroke='%23888'_stroke-width='2'_stroke-linecap='round'_stroke-linejoin='round'%3E%3Cpath_d='m6_9_6_6_6-6'/%3E%3C/svg%3E")] bg-no-repeat bg-[position:right_12px_center] min-h-[40px] font-[inherit] ${selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}
      >
        {selected ? (
          <>
            <span className="font-[var(--weight-medium)]">{selected.displayName}</span>
            {RANK_LABELS[selected.rank] && (
              <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] bg-[var(--fill-secondary)] rounded-[var(--radius-sm)] px-1.5 py-px">
                {RANK_LABELS[selected.rank]}
              </span>
            )}
          </>
        ) : (
          <span>Unassigned</span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute top-full left-0 right-0 mt-1 z-50 bg-[var(--material-regular)] border border-[var(--separator)] rounded-[var(--radius-md)] shadow-[0_8px_32px_rgba(0,0,0,0.3)] overflow-hidden"
        >
          {/* Search */}
          <div className="pt-2 px-2 pb-1">
            <input
              ref={searchRef}
              type="text"
              placeholder="Search employees..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full py-1.5 px-2.5 text-[length:var(--text-footnote)] border border-[var(--separator)] rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)] text-[var(--text-primary)] outline-none font-[inherit]"
            />
          </div>

          {/* Options list */}
          <div
            ref={listRef}
            role="listbox"
            className="max-h-[280px] overflow-y-auto p-1"
          >
            {/* Unassigned option */}
            {hasUnassigned && (
              <div
                data-employee-option
                role="option"
                aria-selected={value === ''}
                onClick={() => selectEmployee('')}
                className={`flex items-center gap-[var(--space-2)] py-2 px-2.5 rounded-[var(--radius-sm)] cursor-pointer transition-[background] duration-100 ${highlightIdx === 0 ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'}`}
                onMouseEnter={() => setHighlightIdx(0)}
              >
                <div className="w-8 h-8 rounded-lg bg-[var(--fill-tertiary)] flex items-center justify-center text-sm text-[var(--text-tertiary)] shrink-0">
                  &#x2014;
                </div>
                <div>
                  <div className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
                    Unassigned
                  </div>
                  <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                    No employee assigned
                  </div>
                </div>
                {value === '' && (
                  <span className="ml-auto text-[var(--accent)] text-[13px] shrink-0">&#10003;</span>
                )}
              </div>
            )}

            {/* Employee options */}
            {filtered.map((emp, i) => {
              const optionIdx = hasUnassigned ? i + 1 : i
              const isHighlighted = highlightIdx === optionIdx
              const isSelected = value === emp.name

              return (
                <div
                  key={emp.name}
                  data-employee-option
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectEmployee(emp.name)}
                  onMouseEnter={() => setHighlightIdx(optionIdx)}
                  className={`flex items-center gap-[var(--space-2)] py-2 px-2.5 rounded-[var(--radius-sm)] cursor-pointer transition-[background] duration-100 ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'}`}
                >
                  <div className="w-8 h-8 rounded-lg bg-[var(--accent)] flex items-center justify-center text-sm text-white font-semibold shrink-0">
                    {emp.displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-[var(--space-1)]">
                      <span className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">
                        {emp.displayName}
                      </span>
                      {RANK_LABELS[emp.rank] && (
                        <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] bg-[var(--fill-secondary)] rounded-[var(--radius-sm)] px-1 shrink-0">
                          {RANK_LABELS[emp.rank]}
                        </span>
                      )}
                    </div>
                    <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] overflow-hidden text-ellipsis whitespace-nowrap">
                      {emp.department || emp.name}
                    </div>
                  </div>
                  {isSelected && (
                    <span className="text-[var(--accent)] text-[13px] shrink-0">&#10003;</span>
                  )}
                </div>
              )
            })}

            {/* No results */}
            {filtered.length === 0 && !hasUnassigned && (
              <div className="p-[var(--space-4)] text-center text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                No employees match &ldquo;{search}&rdquo;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

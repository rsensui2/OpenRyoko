"use client"

import { useMemo, useState, useRef, useEffect, useCallback } from "react"
import { parseScheduleSlots, describeCron } from "@/lib/cron-utils"

interface CronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  employee?: string
  [key: string]: unknown
}

interface WeeklyScheduleProps {
  crons: CronJob[]
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const DAY_LABELS_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
// Map cron dow (0=Sun) to grid column (0=Mon)
const DOW_TO_COL: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 }

function formatHourShort(h: number): string {
  if (h === 0 || h === 24) return "12a"
  if (h === 12) return "12p"
  return h < 12 ? `${h}a` : `${h - 12}p`
}

function formatHour(h: number): string {
  if (h === 0 || h === 24) return "12 AM"
  if (h === 12) return "12 PM"
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

interface SlotInfo {
  cron: CronJob
  hour: number
  minute: number
  col: number
}

interface TooltipData {
  slot: SlotInfo
  rect: DOMRect
}

function PillTooltip({ slot, rect, containerRect }: { slot: SlotInfo; rect: DOMRect; containerRect: DOMRect }) {
  const color = slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)"
  const top = rect.top - containerRect.top - 8
  const left = rect.left - containerRect.left + rect.width / 2

  return (
    <div
      className="absolute pointer-events-none z-[100] min-w-[200px] max-w-[300px] bg-[var(--material-regular)] border border-[var(--separator)] rounded-[var(--radius-md)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-primary)]"
      style={{
        top,
        left,
        transform: "translate(-50%, -100%)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2)",
      }}
    >
      {/* Arrow */}
      <div
        className="absolute w-2.5 h-2.5 bg-[var(--material-regular)] border-r border-b border-[var(--separator)]"
        style={{
          bottom: -5,
          left: "50%",
          transform: "translateX(-50%) rotate(45deg)",
        }}
      />
      {/* Name */}
      <div
        className="font-bold text-[length:var(--text-footnote)] mb-[var(--space-1)] pl-[var(--space-2)]"
        style={{ borderLeft: `3px solid ${color}` }}
      >
        {slot.cron.name}
      </div>
      {/* Schedule */}
      <div className="text-[var(--text-secondary)] text-[length:var(--text-caption1)] mb-[var(--space-2)]">
        {describeCron(slot.cron.schedule)}
      </div>
      {/* Raw cron */}
      <div className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        {slot.cron.schedule}
      </div>
      {/* Status */}
      <div className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)]">
        <span
          className="w-[7px] h-[7px] rounded-full shrink-0"
          style={{
            background: slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)",
          }}
        />
        <span
          className="font-medium"
          style={{
            color: slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)",
          }}
        >
          {slot.cron.enabled ? "Enabled" : "Disabled"}
        </span>
        {slot.cron.employee && (
          <span className="text-[var(--text-tertiary)] ml-[var(--space-1)]">
            {slot.cron.employee}
          </span>
        )}
      </div>
    </div>
  )
}

export function WeeklySchedule({ crons }: WeeklyScheduleProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null)

  const updateContainerRect = useCallback(() => {
    if (containerRef.current) {
      setContainerRect(containerRef.current.getBoundingClientRect())
    }
  }, [])

  useEffect(() => {
    updateContainerRect()
    const el = containerRef.current
    if (!el) return

    window.addEventListener("resize", updateContainerRect, { passive: true })
    return () => {
      window.removeEventListener("resize", updateContainerRect)
    }
  }, [updateContainerRect])

  // Parse all crons into schedule slots, grouped by (col, hour)
  const { slotsByDayHour, activeHours } = useMemo(() => {
    const map = new Map<string, SlotInfo[]>()
    const hourSet = new Set<number>()

    for (const cron of crons) {
      if (!cron.enabled) continue
      const parsed = parseScheduleSlots(cron.schedule)
      if (!parsed) continue

      for (const dow of parsed.days) {
        const col = DOW_TO_COL[dow]
        if (col === undefined) continue
        const key = `${col}-${parsed.hour}`
        const existing = map.get(key) || []
        existing.push({ cron, hour: parsed.hour, minute: parsed.minute, col })
        map.set(key, existing)
        hourSet.add(parsed.hour)
      }
    }

    // Sort slots within each cell by minute, then name
    for (const [key, slots] of map) {
      map.set(key, slots.sort((a, b) => a.minute - b.minute || a.cron.name.localeCompare(b.cron.name)))
    }

    const activeHours = Array.from(hourSet).sort((a, b) => a - b)
    return { slotsByDayHour: map, activeHours }
  }, [crons])

  // Current day/time
  const now = new Date()
  const nowDow = now.getDay()
  const nowCol = DOW_TO_COL[nowDow]
  const nowHour = now.getHours()
  const nowMinuteFrac = now.getMinutes() / 60

  // Find max pills in any cell for a given hour
  const maxPillsPerHour = useMemo(() => {
    const result = new Map<number, number>()
    for (const hour of activeHours) {
      let max = 0
      for (let col = 0; col < 7; col++) {
        const key = `${col}-${hour}`
        const count = slotsByDayHour.get(key)?.length || 0
        if (count > max) max = count
      }
      result.set(hour, max)
    }
    return result
  }, [activeHours, slotsByDayHour])

  function handlePillEnter(slot: SlotInfo, e: React.MouseEvent<HTMLButtonElement>) {
    const pillRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    updateContainerRect()
    setTooltip({ slot, rect: pillRect })
  }

  // Close tooltip when clicking outside
  useEffect(() => {
    if (!tooltip) return
    const handler = () => setTooltip(null)
    document.addEventListener("click", handler)
    return () => document.removeEventListener("click", handler)
  }, [tooltip])

  if (activeHours.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[200px] text-[var(--text-secondary)] gap-[var(--space-2)]">
        <svg
          width="32" height="32" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"
          className="text-[var(--text-tertiary)] mb-[var(--space-2)]"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="text-[length:var(--text-subheadline)] font-medium">
          No scheduled jobs to display
        </span>
        <span className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
          Enable some cron jobs to see the weekly schedule
        </span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onClick={() => setTooltip(null)}
    >
      <div className="grid grid-cols-[56px_repeat(7,1fr)] bg-[var(--material-regular)] rounded-[var(--radius-md)] border border-[var(--separator)] overflow-hidden">
        {/* Header row */}
        <div className="p-[var(--space-3)_var(--space-2)] border-b border-[var(--separator)] bg-[var(--material-thick)]" />
        {DAY_LABELS.map((label, i) => {
          const isToday = i === nowCol
          return (
            <div
              key={label}
              className="relative p-[var(--space-3)_var(--space-2)] text-center border-b border-l border-[var(--separator)]"
              style={{
                background: isToday ? "var(--accent-fill)" : "var(--material-thick)",
              }}
            >
              <div
                title={DAY_LABELS_FULL[i]}
                className="text-[length:var(--text-footnote)] tracking-[0.02em]"
                style={{
                  fontWeight: isToday ? 700 : 600,
                  color: isToday ? "var(--accent)" : "var(--text-primary)",
                }}
              >
                {label}
              </div>
              {isToday && (
                <div
                  className="absolute -bottom-[3px] left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-[var(--accent)] z-[2]"
                />
              )}
            </div>
          )
        })}

        {/* Hour rows */}
        {activeHours.map((hour, hourIdx) => {
          const maxPills = maxPillsPerHour.get(hour) || 1
          const cellPadding = 8
          const pillHeight = 28
          const pillGap = 4
          const minCellHeight = cellPadding + maxPills * pillHeight + (maxPills - 1) * pillGap
          const isNowHour = hour === nowHour
          const isLastRow = hourIdx === activeHours.length - 1

          return (
            <div key={hour} className="contents">
              {/* Hour label cell */}
              <div
                className="p-[var(--space-2)] flex items-start justify-end relative"
                style={{
                  borderBottom: isLastRow ? "none" : "1px solid var(--separator)",
                  minHeight: minCellHeight,
                  background: isNowHour ? "var(--accent-fill)" : undefined,
                }}
              >
                <span
                  className="text-[length:var(--text-caption1)] font-[family-name:var(--font-mono)] leading-[1.2] whitespace-nowrap pt-0.5"
                  style={{
                    color: isNowHour ? "var(--accent)" : "var(--text-tertiary)",
                    fontWeight: isNowHour ? 600 : 400,
                  }}
                  title={formatHour(hour)}
                >
                  {formatHourShort(hour)}
                </span>
              </div>

              {/* Day cells for this hour */}
              {Array.from({ length: 7 }, (_, col) => {
                const key = `${col}-${hour}`
                const slots = slotsByDayHour.get(key) || []
                const isToday = col === nowCol
                const isNowCell = isToday && isNowHour

                return (
                  <div
                    key={key}
                    className="flex flex-col relative border-l border-[var(--separator)]"
                    style={{
                      padding: `${cellPadding / 2}px 4px`,
                      borderBottom: isLastRow ? "none" : "1px solid var(--separator)",
                      minHeight: minCellHeight,
                      gap: pillGap,
                      background: isNowCell
                        ? "color-mix(in srgb, var(--accent) 6%, transparent)"
                        : isToday
                          ? "color-mix(in srgb, var(--accent) 3%, transparent)"
                          : undefined,
                    }}
                  >
                    {/* Current time indicator (red line) */}
                    {isNowCell && (
                      <div
                        className="absolute left-0 right-0 h-0.5 bg-[var(--system-red)] opacity-80 z-[3] rounded-[1px]"
                        style={{ top: `${(nowMinuteFrac * 100).toFixed(1)}%` }}
                      />
                    )}

                    {/* Pills */}
                    {slots.map((slot, slotIdx) => {
                      const pillColor = slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)"
                      const isActive = tooltip?.slot.cron.id === slot.cron.id
                        && tooltip?.slot.col === slot.col
                        && tooltip?.slot.hour === slot.hour

                      return (
                        <button
                          key={`${key}-${slotIdx}`}
                          type="button"
                          title={`${slot.cron.name} - ${describeCron(slot.cron.schedule)}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            const pillRect = e.currentTarget.getBoundingClientRect()
                            updateContainerRect()
                            if (isActive) {
                              setTooltip(null)
                            } else {
                              setTooltip({ slot, rect: pillRect })
                            }
                          }}
                          onMouseEnter={(e) => handlePillEnter(slot, e)}
                          onMouseLeave={() => setTooltip(null)}
                          className="flex items-center gap-[5px] px-1.5 rounded-[var(--radius-sm)] border-none cursor-pointer w-full min-w-0 text-left relative overflow-hidden transition-[background,box-shadow] duration-150 ease-in-out"
                          style={{
                            height: pillHeight,
                            background: isActive
                              ? `color-mix(in srgb, ${pillColor} 25%, transparent)`
                              : `color-mix(in srgb, ${pillColor} 12%, transparent)`,
                            borderLeft: `3px solid ${pillColor}`,
                            boxShadow: isActive
                              ? `0 0 0 1px color-mix(in srgb, ${pillColor} 40%, transparent)`
                              : "none",
                          }}
                        >
                          {/* Status dot */}
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{
                              background: slot.cron.enabled ? "var(--system-green)" : "var(--text-tertiary)",
                            }}
                          />
                          {/* Time */}
                          <span className="text-[length:var(--text-caption2)] font-[family-name:var(--font-mono)] text-[var(--text-tertiary)] shrink-0 leading-none">
                            {`:${String(slot.minute).padStart(2, "0")}`}
                          </span>
                          {/* Name */}
                          <span
                            className="text-[length:var(--text-caption2)] font-semibold overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-1 leading-none"
                            style={{ color: pillColor }}
                          >
                            {slot.cron.name}
                          </span>
                        </button>
                      )
                    })}

                    {slots.length === 0 && <div className="flex-1" />}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Tooltip overlay */}
      {tooltip && containerRect && (
        <PillTooltip
          slot={tooltip.slot}
          rect={tooltip.rect}
          containerRect={containerRect}
        />
      )}
    </div>
  )
}

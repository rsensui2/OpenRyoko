"use client"

import { useState } from "react"

/* ── Types ───────────────────────────────────────────────────── */

export interface ParsedLogEntry {
  id: string
  timestamp: string
  level: string
  message: string
}

/* ── Helpers ──────────────────────────────────────────────────── */

const LEVEL_COLOR: Record<string, string> = {
  info: "var(--system-green)",
  warn: "var(--system-orange)",
  error: "var(--system-red)",
  debug: "var(--text-tertiary)",
}

const LEVEL_BG: Record<string, string> = {
  info: "rgba(48,209,88,0.12)",
  warn: "rgba(255,159,10,0.12)",
  error: "rgba(255,69,58,0.12)",
  debug: "var(--fill-secondary)",
}

type FilterKey = "all" | "info" | "warn" | "error"

const PILLS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "info", label: "Info" },
  { key: "warn", label: "Warn" },
  { key: "error", label: "Errors" },
]

export function parseLogLine(raw: string, index: number): ParsedLogEntry {
  // Expected format: "2026-03-07 12:00:00 [INFO] message here"
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s*(.*)$/)
  if (match) {
    return {
      id: `log-${index}`,
      timestamp: match[1],
      level: match[2].toLowerCase(),
      message: match[3],
    }
  }
  // Fallback: treat entire line as message
  return {
    id: `log-${index}`,
    timestamp: "",
    level: "info",
    message: raw,
  }
}

/* ── Component ────────────────────────────────────────────────── */

interface LogBrowserProps {
  lines: string[]
}

export function LogBrowser({ lines }: LogBrowserProps) {
  const [filter, setFilter] = useState<FilterKey>("all")
  const [search, setSearch] = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const entries = lines.map(parseLogLine)

  const filtered = entries.filter((e) => {
    if (filter !== "all" && e.level !== filter) return false
    if (search && !e.message.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const counts: Record<FilterKey, number> = {
    all: entries.length,
    info: entries.filter((e) => e.level === "info").length,
    warn: entries.filter((e) => e.level === "warn").length,
    error: entries.filter((e) => e.level === "error").length,
  }

  return (
    <div>
      {/* Filter pills + search */}
      <div className="flex items-center flex-wrap gap-[var(--space-2)] mb-[var(--space-3)]">
        {PILLS.map((pill) => {
          const isActive = filter === pill.key
          return (
            <button
              key={pill.key}
              onClick={() => setFilter(pill.key)}
              className="focus-ring flex items-center flex-shrink-0 rounded-[20px] py-[6px] px-[14px] text-[length:var(--text-footnote)] font-[var(--weight-medium)] border-none cursor-pointer gap-[var(--space-2)] transition-all duration-200 ease-[var(--ease-smooth)]"
              style={{
                ...(isActive
                  ? {
                      background: "var(--accent-fill)",
                      color: "var(--accent)",
                      boxShadow:
                        "0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)",
                    }
                  : {
                      background: "var(--fill-secondary)",
                      color: "var(--text-primary)",
                    }),
              }}
            >
              <span>{pill.label}</span>
              <span
                className="font-[var(--weight-semibold)]"
                style={{
                  color: isActive ? "var(--accent)" : "var(--text-secondary)",
                }}
              >
                {counts[pill.key]}
              </span>
            </button>
          )
        })}

        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="focus-ring ml-auto py-[6px] px-3 text-[length:var(--text-footnote)] rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--fill-secondary)] text-[var(--text-primary)] outline-none min-w-40 max-w-60"
        />
      </div>

      {/* Entry list */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[200px] text-[var(--text-secondary)] gap-[var(--space-2)]">
          <span className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)]">
            {entries.length === 0
              ? "No log entries found"
              : "No entries match this filter"}
          </span>
          <span className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
            {entries.length === 0
              ? "Log entries will appear here when available"
              : "Try adjusting your filter or search"}
          </span>
        </div>
      ) : (
        <div
          className="rounded-[var(--radius-md)] overflow-hidden bg-[var(--material-regular)]"
          style={{
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
          }}
        >
          {filtered.map((entry, idx) => {
            const isExpanded = expandedId === entry.id
            const levelColor = LEVEL_COLOR[entry.level] ?? "var(--text-tertiary)"
            const isLong = entry.message.length > 120

            return (
              <div key={entry.id}>
                {idx > 0 && (
                  <div className="h-px bg-[var(--separator)] mx-[var(--space-4)]" />
                )}

                {/* Row */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isLong ? isExpanded : undefined}
                  onClick={() => isLong && setExpandedId(isExpanded ? null : entry.id)}
                  onKeyDown={(e) => {
                    if (isLong && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault()
                      setExpandedId(isExpanded ? null : entry.id)
                    }
                  }}
                  className="flex items-center hover-bg focus-ring min-h-11 px-[var(--space-4)]"
                  style={{
                    cursor: isLong ? "pointer" : "default",
                    background:
                      entry.level === "error"
                        ? "rgba(255,69,58,0.06)"
                        : undefined,
                  }}
                >
                  {/* Status dot */}
                  <span
                    className="flex-shrink-0 rounded-full w-2 h-2"
                    style={{ background: levelColor }}
                  />

                  {/* Timestamp */}
                  {entry.timestamp && (
                    <span className="flex-shrink-0 font-mono text-[length:var(--text-caption1)] text-[var(--text-tertiary)] ml-[var(--space-3)] min-w-[130px]">
                      {entry.timestamp}
                    </span>
                  )}

                  {/* Level badge */}
                  <span
                    className="flex-shrink-0 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] py-px px-1.5 rounded ml-[var(--space-2)] tracking-[0.04em] uppercase"
                    style={{
                      background: LEVEL_BG[entry.level] ?? "var(--fill-secondary)",
                      color: levelColor,
                    }}
                  >
                    {entry.level}
                  </span>

                  {/* Message */}
                  <span className="truncate text-[length:var(--text-footnote)] text-[var(--text-primary)] ml-[var(--space-3)] flex-1 min-w-0">
                    {isLong && !isExpanded
                      ? entry.message.slice(0, 117) + "..."
                      : entry.message}
                  </span>

                  {/* Chevron for long messages */}
                  {isLong && (
                    <span
                      aria-hidden="true"
                      className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)] inline-block ml-[var(--space-2)] transition-transform duration-200 ease-[var(--ease-smooth)]"
                      style={{
                        transform: isExpanded
                          ? "rotate(90deg)"
                          : "rotate(0deg)",
                      }}
                    >
                      &#8250;
                    </span>
                  )}
                </div>

                {/* Expanded detail */}
                {isExpanded && isLong && (
                  <div className="animate-slide-down px-[var(--space-4)] pb-[var(--space-4)]">
                    <div className="rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] p-[var(--space-3)] mt-[var(--space-2)]">
                      <pre className="font-mono text-[length:var(--text-caption2)] text-[var(--text-secondary)] whitespace-pre-wrap break-words m-0 max-h-[300px] overflow-auto leading-[var(--leading-relaxed)]">
                        {entry.message}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

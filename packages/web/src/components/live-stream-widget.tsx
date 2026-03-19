"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Copy, Minimize2, X } from "lucide-react"
import { api } from "@/lib/api"
import { useGateway } from "@/hooks/use-gateway"
import { parseLogLine } from "@/components/activity/log-browser"
import type { ParsedLogEntry } from "@/components/activity/log-browser"

/* ── Constants ────────────────────────────────────────────────── */

const MAX_LINES = 500
const WIDGET_EVENT = "open-live-stream"

const LEVEL_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  info: { bg: "rgba(48,209,88,0.12)", color: "var(--system-green)", label: "INF" },
  warn: { bg: "rgba(255,159,10,0.12)", color: "var(--system-orange)", label: "WRN" },
  error: { bg: "rgba(255,69,58,0.12)", color: "var(--system-red)", label: "ERR" },
  debug: { bg: "var(--fill-secondary)", color: "var(--text-tertiary)", label: "DBG" },
}

function formatTime(ts: string): string {
  if (!ts) return ""
  // Already formatted as "2026-03-07 12:00:00", show just the time portion
  const parts = ts.split(" ")
  return parts.length > 1 ? parts[1] : ts
}

function formatCopyLine(entry: ParsedLogEntry): string {
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`
}

/* ── Visual states ────────────────────────────────────────────── */

type WidgetState = "hidden" | "collapsed" | "expanded"

/* ── LogRow ───────────────────────────────────────────────────── */

function LogRow({ entry }: { entry: ParsedLogEntry }) {
  const [open, setOpen] = useState(false)
  const lvl = LEVEL_STYLE[entry.level] ?? LEVEL_STYLE.debug
  const isLong = entry.message.length > 100

  return (
    <div
      className={`border-b border-[var(--separator)] ${entry.level === "error" ? "bg-[rgba(255,69,58,0.03)]" : ""}`}
    >
      <button
        onClick={() => isLong && setOpen((o) => !o)}
        className={`flex items-center w-full px-3 py-[5px] gap-2 border-none bg-transparent text-left ${isLong ? "cursor-pointer" : "cursor-default"}`}
      >
        {/* Expand chevron */}
        {isLong ? (
          <span
            className={`text-[10px] text-[var(--text-tertiary)] shrink-0 inline-block transition-transform duration-150 ${open ? "rotate-90" : "rotate-0"}`}
          >
            &#8250;
          </span>
        ) : (
          <span className="w-[10px] shrink-0" />
        )}

        {/* Time */}
        <span className="font-mono text-[var(--text-tertiary)] text-[10px] shrink-0 min-w-[58px]">
          {formatTime(entry.timestamp)}
        </span>

        {/* Level pill */}
        <span
          className="text-[9px] font-bold tracking-wide px-[5px] py-px rounded-[3px] shrink-0 leading-[14px]"
          style={{
            background: lvl.bg,
            color: lvl.color,
          }}
        >
          {lvl.label}
        </span>

        {/* Message (truncated) */}
        <span
          className={`font-mono text-[10px] leading-snug overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0 ${
            entry.level === "error" ? "text-[var(--system-red)]" : "text-[var(--text-secondary)]"
          }`}
        >
          {entry.message}
        </span>
      </button>

      {/* Expanded detail */}
      {open && isLong && (
        <div className="px-3 pt-1.5 pb-2 pl-[30px] border-t border-[var(--separator)] bg-[var(--fill-secondary)]">
          <pre className="font-mono text-[9px] leading-normal text-[var(--text-secondary)] whitespace-pre-wrap break-words m-0">
            {entry.message}
          </pre>
        </div>
      )}
    </div>
  )
}

/* ── Component ────────────────────────────────────────────────── */

export function LiveStreamWidget() {
  const [state, setState] = useState<WidgetState>("hidden")
  const [entries, setEntries] = useState<ParsedLogEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const logIndexRef = useRef(0)

  const { events } = useGateway()

  /* ── Auto-scroll ──────────────────────────────────────────── */

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries, autoScroll])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const atBottom = scrollHeight - scrollTop - clientHeight < 40
    if (!atBottom) setAutoScroll(false)
    else setAutoScroll(true)
  }, [])

  /* ── Fetch initial logs when expanded ─────────────────────── */

  useEffect(() => {
    if (state !== "expanded") return
    api
      .getLogs(50)
      .then((data) => {
        const parsed = (data.lines ?? []).map(parseLogLine)
        setEntries(parsed)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load logs")
      })
  }, [state])

  /* ── Listen for WebSocket events ──────────────────────────── */

  useEffect(() => {
    if (state === "hidden" || events.length === 0) return
    const latest = events[events.length - 1]
    if (latest.event === "log" && typeof latest.payload === "object" && latest.payload !== null) {
      const p = latest.payload as Record<string, unknown>
      const line = (p.line as string) || (p.message as string) || JSON.stringify(latest.payload)
      const newEntry = parseLogLine(line, logIndexRef.current++)
      setEntries((prev) => [...prev, newEntry].slice(-MAX_LINES))
    }
  }, [events, state])

  /* ── Actions ──────────────────────────────────────────────── */

  const handleClose = useCallback(() => {
    setState("hidden")
  }, [])

  const handleCopy = useCallback(async () => {
    const text = entries.map(formatCopyLine).join("\n")
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [entries])

  /* ── DOM event listener ───────────────────────────────────── */

  useEffect(() => {
    function onOpen() {
      setState("expanded")
    }
    window.addEventListener(WIDGET_EVENT, onOpen)
    return () => window.removeEventListener(WIDGET_EVENT, onOpen)
  }, [])

  /* ── Hidden ───────────────────────────────────────────────── */

  if (state === "hidden") return null

  /* ── Collapsed pill ───────────────────────────────────────── */

  if (state === "collapsed") {
    return (
      <button
        onClick={() => setState("expanded")}
        className="focus-ring flex items-center fixed bottom-5 right-5 z-50 px-3.5 py-2 rounded-[var(--radius-pill)] border border-[var(--separator)] bg-[var(--material-regular)] cursor-pointer gap-2 backdrop-blur-[40px] backdrop-saturate-[1.8] shadow-[0_4px_24px_rgba(0,0,0,0.25)]"
        style={{
          WebkitBackdropFilter: "blur(40px) saturate(180%)",
        }}
      >
        <span className="w-2 h-2 rounded-full bg-[var(--system-green)] shrink-0 animate-[lsw-pulse_2s_ease-in-out_infinite]" />
        <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] font-[var(--weight-medium)]">
          Live Stream
        </span>
        {entries.length > 0 && (
          <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] bg-[var(--fill-secondary)] px-1.5 py-px rounded-[var(--radius-sm)]">
            {entries.length}
          </span>
        )}
        <style>{`@keyframes lsw-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
      </button>
    )
  }

  /* ── Expanded panel ───────────────────────────────────────── */

  return (
    <div
      className="panel-slide-in fixed bottom-5 right-5 z-50 w-[440px] h-[400px] rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--material-regular)] flex flex-col overflow-hidden backdrop-blur-[40px] backdrop-saturate-[1.8] shadow-[0_8px_40px_rgba(0,0,0,0.35)]"
      style={{
        WebkitBackdropFilter: "blur(40px) saturate(180%)",
      }}
    >
      {/* Header */}
      <div className="flex items-center shrink-0 px-3.5 py-2.5 border-b border-[var(--separator)] gap-2">
        <span className="w-2 h-2 rounded-full bg-[var(--system-green)] shrink-0 animate-[lsw-pulse_2s_ease-in-out_infinite]" />
        <span className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          Live Stream
        </span>
        {entries.length > 0 && (
          <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
            {entries.length} line{entries.length !== 1 ? "s" : ""}
          </span>
        )}

        <div className="ml-auto flex gap-1">
          <button
            onClick={handleCopy}
            title="Copy all logs"
            disabled={entries.length === 0}
            className={`focus-ring w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border-none transition-all duration-150 ${
              copied ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "bg-transparent text-[var(--text-tertiary)]"
            } ${entries.length === 0 ? "cursor-default opacity-30" : "cursor-pointer opacity-100"}`}
          >
            <Copy size={14} />
          </button>
          <button
            onClick={() => setState("collapsed")}
            className="focus-ring w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer transition-colors duration-150"
            title="Minimize"
          >
            <Minimize2 size={14} />
          </button>
          <button
            onClick={handleClose}
            className="focus-ring w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer transition-colors duration-150"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3.5 py-1.5 bg-[rgba(255,69,58,0.06)] border-b border-[rgba(255,69,58,0.15)] text-[length:var(--text-caption2)] text-[var(--system-red)] shrink-0">
          {error}
        </div>
      )}

      {/* Log area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--text-secondary)] gap-[var(--space-2)] p-[var(--space-4)]">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[var(--text-tertiary)]"
            >
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)]">
              Waiting for log data...
            </span>
          </div>
        ) : (
          <div>
            {entries.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center shrink-0 px-3.5 py-2 border-t border-[var(--separator)] gap-2">
        {!autoScroll && entries.length > 0 && (
          <button
            onClick={() => setAutoScroll(true)}
            className="focus-ring px-2.5 py-1 rounded-[var(--radius-sm)] border-none cursor-pointer text-[length:var(--text-caption2)] font-[var(--weight-medium)] bg-[var(--fill-secondary)] text-[var(--text-secondary)]"
          >
            Scroll to bottom
          </button>
        )}
      </div>

      <style>{`@keyframes lsw-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  )
}

"use client"
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { TranscriptEntry, TranscriptContentBlock } from '@/lib/api'

/* ── Tool input collapse ─────────────────────────────────── */

function ToolInput({ input }: { input: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false)
  const serialised = JSON.stringify(input, null, 2)
  const isLong = serialised.length > 300

  if (!isLong) {
    return (
      <pre className="mt-1 px-2.5 py-1.5 bg-white/5 rounded text-xs leading-normal whitespace-pre-wrap break-all text-[var(--text-secondary)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] overflow-x-auto">
        {serialised}
      </pre>
    )
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 px-2 py-0.5 text-[11px] rounded bg-white/[0.08] border border-white/[0.12] text-[var(--text-tertiary)] cursor-pointer font-[SF_Mono,Menlo,Cascadia_Code,monospace]"
      >
        {expanded ? 'collapse input' : `show input (${serialised.length} chars)`}
      </button>
      {expanded && (
        <pre className="mt-1 px-2.5 py-1.5 bg-white/5 rounded text-xs leading-normal whitespace-pre-wrap break-all text-[var(--text-secondary)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] overflow-x-auto max-h-[400px] overflow-y-auto">
          {serialised}
        </pre>
      )}
    </div>
  )
}

/* ── Thinking block ──────────────────────────────────────── */

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mb-1.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="px-2 py-0.5 text-[11px] rounded bg-white/[0.06] border border-white/10 text-[var(--text-quaternary,var(--text-tertiary))] cursor-pointer font-[SF_Mono,Menlo,Cascadia_Code,monospace] italic"
      >
        {expanded ? 'hide thinking' : 'show thinking'}
      </button>
      {expanded && (
        <div className="mt-1 px-3 py-2 bg-white/[0.04] border-l-2 border-white/10 text-xs leading-relaxed text-[var(--text-quaternary,var(--text-tertiary))] italic whitespace-pre-wrap break-words font-[SF_Mono,Menlo,Cascadia_Code,monospace]">
          {text}
        </div>
      )}
    </div>
  )
}

/* ── Tool result collapse ────────────────────────────────── */

function ToolResult({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > 500

  if (!isLong) {
    return (
      <pre className="mt-1 px-2.5 py-1.5 bg-white/[0.04] rounded text-xs leading-normal whitespace-pre-wrap break-all text-[var(--text-tertiary)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] overflow-x-auto max-h-[300px] overflow-y-auto">
        {text || '(empty)'}
      </pre>
    )
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 px-2 py-0.5 text-[11px] rounded bg-white/[0.08] border border-white/[0.12] text-[var(--text-tertiary)] cursor-pointer font-[SF_Mono,Menlo,Cascadia_Code,monospace]"
      >
        {expanded ? 'collapse output' : `show output (${text.length} chars)`}
      </button>
      {expanded && (
        <pre className="mt-1 px-2.5 py-1.5 bg-white/[0.04] rounded text-xs leading-normal whitespace-pre-wrap break-all text-[var(--text-tertiary)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] overflow-x-auto max-h-[400px] overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  )
}

/* ── Single content block renderer ──────────────────────── */

function ContentBlock({ block }: { block: TranscriptContentBlock }) {
  if (block.type === 'thinking') {
    return <ThinkingBlock text={block.text || ''} />
  }

  if (block.type === 'tool_use') {
    return (
      <div className="mb-2 px-2.5 py-1.5 bg-[rgba(99,179,237,0.08)] border border-[rgba(99,179,237,0.2)] rounded-md">
        <div className="text-[11px] font-semibold text-[rgba(99,179,237,0.9)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] mb-0.5 uppercase tracking-wide">
          tool: {block.name}
        </div>
        {block.input && Object.keys(block.input).length > 0 && (
          <ToolInput input={block.input} />
        )}
      </div>
    )
  }

  if (block.type === 'tool_result') {
    return (
      <div className="mb-2 px-2.5 py-1.5 bg-white/[0.03] border border-white/[0.08] rounded-md">
        <div className="text-[11px] font-semibold text-[rgba(160,160,160,0.7)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] mb-0.5 uppercase tracking-wide">
          result
        </div>
        <ToolResult text={block.text || ''} />
      </div>
    )
  }

  // type === 'text'
  return (
    <div className="whitespace-pre-wrap break-words leading-relaxed text-[var(--text-primary)] mb-1">
      {block.text}
    </div>
  )
}

/* ── Single transcript entry ─────────────────────────────── */

function TranscriptEntryRow({ entry }: { entry: TranscriptEntry }) {
  const isUser = entry.role === 'user'

  // Filter out purely tool_result entries from user role (they appear inline in assistant context)
  // but still render them so the transcript is complete
  const prefix = isUser ? '>' : '$'
  const prefixColor = isUser ? 'var(--accent)' : 'rgba(110, 231, 183, 0.8)'

  return (
    <div className="flex gap-2.5 py-2.5 border-b border-white/[0.04]">
      {/* Role prefix */}
      <div
        className="shrink-0 w-4 text-[13px] font-bold font-[SF_Mono,Menlo,Cascadia_Code,monospace] pt-px"
        style={{ color: prefixColor }}
      >
        {prefix}
      </div>

      {/* Content blocks */}
      <div className="flex-1 min-w-0">
        {entry.content.map((block, i) => (
          <ContentBlock key={i} block={block} />
        ))}
      </div>
    </div>
  )
}

/* ── Main component ──────────────────────────────────────── */

interface CliTranscriptProps {
  sessionId: string
}

export function CliTranscript({ sessionId }: CliTranscriptProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sessionId) return
    setLoading(true)
    setError(null)

    api.getSessionTranscript(sessionId)
      .then((data) => {
        setEntries(data)
        setLoading(false)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load transcript')
        setLoading(false)
      })
  }, [sessionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [entries])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary,var(--bg))] text-[var(--text-tertiary)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] text-[13px]">
        loading transcript...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary,var(--bg))] text-[var(--system-red)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] text-[13px]">
        error: {error}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary,var(--bg))] text-[var(--text-tertiary)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] text-[13px]">
        no transcript available
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden bg-[var(--bg-primary,var(--bg))] p-[var(--space-4)] font-[SF_Mono,Menlo,Cascadia_Code,monospace] text-[13px] leading-normal min-h-0">
      {entries.map((entry, i) => (
        <TranscriptEntryRow key={i} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

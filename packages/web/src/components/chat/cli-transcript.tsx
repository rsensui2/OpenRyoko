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
      <pre style={{
        margin: '4px 0 0',
        padding: '6px 10px',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: 'var(--text-secondary)',
        fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        overflowX: 'auto',
      }}>
        {serialised}
      </pre>
    )
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          marginTop: 4,
          padding: '2px 8px',
          fontSize: 11,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'var(--text-tertiary)',
          cursor: 'pointer',
          fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        }}
      >
        {expanded ? 'collapse input' : `show input (${serialised.length} chars)`}
      </button>
      {expanded && (
        <pre style={{
          margin: '4px 0 0',
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.05)',
          borderRadius: 4,
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--text-secondary)',
          fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
          overflowX: 'auto',
          maxHeight: 400,
          overflowY: 'auto',
        }}>
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
    <div style={{ marginBottom: 6 }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          padding: '2px 8px',
          fontSize: 11,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: 'var(--text-quaternary, var(--text-tertiary))',
          cursor: 'pointer',
          fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
          fontStyle: 'italic',
        }}
      >
        {expanded ? 'hide thinking' : 'show thinking'}
      </button>
      {expanded && (
        <div style={{
          marginTop: 4,
          padding: '8px 12px',
          background: 'rgba(255,255,255,0.04)',
          borderLeft: '2px solid rgba(255,255,255,0.1)',
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--text-quaternary, var(--text-tertiary))',
          fontStyle: 'italic',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        }}>
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
      <pre style={{
        margin: '4px 0 0',
        padding: '6px 10px',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: 'var(--text-tertiary)',
        fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        overflowX: 'auto',
        maxHeight: 300,
        overflowY: 'auto',
      }}>
        {text || '(empty)'}
      </pre>
    )
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          marginTop: 4,
          padding: '2px 8px',
          fontSize: 11,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'var(--text-tertiary)',
          cursor: 'pointer',
          fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        }}
      >
        {expanded ? 'collapse output' : `show output (${text.length} chars)`}
      </button>
      {expanded && (
        <pre style={{
          margin: '4px 0 0',
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.04)',
          borderRadius: 4,
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--text-tertiary)',
          fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
          overflowX: 'auto',
          maxHeight: 400,
          overflowY: 'auto',
        }}>
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
      <div style={{
        marginBottom: 8,
        padding: '6px 10px',
        background: 'rgba(99, 179, 237, 0.08)',
        border: '1px solid rgba(99, 179, 237, 0.2)',
        borderRadius: 6,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'rgba(99, 179, 237, 0.9)',
          fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
          marginBottom: 2,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
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
      <div style={{
        marginBottom: 8,
        padding: '6px 10px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'rgba(160,160,160,0.7)',
          fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
          marginBottom: 2,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          result
        </div>
        <ToolResult text={block.text || ''} />
      </div>
    )
  }

  // type === 'text'
  return (
    <div style={{
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      lineHeight: 1.6,
      color: 'var(--text-primary)',
      marginBottom: 4,
    }}>
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
    <div style={{
      display: 'flex',
      gap: 10,
      padding: '10px 0',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      {/* Role prefix */}
      <div style={{
        flexShrink: 0,
        width: 16,
        fontSize: 13,
        fontWeight: 700,
        color: prefixColor,
        fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        paddingTop: 1,
      }}>
        {prefix}
      </div>

      {/* Content blocks */}
      <div style={{ flex: 1, minWidth: 0 }}>
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
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary, var(--bg))',
        color: 'var(--text-tertiary)',
        fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        fontSize: 13,
      }}>
        loading transcript...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary, var(--bg))',
        color: 'var(--system-red)',
        fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        fontSize: 13,
      }}>
        error: {error}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary, var(--bg))',
        color: 'var(--text-tertiary)',
        fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
        fontSize: 13,
      }}>
        no transcript available
      </div>
    )
  }

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      overflowX: 'hidden',
      background: 'var(--bg-primary, var(--bg))',
      padding: 'var(--space-4)',
      fontFamily: '"SF Mono", Menlo, "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.5,
      minHeight: 0,
    }}>
      {entries.map((entry, i) => (
        <TranscriptEntryRow key={i} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

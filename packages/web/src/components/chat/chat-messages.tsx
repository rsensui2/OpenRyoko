"use client"
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message, MediaAttachment } from '@/lib/conversations'
import { parseMedia } from '@/lib/conversations'
import { FileAttachment } from './file-attachment'
import { VoiceMessage } from './voice-message'

/* ── Tool grouping ──────────────────────────────────────── */

type MessageItem =
  | { kind: 'message'; msg: Message; index: number }
  | { kind: 'tool-group'; msgs: Message[]; startIndex: number }

function groupMessages(messages: Message[]): MessageItem[] {
  const items: MessageItem[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i].role === 'assistant' && messages[i].toolCall) {
      const toolMsgs: Message[] = []
      const start = i
      while (i < messages.length && messages[i].role === 'assistant' && messages[i].toolCall) {
        toolMsgs.push(messages[i])
        i++
      }
      items.push({ kind: 'tool-group', msgs: toolMsgs, startIndex: start })
    } else {
      items.push({ kind: 'message', msg: messages[i], index: i })
      i++
    }
  }
  return items
}

function ToolGroup({ msgs, isActive }: { msgs: Message[]; isActive: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const allDone = msgs.every((m) => m.content.startsWith('Used '))
  const label = isActive && !allDone
    ? `${msgs.length} tool${msgs.length !== 1 ? 's' : ''} running…`
    : `${msgs.length} tool${msgs.length !== 1 ? 's' : ''} used`

  return (
    <div className="px-[var(--space-4)] mb-[var(--space-1)]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-[var(--space-2)] py-[5px] px-[var(--space-3)] rounded-full bg-[var(--fill-secondary)] border border-[var(--separator)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] cursor-pointer transition-[background] duration-150 ease-in-out hover:bg-[var(--fill-tertiary)]"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        {label}
        {isActive && !allDone && (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite]" />
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform duration-150 ease-in-out opacity-50 ${expanded ? 'rotate-180' : 'rotate-0'}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div className="flex flex-wrap gap-[var(--space-1)] mt-[var(--space-1)] pl-[var(--space-1)]">
          {msgs.map((m) => (
            <span
              key={m.id}
              className="inline-flex items-center gap-1 py-0.5 px-2 rounded-full bg-[var(--fill-tertiary)] border border-[var(--separator)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
            >
              {m.toolCall}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Markdown rendering ─────────────────────────────────── */

function inlineFormat(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  // URLs, bold, inline code, italic — in priority order
  const regex = /(https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"])|(\*\*(.+?)\*\*)|(`([^`]+)`)|\*([^*]+)\*/g
  let last = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1]) {
      parts.push(
        <a
          key={match.index}
          href={match[1]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--system-blue)] underline underline-offset-2"
        >
          {match[1]}
        </a>
      )
    } else if (match[2]) {
      parts.push(<strong key={match.index} className="font-[var(--weight-bold)]">{match[3]}</strong>)
    } else if (match[4]) {
      parts.push(
        <code key={match.index} className="bg-[var(--fill-secondary)] border border-[var(--separator)] rounded-[5px] py-px px-[5px] text-[0.88em] font-['SF_Mono',Menlo,monospace] text-[var(--accent)]">{match[5]}</code>
      )
    } else if (match[6]) {
      parts.push(<em key={match.index} className="italic opacity-[0.85]">{match[6]}</em>)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length === 1 ? parts[0] : <>{parts}</>
}

function CodeBlock({ code, keyProp }: { code: string; keyProp: number }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div key={keyProp} className="relative my-2">
      <button
        onClick={handleCopy}
        aria-label="Copy code"
        className="absolute top-2 right-2 py-0.5 px-2 text-[11px] rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] text-[var(--text-secondary)] border border-[var(--separator)] cursor-pointer"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre className="code-block bg-[var(--fill-tertiary)] border border-[var(--separator)] rounded-[var(--radius-md)] py-[var(--space-3)] px-[var(--space-4)] overflow-x-auto text-[13px] leading-normal font-['SF_Mono',Menlo,monospace] text-[var(--text-primary)]"><code>{code}</code></pre>
    </div>
  )
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim())
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

function TableBlock({ headerLine, rows, keyProp }: { headerLine: string; rows: string[]; keyProp: number }) {
  const headers = parseTableRow(headerLine)
  const bodyRows = rows.map(parseTableRow)

  return (
    <div key={keyProp} className="my-2.5 rounded-[10px] border border-[var(--separator)] overflow-hidden">
      <div className="overflow-x-auto [WebkitOverflowScrolling:touch]">
        <table className="border-collapse text-[length:var(--text-footnote)] leading-[1.6] w-full min-w-max">
          <thead>
            <tr className="bg-[var(--fill-tertiary)]">
              {headers.map((h, hi) => (
                <th key={hi} className="text-left py-2.5 px-4 font-semibold text-[var(--text-primary)] border-b border-[var(--separator)] max-w-[280px] break-words">{inlineFormat(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 1 ? 'bg-[var(--fill-quaternary,transparent)]' : 'bg-transparent'}>
                {row.map((cell, ci) => (
                  <td key={ci} className={`py-2.5 px-4 text-[var(--text-primary)] max-w-[280px] break-words ${ri < bodyRows.length - 1 ? 'border-b border-[var(--separator)]' : ''}`}>{inlineFormat(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatMessage(content: string): React.ReactNode {
  if (!content) return null
  const lines = content.split('\n')
  const result: React.ReactNode[] = []
  let inCodeBlock = false
  let codeLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLines = []
      } else {
        inCodeBlock = false
        result.push(<CodeBlock key={i} keyProp={i} code={codeLines.join('\n')} />)
        codeLines = []
      }
      continue
    }
    if (inCodeBlock) { codeLines.push(line); continue }

    // Table detection: header row | separator row | body rows
    if (line.trim().startsWith('|') && line.trim().endsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerLine = line
      i++ // skip separator
      const tableRows: string[] = []
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|') && lines[i + 1].trim().endsWith('|') && !isTableSeparator(lines[i + 1])) {
        i++
        tableRows.push(lines[i])
      }
      result.push(<TableBlock key={`table-${i}`} keyProp={i} headerLine={headerLine} rows={tableRows} />)
      continue
    }

    if (line.trim() === '') { result.push(<div key={`space-${i}`} className="h-1.5" />); continue }
    if (line.match(/^[-*] /)) {
      result.push(
        <div key={i} className="flex gap-[var(--space-2)] mb-0.5">
          <span className="text-[var(--accent)] shrink-0 mt-px">&bull;</span>
          <span>{inlineFormat(line.slice(2))}</span>
        </div>
      )
      continue
    }
    if (line.match(/^\d+\. /)) {
      const num = line.match(/^(\d+)\. /)?.[1]
      result.push(
        <div key={i} className="flex gap-[var(--space-2)] mb-0.5">
          <span className="text-[var(--accent)] shrink-0 font-[var(--weight-semibold)] min-w-4">{num}.</span>
          <span>{inlineFormat(line.replace(/^\d+\. /, ''))}</span>
        </div>
      )
      continue
    }
    if (line.startsWith('### ')) {
      result.push(
        <div key={i} className="font-[var(--weight-semibold)] text-[length:var(--text-footnote)] mt-[var(--space-2)] mb-0.5">
          {inlineFormat(line.slice(4))}
        </div>
      )
      continue
    }
    if (line.startsWith('## ')) {
      result.push(
        <div key={i} className="font-[var(--weight-bold)] text-[length:var(--text-subheadline)] mt-[var(--space-3)] mb-[3px]">
          {inlineFormat(line.slice(3))}
        </div>
      )
      continue
    }
    if (line.startsWith('# ')) {
      result.push(
        <div key={i} className="font-[var(--weight-bold)] text-[length:var(--text-body)] mt-[var(--space-3)] mb-[var(--space-1)]">
          {inlineFormat(line.slice(2))}
        </div>
      )
      continue
    }
    result.push(<div key={i} className="mb-px">{inlineFormat(line)}</div>)
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    result.push(<CodeBlock key="trailing-code" keyProp={999} code={codeLines.join('\n')} />)
  }

  return <>{result}</>
}

/* ── Partial markdown fixer for streaming ───────────────── */

/**
 * Close unclosed markdown tokens so partial content renders cleanly.
 * Handles: code blocks (```), inline code (`), bold (**), italic (*).
 */
function closePartialMarkdown(text: string): string {
  let result = text

  // Count triple backticks — if odd, close the code block
  const tripleBackticks = (result.match(/```/g) || []).length
  if (tripleBackticks % 2 !== 0) {
    result += '\n```'
  }

  // Only fix inline markers outside of code blocks
  if (tripleBackticks % 2 === 0) {
    // Count inline backticks outside code blocks (simplified: count ` not part of ```)
    const withoutCodeBlocks = result.replace(/```[\s\S]*?```/g, '')
    const inlineBackticks = (withoutCodeBlocks.match(/`/g) || []).length
    if (inlineBackticks % 2 !== 0) {
      result += '`'
    }

    // Count ** pairs
    const boldMarkers = (withoutCodeBlocks.match(/\*\*/g) || []).length
    if (boldMarkers % 2 !== 0) {
      result += '**'
    }
  }

  return result
}

/* ── Timestamp formatting ──────────────────────────────── */

function formatTimestamp(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const isToday = now.toDateString() === date.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = yesterday.toDateString() === date.toDateString()
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  if (isToday) return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`
}

function shouldShowTimestamp(messages: Message[], index: number): boolean {
  if (index === 0) return true
  const gap = messages[index].timestamp - messages[index - 1].timestamp
  return gap > 5 * 60 * 1000
}

/* ── Render media helpers ─────────────────────────────── */

function renderMedia(media: MediaAttachment[], isUser: boolean) {
  const images = media.filter(m => m.type === 'image')
  const audio = media.filter(m => m.type === 'audio')
  const files = media.filter(m => m.type === 'file')

  return (
    <>
      {images.map((m, mi) => (
        <div key={`img-${mi}`} className="mt-[var(--space-2)] rounded-[var(--radius-lg)] overflow-hidden max-w-[280px]">
          <img
            src={m.url}
            alt={m.name || 'Image'}
            className="w-full block rounded-[var(--radius-lg)] cursor-pointer"
            onClick={() => window.open(m.url, '_blank')}
          />
        </div>
      ))}
      {audio.map((m, mi) => (
        <div key={`audio-${mi}`} className="mt-[var(--space-2)]">
          <VoiceMessage
            src={m.url}
            duration={m.duration || 0}
            waveform={m.waveform || []}
            isUser={isUser}
          />
        </div>
      ))}
      {files.map((m, mi) => (
        <div key={`file-${mi}`} className="mt-[var(--space-2)]">
          <FileAttachment
            name={m.name || 'File'}
            size={m.size}
            mimeType={m.mimeType}
            url={m.url}
            isUser={isUser}
          />
        </div>
      ))}
    </>
  )
}

/* ── Component ──────────────────────────────────────────── */

interface ChatMessagesProps {
  messages: Message[]
  loading: boolean
  streamingText?: string
}

export function ChatMessages({ messages, loading, streamingText }: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const prevMsgCount = useRef(0)
  const prevMsgIdRef = useRef<string | null>(null)

  // Use useLayoutEffect for instant scroll (before paint) to avoid flash
  useLayoutEffect(() => {
    if (messages.length === 0) {
      prevMsgCount.current = 0
      prevMsgIdRef.current = null
      return
    }

    const currentFirstId = messages[0]?.id || null
    const isSessionSwitch = prevMsgIdRef.current !== null && currentFirstId !== prevMsgIdRef.current
    const isInitialLoad = prevMsgCount.current === 0 && messages.length > 0

    if (isInitialLoad || isSessionSwitch) {
      // Snap to bottom instantly before paint — no visible scroll
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
      }
    } else {
      // New messages arriving in same session — smooth scroll
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    prevMsgCount.current = messages.length
    prevMsgIdRef.current = currentFirstId
  }, [messages])

  // Also scroll on loading state changes (streaming starts)
  useEffect(() => {
    if (loading && messages.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [loading, messages.length])

  if (messages.length === 0 && !loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
            Start a conversation
          </div>
          <div className="text-[length:var(--text-footnote)] text-[var(--text-quaternary)] mt-[var(--space-2)]">
            Send a message or use /new to begin
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollContainerRef} className="chat-messages-scroll flex-1 overflow-y-auto overflow-x-hidden py-[var(--space-3)] pb-[var(--space-6)] bg-[var(--bg)] min-h-0">
      {groupMessages(messages).map((item) => {
        if (item.kind === 'tool-group') {
          const firstMsg = item.msgs[0]
          const showTimestamp = shouldShowTimestamp(messages, item.startIndex)
          const prevMsg = item.startIndex > 0 ? messages[item.startIndex - 1] : null
          const isActive = loading && item.startIndex + item.msgs.length === messages.length
          return (
            <div key={`tg-${item.startIndex}`}>
              {showTimestamp && (
                <div className="text-center py-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  {formatTimestamp(firstMsg.timestamp)}
                </div>
              )}
              {!showTimestamp && prevMsg && (
                <div className={prevMsg.role !== 'assistant' ? 'h-[var(--space-4)]' : 'h-[var(--space-1)]'} />
              )}
              <ToolGroup msgs={item.msgs} isActive={isActive} />
            </div>
          )
        }

        const { msg, index: i } = item
        const isUser = msg.role === 'user'
        const isNotification = msg.role === 'notification'
        const showTimestamp = shouldShowTimestamp(messages, i)
        const media = msg.media || parseMedia(msg.content)

        // Strip media URLs from text for display
        let textContent = msg.content
        if (media.length > 0 && !msg.media) {
          media.forEach(m => {
            textContent = textContent.replace(m.url, '')
            textContent = textContent.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
          })
          textContent = textContent.trim()
        }
        // Hide auto-generated content labels for media-only messages
        if (msg.media && msg.media.length > 0) {
          const isAutoLabel = textContent.startsWith('[') && textContent.endsWith(']')
          if (isAutoLabel) textContent = ''
        }

        return (
          <div key={msg.id || i}>
            {/* Timestamp divider */}
            {showTimestamp && (
              <div className="text-center py-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                {formatTimestamp(msg.timestamp)}
              </div>
            )}

            {/* Spacing between role switches */}
            {!showTimestamp && i > 0 && (
              <div className={messages[i - 1].role !== msg.role ? 'h-[var(--space-4)]' : 'h-[var(--space-1)]'} />
            )}

            {/* Notification message — centered system-style banner */}
            {isNotification && (
              <div className="flex justify-center px-[var(--space-4)] mb-[var(--space-1)]">
                <div className="notification-msg-bubble flex items-start gap-[var(--space-2)] py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-md)] bg-[var(--fill-secondary)] border border-dashed border-[var(--separator)] text-[var(--text-secondary)] text-[length:var(--text-caption1)] leading-[var(--leading-relaxed)] max-w-[85%]">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 opacity-60">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <span>{formatMessage(textContent)}</span>
                </div>
              </div>
            )}

            {/* User message */}
            {isUser && (
              <div className="flex flex-col items-end px-[var(--space-4)] mb-[var(--space-1)]">
                {textContent && (
                  <div className="user-msg-bubble py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-lg)_var(--radius-lg)_var(--radius-sm)_var(--radius-lg)] bg-[var(--accent)] text-[var(--accent-contrast)] text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] font-[var(--weight-medium)] shadow-[var(--shadow-subtle)]">
                    {formatMessage(textContent)}
                  </div>
                )}
                {media.length > 0 && (
                  <div className="user-msg-bubble">
                    {renderMedia(media, true)}
                  </div>
                )}
              </div>
            )}

            {/* Assistant message */}
            {!isUser && !isNotification && (
              <div className="assistant-msg-row flex justify-start px-[var(--space-4)] mb-[var(--space-1)]">
                <div className="assistant-msg-bubble flex flex-col">
                  {/* Text bubble */}
                  {textContent && (
                    <div className="py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-sm)_var(--radius-lg)_var(--radius-lg)_var(--radius-lg)] bg-[var(--material-thin)] border border-[var(--separator)] text-[var(--text-primary)] text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)]">
                      {formatMessage(textContent)}
                    </div>
                  )}

                  {/* Media attachments */}
                  {media.length > 0 && renderMedia(media, false)}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Streaming message — shows text as it arrives */}
      {streamingText && (
        <div className="assistant-msg-row flex justify-start px-[var(--space-4)] mb-[var(--space-1)]">
          <div className="assistant-msg-bubble flex flex-col">
            <div className="py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-sm)_var(--radius-lg)_var(--radius-lg)_var(--radius-lg)] bg-[var(--material-thin)] border border-[var(--separator)] text-[var(--text-primary)] text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)]">
              {formatMessage(closePartialMarkdown(streamingText))}
            </div>
          </div>
        </div>
      )}

      {/* Thinking indicator — visible while waiting, disappears when streaming or response arrives */}
      {loading && !streamingText && messages.length > 0 && (
        <div className="flex items-center gap-1.5 py-1.5 px-[var(--space-4)] mt-[var(--space-1)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-[jinn-pulse_1.4s_infinite] shrink-0" />
          <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)]">
            Thinking
          </span>
        </div>
      )}

      <div ref={bottomRef} />

      {/* Keyframe animations + responsive bubble widths */}
      <style>{`
        @keyframes jinn-pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        .assistant-msg-bubble { max-width: 100%; overflow-wrap: break-word; word-break: break-word; }
        .user-msg-bubble { max-width: 90%; overflow-wrap: break-word; word-break: break-word; }
        .notification-msg-bubble { overflow-wrap: break-word; word-break: break-word; }
        .assistant-msg-row { padding: 0 var(--space-2) !important; }
        @media (min-width: 1024px) {
          .assistant-msg-bubble { max-width: 75%; }
          .user-msg-bubble { max-width: 75%; }
          .assistant-msg-row { padding: 0 var(--space-4) !important; }
        }
        /* User message contrast fixes — ensure all child elements are visible on accent background */
        .user-msg-bubble code {
          background: rgba(255,255,255,0.2) !important;
          border-color: rgba(255,255,255,0.3) !important;
          color: inherit !important;
        }
        .user-msg-bubble .code-block,
        .user-msg-bubble pre {
          background: rgba(0,0,0,0.2) !important;
          border-color: rgba(255,255,255,0.15) !important;
          color: rgba(255,255,255,0.95) !important;
        }
        .user-msg-bubble a {
          color: inherit !important;
          text-decoration-color: rgba(255,255,255,0.6) !important;
        }
        .user-msg-bubble strong { color: inherit !important; }
        .user-msg-bubble em { color: inherit !important; opacity: 0.9; }
        .user-msg-bubble span { color: inherit !important; }
        .user-msg-bubble div { color: inherit !important; }
        .user-msg-bubble th, .user-msg-bubble td { color: inherit !important; }
        .user-msg-bubble table { border-color: rgba(255,255,255,0.2) !important; }
        .user-msg-bubble th { border-color: rgba(255,255,255,0.2) !important; }
        .user-msg-bubble td { border-color: rgba(255,255,255,0.15) !important; }
        .user-msg-bubble tr { background: transparent !important; }
        .user-msg-bubble thead tr { background: rgba(255,255,255,0.1) !important; }
        /* Selection visibility for user messages */
        .user-msg-bubble ::selection {
          background: rgba(255,255,255,0.35);
          color: inherit;
        }
        .user-msg-bubble ::-moz-selection {
          background: rgba(255,255,255,0.35);
          color: inherit;
        }
      `}</style>
    </div>
  )
}

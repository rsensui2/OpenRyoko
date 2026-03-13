"use client"
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { MediaAttachment } from '@/lib/conversations'
import { MediaPreview } from './media-preview'
import { useStt } from '@/hooks/use-stt'
import { SttDownloadModal } from './stt-download-modal'
import { SttWaveform } from './stt-waveform'

interface Employee {
  name: string
  displayName?: string
  department?: string
  rank?: string
  engine?: string
}

interface SlashCommand {
  name: string
  description: string
  /** Whether this command needs an @employee argument */
  needsEmployee?: boolean
}

/** Built-in commands handled client-side (not sent to engine) */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new chat session' },
  { name: 'status', description: 'Show current session info' },
]

interface ChatInputProps {
  disabled: boolean
  loading: boolean
  onSend: (message: string, media?: MediaAttachment[], interrupt?: boolean) => void
  onInterrupt?: () => void
  onNewSession: () => void
  onStatusRequest: () => void
  /** Incremented when skills change on the gateway, triggers re-fetch */
  skillsVersion?: number
  /** WebSocket events from useGateway — needed for STT download progress */
  events?: Array<{ event: string; payload: unknown }>
}

/* ── File to MediaAttachment ─────────────────────────────── */

function resizeImage(file: File, maxPx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > maxPx || height > maxPx) {
        const scale = maxPx / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no canvas context')); return }
      ctx.drawImage(img, 0, 0, width, height)
      const mimeType = file.size > 50000 ? 'image/jpeg' : 'image/png'
      const quality = mimeType === 'image/jpeg' ? 0.85 : undefined
      resolve(canvas.toDataURL(mimeType, quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

async function fileToAttachment(file: File): Promise<MediaAttachment> {
  const isImage = file.type.startsWith('image/')
  const isAudio = file.type.startsWith('audio/')

  let dataUrl: string
  if (isImage) {
    dataUrl = await resizeImage(file, 1200)
  } else {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  return {
    type: isImage ? 'image' : isAudio ? 'audio' : 'file',
    url: dataUrl,
    name: file.name,
    mimeType: file.type,
    size: dataUrl.length,
  }
}

/* ── Component ──────────────────────────────────────────── */

export function ChatInput({
  disabled,
  loading,
  onSend,
  onInterrupt,
  onNewSession,
  onStatusRequest,
  skillsVersion,
  events,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [showMentions, setShowMentions] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS)
  const [showCommands, setShowCommands] = useState(false)
  const [commandFilter, setCommandFilter] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<MediaAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mentionItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  const stt = useStt(events)

  // Load employees for @mention (with full details)
  useEffect(() => {
    api
      .getOrg()
      .then(async (data) => {
        const emps = data.employees
        if (!Array.isArray(emps)) return
        const details = await Promise.all(
          emps.map(async (name: string) => {
            try {
              const emp = await api.getEmployee(name)
              return { name: emp.name, displayName: emp.displayName, department: emp.department, rank: emp.rank, engine: emp.engine }
            } catch {
              return { name }
            }
          })
        )
        setEmployees(details)
      })
      .catch(() => {})
  }, [])

  // Load skills as slash commands (re-fetches when skills change on gateway)
  useEffect(() => {
    api.getSkills()
      .then((skills) => {
        if (!Array.isArray(skills)) return
        const skillCommands: SlashCommand[] = skills
          .filter((s) => !BUILTIN_COMMANDS.some((b) => b.name === s.name))
          .map((s) => ({
            name: s.name as string,
            description: (s.description as string) || '',
            needsEmployee: s.name === 'sync',
          }))
        setSlashCommands([...BUILTIN_COMMANDS, ...skillCommands])
      })
      .catch(() => {})
  }, [skillsVersion])


  const handleMentionSelect = useCallback(
    (name: string) => {
      const atIdx = value.lastIndexOf('@')
      if (atIdx !== -1) {
        const before = value.slice(0, atIdx)
        setValue(before + '@' + name + ' ')
      }
      setShowMentions(false)
      textareaRef.current?.focus()
    },
    [value]
  )

  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.needsEmployee) {
        // Insert command + @ to trigger mention autocomplete
        setValue('/' + cmd.name + ' @')
        setShowCommands(false)
        // Trigger mention dropdown
        setMentionFilter('')
        setMentionIndex(0)
        setShowMentions(true)
      } else {
        setValue('/' + cmd.name)
        setShowCommands(false)
      }
      textareaRef.current?.focus()
    },
    []
  )

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setValue(val)

    // Detect slash commands: text starts with / and has no space yet (still typing the command name)
    if (val.startsWith('/') && !val.includes(' ')) {
      const filter = val.slice(1).toLowerCase()
      setCommandFilter(filter)
      setCommandIndex(0)
      setShowCommands(true)
      setShowMentions(false)
      return
    }
    setShowCommands(false)

    // Detect @mentions
    const atIdx = val.lastIndexOf('@')
    if (atIdx !== -1) {
      const afterAt = val.slice(atIdx + 1)
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        setMentionFilter(afterAt.toLowerCase())
        setMentionIndex(0)
        setShowMentions(true)
        return
      }
    }
    setShowMentions(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Command autocomplete navigation
    if (showCommands && filteredCommands.length > 0) {
      const max = filteredCommands.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleCommandSelect(filteredCommands[commandIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowCommands(false)
        return
      }
    }

    // Mention autocomplete navigation
    if (showMentions && filteredEmployees.length > 0) {
      const max = Math.min(filteredEmployees.length, 8)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleMentionSelect(filteredEmployees[mentionIndex].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowMentions(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  function handleSubmit() {
    const trimmed = value.trim()
    const hasMedia = pendingAttachments.length > 0

    if ((!trimmed && !hasMedia) || disabled) return

    // Handle commands
    if (trimmed === '/new') {
      setValue('')
      onNewSession()
      return
    }
    if (trimmed === '/status') {
      setValue('')
      onStatusRequest()
      return
    }

    const mediaToSend = hasMedia ? [...pendingAttachments] : undefined
    setValue('')
    setPendingAttachments([])
    setShowMentions(false)
    setShowCommands(false)

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    onSend(trimmed, mediaToSend, false)
  }

  async function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    const newAttachments: MediaAttachment[] = []
    for (let i = 0; i < files.length; i++) {
      newAttachments.push(await fileToAttachment(files[i]))
    }
    setPendingAttachments((prev) => [...prev, ...newAttachments])
    e.target.value = ''
  }

  function removePendingAttachment(index: number) {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault()
        const file = items[i].getAsFile()
        if (file) {
          const att = await fileToAttachment(file)
          setPendingAttachments((prev) => [...prev, att])
        }
        return
      }
    }
  }

  /* ── Speech-to-text (offline whisper.cpp) ─────────────── */

  const fillTextarea = useCallback((text: string) => {
    if (!text) return
    setValue((prev) => prev ? prev + ' ' + text : text)
  }, [])

  // Auto-resize textarea when value changes programmatically (e.g., from STT)
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }
  }, [value])

  async function handleMicClick() {
    if (stt.state === 'recording') {
      const text = await stt.stopRecording()
      fillTextarea(text ?? '')
      textareaRef.current?.focus()
    } else if (stt.state === 'transcribing') {
      // Do nothing while transcribing
    } else {
      stt.handleMicClick()
    }
  }

  const filteredCommands = slashCommands.filter((c) =>
    c.name.toLowerCase().startsWith(commandFilter)
  )

  const filteredEmployees = employees.filter((e) =>
    e.name.toLowerCase().includes(mentionFilter)
  )

  const hasContent = value.trim().length > 0 || pendingAttachments.length > 0

  return (
    <div className="px-3 sm:px-4" style={{
      paddingTop: 'var(--space-3)',
      paddingBottom: 'var(--space-3)',
      borderTop: '1px solid var(--separator)',
      background: 'var(--material-regular)',
      flexShrink: 0,
      position: 'relative',
    }}>
      {/* Slash command autocomplete */}
      {showCommands && filteredCommands.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: 'var(--space-4)',
          right: 'var(--space-4)',
          marginBottom: 4,
          background: 'var(--bg)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
          maxHeight: 240,
          overflowY: 'auto',
          zIndex: 10,
        }}>
          {filteredCommands.map((cmd, idx) => {
            const isHighlighted = idx === commandIndex
            return (
              <button
                key={cmd.name}
                ref={(el) => {
                  if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
                }}
                onClick={() => handleCommandSelect(cmd)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: 'var(--space-2) var(--space-3)',
                  fontSize: 'var(--text-footnote)',
                  background: isHighlighted ? 'var(--fill-secondary)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  color: 'var(--text-primary)',
                }}
              >
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 'var(--weight-semibold)',
                  color: 'var(--accent)',
                  fontSize: 'var(--text-footnote)',
                }}>/{cmd.name}</span>
                <span style={{
                  color: 'var(--text-tertiary)',
                  fontSize: 'var(--text-caption1)',
                }}>{cmd.description}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Mention autocomplete */}
      {showMentions && filteredEmployees.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: 'var(--space-4)',
          right: 'var(--space-4)',
          marginBottom: 4,
          background: 'var(--bg)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
          maxHeight: 160,
          overflowY: 'auto',
          zIndex: 10,
        }}>
          {filteredEmployees.slice(0, 8).map((emp, idx) => {
            const rankEmoji: Record<string, string> = { executive: '🎯', manager: '📋', senior: '⭐', employee: '👤' }
            const isHighlighted = idx === mentionIndex
            return (
              <button
                key={emp.name}
                ref={(el) => {
                  if (el) mentionItemRefs.current.set(idx, el)
                  else mentionItemRefs.current.delete(idx)
                  if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
                }}
                onClick={() => handleMentionSelect(emp.name)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: 'var(--space-2) var(--space-3)',
                  fontSize: 'var(--text-footnote)',
                  background: isHighlighted ? 'var(--fill-secondary)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  color: 'var(--text-primary)',
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>{rankEmoji[emp.rank || 'employee'] || '👤'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span style={{ fontWeight: 'var(--weight-semibold)' }}>{emp.displayName || emp.name}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption2)', color: 'var(--text-tertiary)' }}>@{emp.name}</span>
                  </div>
                  {emp.department && (
                    <div style={{ fontSize: 'var(--text-caption2)', color: 'var(--text-quaternary)', display: 'flex', gap: 'var(--space-2)', marginTop: 1 }}>
                      <span>{emp.department}</span>
                      {emp.engine && (
                        <span style={{ color: 'var(--accent)', fontWeight: 'var(--weight-medium)' }}>{emp.engine}</span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Pending attachments preview */}
      {pendingAttachments.length > 0 && (
        <div style={{ marginBottom: 'var(--space-2)' }}>
          <MediaPreview
            attachments={pendingAttachments}
            onRemove={removePendingAttachment}
          />
        </div>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        background: 'var(--fill-secondary)',
        borderRadius: 'var(--radius-lg)',
        padding: '6px var(--space-3)',
        border: loading ? '1px solid var(--accent)' : '1px solid var(--separator)',
        minHeight: 44,
        transition: 'border-color 200ms ease',
      }}>
        {/* Attach button */}
        <button
          aria-label="Attach file"
          onClick={() => fileInputRef.current?.click()}
          style={{
            width: 32,
            height: 32,
            flexShrink: 0,
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            marginBottom: 0,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,.pdf,.doc,.docx,.txt,.csv,.json,.zip"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileAttach}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            disabled
              ? 'Waiting for response...'
              : 'Type a message...'
          }
          rows={1}
          disabled={disabled}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            color: 'var(--text-primary)',
            fontSize: 'var(--text-subheadline)',
            lineHeight: '20px',
            maxHeight: 120,
            minHeight: 20,
            height: 20,
            padding: 0,
            margin: 0,
            opacity: disabled ? 0.5 : 1,
          }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement
            target.style.height = 'auto'
            target.style.height = Math.min(target.scrollHeight, 120) + 'px'
          }}
        />

        {/* Language picker — only shown when multiple STT languages configured */}
        {stt.languages.length > 1 && (
          <button
            aria-label={`STT language: ${stt.selectedLanguage.toUpperCase()}. Click to switch.`}
            onClick={stt.cycleLanguage}
            style={{
              height: 24,
              padding: '0 6px',
              flexShrink: 0,
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--fill-tertiary)',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              transition: 'all 150ms ease',
            }}
            title={`Transcription language: ${stt.selectedLanguage.toUpperCase()}. Click to cycle.`}
          >
            {stt.selectedLanguage}
          </button>
        )}

        {/* Voice input / STT button */}
        <button
          aria-label={
            stt.state === 'recording' ? 'Stop recording'
            : stt.state === 'transcribing' ? 'Transcribing…'
            : 'Voice input'
          }
          onClick={handleMicClick}
          disabled={stt.state === 'transcribing'}
          style={{
            width: 32,
            height: 32,
            flexShrink: 0,
            borderRadius: stt.state === 'recording' ? '999px' : 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: stt.state === 'recording' ? 'var(--system-red)' : 'transparent',
            border: 'none',
            cursor: stt.state === 'transcribing' ? 'wait' : 'pointer',
            color: stt.state === 'recording' ? '#fff' : 'var(--text-secondary)',
            transition: 'all 150ms ease',
          }}
          title={
            stt.state === 'recording' ? 'Stop recording'
            : stt.state === 'transcribing' ? 'Transcribing…'
            : 'Voice input'
          }
        >
          {stt.state === 'transcribing' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'stt-spin 1s linear infinite' }}>
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
        </button>

        {/* Live waveform during recording */}
        {stt.state === 'recording' && stt.analyser && (
          <SttWaveform analyser={stt.analyser} width={64} height={28} />
        )}

        {/* Stop button — shown when loading */}
        {loading && onInterrupt && (
          <button
            onClick={onInterrupt}
            aria-label="Stop"
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'var(--system-red)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 150ms ease',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        )}

        {/* Send button */}
        <button
          onClick={handleSubmit}
          disabled={!hasContent || disabled}
          aria-label="Send message"
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: hasContent ? 'var(--accent)' : 'var(--fill-tertiary)',
            color: hasContent ? '#000' : 'var(--text-quaternary)',
            border: 'none',
            cursor: hasContent ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'all 150ms ease',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        </button>
      </div>

      {/* Hint — hidden on mobile for space */}
      <div className="hidden sm:flex" style={{
        fontSize: 'var(--text-caption2)',
        color: 'var(--text-quaternary)',
        textAlign: 'center',
        marginTop: 'var(--space-1)',
        justifyContent: 'center',
        gap: 'var(--space-3)',
      }}>
        <span>Enter to send</span>
        <span>/ - commands</span>
        <span>@name - mention</span>
      </div>

      {/* STT model download modal */}
      <SttDownloadModal
        open={stt.state === 'no-model'}
        progress={stt.downloadProgress}
        onDownload={stt.startDownload}
        onCancel={stt.dismissDownload}
      />

      <style>{`
        @keyframes stt-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

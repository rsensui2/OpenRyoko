"use client"

import { useState, useCallback, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { ChatMessages } from '@/components/chat/chat-messages'
import { ChatInput } from '@/components/chat/chat-input'
import { ChatEmployeePicker } from '@/components/chat/chat-employee-picker'
import { QueuePanel } from '@/components/chat/queue-panel'
import { CliTranscript } from '@/components/chat/cli-transcript'
import { CliTerminal } from '@/components/chat/cli-terminal'
import { ContextMeter } from '@/components/chat/context-meter'
import { formatContextTokens } from '@/lib/context-meter'
import { buildNewSessionParams } from '@/components/chat/new-chat-helpers'
import type { Employee } from '@/lib/api'
import type { Message, MediaAttachment } from '@/lib/conversations'
import { saveIntermediateMessages, loadIntermediateMessages, clearIntermediateMessages } from '@/lib/conversations'

type Listener = (event: string, payload: unknown) => void

interface ChatPaneProps {
  sessionId: string | null
  isActive: boolean
  onFocus: () => void
  /** Notify parent when a new session is created (e.g. first message in new chat) */
  onSessionCreated?: (sessionId: string) => void
  /** Notify parent when session meta changes */
  onSessionMetaChange?: (meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => void
  /** Notify parent to refresh sidebar */
  onRefresh?: () => void
  /** Portal name from settings */
  portalName?: string
  /** Gateway subscribe function for WS events */
  subscribe: (fn: Listener) => () => void
  /** Gateway connection seq number - triggers reload on reconnect */
  connectionSeq?: number
  /** Gateway skills version */
  skillsVersion?: number
  /** Gateway events array */
  events: Array<{ event: string; payload: unknown }>
  /** View mode: chat or cli transcript */
  viewMode?: 'chat' | 'cli'
  /** Optional: onboarding prompt generator for stub sessions */
  getOnboardingPrompt?: (message: string) => string
  /** Whether the current session is a stub (onboarding) */
  isStubSession?: boolean
  /** Callback to clear stub status */
  onStubCleared?: () => void
  /** Incrementing counter that triggers input focus */
  focusTrigger?: number
  /** Callback to open keyboard shortcuts overlay */
  onShortcutsClick?: () => void
  /** Message selected from global search; loads a bounded window around it. */
  focusMessageId?: string | null
  onFocusDismissed?: () => void
}

export function ChatPane({
  sessionId,
  isActive,
  onFocus,
  onSessionCreated,
  onSessionMetaChange,
  onRefresh,
  portalName = 'Jinn',
  subscribe,
  connectionSeq,
  skillsVersion,
  events,
  viewMode = 'chat',
  getOnboardingPrompt,
  isStubSession,
  onStubCleared,
  focusTrigger,
  onShortcutsClick,
  focusMessageId,
  onFocusDismissed,
}: ChatPaneProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasNewer, setHasNewer] = useState(false)
  const streamingTextRef = useRef('')
  const [streamingText, setStreamingText] = useState('')
  const intermediateStartRef = useRef<number>(-1)
  const [currentSession, setCurrentSession] = useState<Record<string, unknown> | null>(null)
  // Whether the gateway's Claude engine runs as a live PTY (interactive). Drives
  // the CLI view: live xterm (/ws/pty) when on, poll-based transcript when off.
  const [claudeInteractive, setClaudeInteractive] = useState(false)
  const sessionIdRef = useRef(sessionId)
  const loadGenerationRef = useRef(0)

  // Employee picker state for new chat
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null)
  const [pickerEmployees, setPickerEmployees] = useState<Pick<Employee, 'name' | 'displayName' | 'department' | 'rank'>[]>([])
  const employeesFetchedRef = useRef(false)

  useEffect(() => {
    if (sessionId) return // Only fetch when no active session
    if (employeesFetchedRef.current && pickerEmployees.length > 0) return // Use cached result
    api.getOrg().then((data) => {
      if (!Array.isArray(data.employees)) return
      setPickerEmployees(data.employees.map((emp) => ({
        name: emp.name,
        displayName: emp.displayName,
        department: emp.department,
        rank: emp.rank,
      })))
      employeesFetchedRef.current = true
    }).catch(() => {})
  }, [sessionId, pickerEmployees.length])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  // Helper: persist intermediate messages to localStorage
  const persistIntermediate = useCallback((msgs: Message[], sid: string | null) => {
    if (!sid) return
    const start = intermediateStartRef.current
    if (start < 0) return
    const intermediate = msgs.slice(start)
    if (intermediate.length > 0) {
      saveIntermediateMessages(sid, intermediate)
    }
  }, [])

  // Listen for session events via subscribe
  useEffect(() => {
    return subscribe((event, payload) => {
      const p = payload as Record<string, unknown>
      const sid = sessionIdRef.current
      if (!sid || p.sessionId !== sid) return

      if (event === 'session:delta') {
        const deltaType = String(p.type || 'text')

        if (deltaType === 'text') {
          const chunk = String(p.content || '')
          streamingTextRef.current += chunk
          setStreamingText(streamingTextRef.current)
        } else if (deltaType === 'text_snapshot') {
          const snapshot = String(p.content || '')
          if (snapshot.length >= streamingTextRef.current.length) {
            streamingTextRef.current = snapshot
            setStreamingText(snapshot)
          }
        } else if (deltaType === 'tool_use') {
          if (streamingTextRef.current) {
            const flushed = streamingTextRef.current
            streamingTextRef.current = ''
            setStreamingText('')
            setMessages((prev) => {
              if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
              const updated = [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content: flushed,
                  timestamp: Date.now(),
                },
              ]
              persistIntermediate(updated, sid)
              return updated
            })
          }
          const toolName = String(p.toolName || 'tool')
          setMessages((prev) => {
            if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
            const updated = [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `Using ${toolName}`,
                timestamp: Date.now(),
                toolCall: toolName,
              },
            ]
            persistIntermediate(updated, sid)
            return updated
          })
        } else if (deltaType === 'tool_result') {
          setMessages((prev) => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last && last.role === 'assistant' && last.toolCall) {
              updated[updated.length - 1] = { ...last, content: `Used ${last.toolCall}` }
            }
            persistIntermediate(updated, sid)
            return updated
          })
        } else if (deltaType === 'permission') {
          const content = String(p.content || 'Claude is waiting for approval in the CLI view.')
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'notification' as const, content, timestamp: Date.now() },
          ])
        }
      }

      if (event === 'session:notification') {
        const notifMessage = String(p.message || '')
        if (notifMessage) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'notification' as const,
              content: notifMessage,
              timestamp: Date.now(),
            },
          ])
        }
      }

      if (event === 'session:interrupted') {
        streamingTextRef.current = ''
        setStreamingText('')
      }

      if (event === 'session:stopped') {
        setLoading(false)
        setStreamingText('')
      }

      if (event === 'session:completed') {
        streamingTextRef.current = ''
        setStreamingText('')
        setLoading(false)
        intermediateStartRef.current = -1

        const completedSessionId = sid || (p.sessionId ? String(p.sessionId) : null)
        if (completedSessionId) {
          clearIntermediateMessages(completedSessionId)
        }

        if (p.result) {
          setMessages((prev) => {
            const cleaned = [...prev]
            const last = cleaned[cleaned.length - 1]
            if (last && last.role === 'assistant' && !last.toolCall) {
              cleaned.pop()
            }
            return [
              ...cleaned,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: String(p.result),
                timestamp: Date.now(),
              },
            ]
          })
        }
        if (p.error && !p.result) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: `Error: ${p.error}`,
              timestamp: Date.now(),
            },
          ])
        }
        // Refresh session meta (e.g. context-meter tokens) without reloading the
        // message history — the turn just persisted lastContextTokens server-side.
        if (completedSessionId) {
          api
            .getSession(completedSessionId, { messages: false })
            .then((s) => {
              if (sessionIdRef.current === completedSessionId) {
                setCurrentSession(s as Record<string, unknown>)
              }
            })
            .catch(() => {})
        }
        onRefresh?.()
      }
    })
  }, [subscribe, persistIntermediate, onRefresh])

  // Detect whether the gateway runs Claude as a live PTY (interactive) so the CLI
  // view can attach the xterm stream. Fetched once; capability is gateway-wide.
  useEffect(() => {
    let cancelled = false
    api
      .getStatus()
      .then((s) => {
        const engines = (s as { engines?: { claude?: { interactive?: boolean } } })?.engines
        if (!cancelled) setClaudeInteractive(engines?.claude?.interactive === true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Load session data
  const loadSession = useCallback(async (id: string, options?: { latest?: boolean }) => {
    const generation = ++loadGenerationRef.current
    try {
      const activeFocus = !options?.latest && focusMessageId ? focusMessageId : null
      let session = (await api.getSession(id, activeFocus ? { messages: false } : { last: 100 })) as Record<string, unknown>
      let anchoredPage = activeFocus ? await api.getSessionMessageWindow(id, activeFocus, 50) : null
      if (activeFocus && !anchoredPage?.anchorFound) {
        session = (await api.getSession(id, { last: 100 })) as Record<string, unknown>
        anchoredPage = null
      }
      if (generation !== loadGenerationRef.current || sessionIdRef.current !== id) return
      setCurrentSession(session)
      const meta = {
        engine: session.engine ? String(session.engine) : undefined,
        engineSessionId: session.engineSessionId ? String(session.engineSessionId) : undefined,
        model: session.model ? String(session.model) : undefined,
        title: session.title ? String(session.title) : undefined,
        employee: session.employee ? String(session.employee) : undefined,
      }
      onSessionMetaChange?.(meta)

      const history = anchoredPage?.messages || session.messages || session.history || []
      const backendMessages: Message[] = Array.isArray(history)
        ? history.map((m: Record<string, unknown>) => ({
            id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
            role: (m.role as 'user' | 'assistant' | 'notification') || 'assistant',
            content: String(m.content || m.text || ''),
            timestamp: m.timestamp ? Number(m.timestamp) : Date.now(),
          }))
        : []
      if (session.status === 'error' && session.lastError) {
        const lastMessage = backendMessages[backendMessages.length - 1]
        const errorText = `Error: ${String(session.lastError)}`
        if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.content !== errorText) {
          backendMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: errorText,
            timestamp: Date.now(),
          })
        }
      }

      const isRunning = session.status === 'running'
      const page = session.messagesPage as { hasOlder?: boolean } | undefined
      setHasOlder(anchoredPage?.hasOlder ?? page?.hasOlder === true)
      setHasNewer(anchoredPage?.hasNewer === true)

      if (isRunning) {
        const cached = loadIntermediateMessages(id)
        if (cached.length > 0) {
          intermediateStartRef.current = backendMessages.length
          setMessages([...backendMessages, ...cached])
        } else {
          intermediateStartRef.current = backendMessages.length
          setMessages(backendMessages)
        }
        setLoading(true)
      } else {
        clearIntermediateMessages(id)
        intermediateStartRef.current = -1
        setMessages(backendMessages)
      }
    } catch {
      if (generation !== loadGenerationRef.current || sessionIdRef.current !== id) return
      setMessages([])
      setCurrentSession(null)
      setHasOlder(false)
      setHasNewer(false)
      intermediateStartRef.current = -1
    }
  }, [onSessionMetaChange, focusMessageId])

  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || loadingOlder || !hasOlder) return
    const before = messages[0]?.id
    if (!before) return
    const generation = loadGenerationRef.current
    setLoadingOlder(true)
    try {
      const page = await api.getSessionMessages(sessionId, before, 100)
      if (sessionIdRef.current !== sessionId || generation !== loadGenerationRef.current) return
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id))
        const older = page.messages
          .filter((message) => !known.has(message.id))
          .map((message) => ({ ...message, role: message.role as Message['role'] }))
        if (intermediateStartRef.current >= 0) intermediateStartRef.current += older.length
        return [...older, ...current]
      })
      setHasOlder(page.hasOlder)
    } finally {
      setLoadingOlder(false)
    }
  }, [sessionId, loadingOlder, hasOlder, messages])

  // Load on session change
  useEffect(() => {
    if (!sessionId) {
      loadGenerationRef.current++
      setMessages([])
      setLoading(false)
      setCurrentSession(null)
      setHasOlder(false)
      setHasNewer(false)
      streamingTextRef.current = ''
      setStreamingText('')
      intermediateStartRef.current = -1
      setSelectedEmployee(null)
      return
    }
    // Clear streaming state immediately to avoid stale content flash
    streamingTextRef.current = ''
    setStreamingText('')
    setLoading(false)
    setLoadingOlder(false)
    loadSession(sessionId)
  }, [sessionId, loadSession])

  // Reload on reconnect
  useEffect(() => {
    if (!connectionSeq || !sessionId) return
    loadSession(sessionId)
  }, [connectionSeq, sessionId, loadSession])

  const jumpToLatestMessages = useCallback(() => {
    if (!sessionId) return
    onFocusDismissed?.()
    void loadSession(sessionId, { latest: true })
  }, [sessionId, onFocusDismissed, loadSession])

  // Poll for completion while loading
  useEffect(() => {
    if (!sessionId || !loading) return
    const timer = setInterval(async () => {
      try {
        const session = (await api.getSession(sessionId, { messages: false })) as Record<string, unknown>
        if (session.status !== 'running') {
          await loadSession(sessionId)
          setLoading(false)
        }
      } catch {
        // ignore transient polling errors
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [sessionId, loading, loadSession])

  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return
    try {
      await api.stopSession(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId])

  const handleSend = useCallback(
    async (message: string, media?: MediaAttachment[], interrupt?: boolean) => {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        media,
      }
      setMessages((prev) => {
        intermediateStartRef.current = prev.length + 1
        return [...prev, userMsg]
      })
      setLoading(true)

      try {
        // Upload any attached files to the server in parallel and collect file IDs
        let attachmentIds: string[] | undefined
        if (media && media.length > 0) {
          const uploadPromises = media
            .filter((att) => att.file)
            .map((att) => api.uploadFile(att.file!))
          if (uploadPromises.length > 0) {
            const uploaded = await Promise.all(uploadPromises)
            attachmentIds = uploaded.map((u) => u.id)
          }
        }

        let sid = sessionId

        // Handle stub session (onboarding)
        if (sid && isStubSession && getOnboardingPrompt) {
          onStubCleared?.()
          const onboardingPrompt = getOnboardingPrompt(message)
          await api.sendMessage(sid, { message: onboardingPrompt, attachments: attachmentIds })
          onRefresh?.()
        } else if (!sid) {
          const params = buildNewSessionParams({
            message,
            selectedEmployee,
            attachmentIds,
          })
          const session = (await api.createSession(params)) as Record<string, unknown>
          sid = String(session.id)
          onSessionCreated?.(sid)
          onRefresh?.()
        } else {
          await api.sendMessage(sid, { message, interrupt: interrupt || undefined, attachments: attachmentIds })
          onRefresh?.()
        }
      } catch (err) {
        setLoading(false)
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `Error: ${err instanceof Error ? err.message : 'Failed to send message'}`,
            timestamp: Date.now(),
          },
        ])
      }
    },
    [sessionId, selectedEmployee, isStubSession, getOnboardingPrompt, onStubCleared, onSessionCreated, onRefresh]
  )

  const handleStatusRequest = useCallback(async () => {
    if (!sessionId) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: 'No active session. Send a message to start one.',
          timestamp: Date.now(),
        },
      ])
      return
    }

    try {
      const session = (await api.getSession(sessionId, { messages: false })) as Record<string, unknown>
      const info = [
        '**Session Info**',
        `ID: \`${session.id}\``,
        `Status: ${session.status || 'unknown'}`,
        session.employee ? `Employee: ${session.employee}` : null,
        session.engine ? `Engine: ${session.engine}` : null,
        session.model ? `Model: ${session.model}` : null,
        typeof session.lastContextTokens === 'number'
          ? `Context: ${formatContextTokens(session.lastContextTokens)}`
          : null,
        session.createdAt ? `Created: ${session.createdAt}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: info,
          timestamp: Date.now(),
        },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: 'Failed to fetch session status.',
          timestamp: Date.now(),
        },
      ])
    }
  }, [sessionId])

  const handleNewSession = useCallback(() => {
    // This just clears the pane state — parent handles actual new session flow
    setMessages([])
    setLoading(false)
    setCurrentSession(null)
    setHasOlder(false)
    setHasNewer(false)
    streamingTextRef.current = ''
    setStreamingText('')
    intermediateStartRef.current = -1
  }, [])

  // Drag & drop state
  const [dragOver, setDragOver] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>()
  const dragCounter = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setDroppedFiles(files)
    }
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--bg)',
        position: 'relative',
      }}
      onClick={onFocus}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {dragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'color-mix(in srgb, var(--bg) 85%, transparent)',
            backdropFilter: 'blur(4px)',
            transition: 'opacity 150ms ease-in-out',
          }}
        >
          <div
            style={{
              border: '2px dashed var(--accent)',
              borderRadius: 'var(--radius-lg)',
              padding: '48px 64px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)' }}>
              Drop files here
            </span>
          </div>
        </div>
      )}
      {/* Employee picker for new chat */}
      {!sessionId && messages.length === 0 && viewMode === 'chat' && (
        <div className="flex flex-1 items-center justify-center">
          <ChatEmployeePicker
            employees={pickerEmployees}
            selectedEmployee={selectedEmployee}
            onSelect={setSelectedEmployee}
            portalName={portalName}
          />
        </div>
      )}

      {/* Messages / CLI transcript */}
      {viewMode === 'cli' && sessionId ? (
        // Live xterm onto the interactive PTY only when the gateway runs Claude in
        // interactive mode AND this session is confirmed a claude session. Any other
        // engine (codex/gemini) or an unloaded/unknown engine falls back to the
        // poll-based transcript, which works for every engine and never opens a
        // /ws/pty the server would just refuse.
        claudeInteractive && currentSession?.engine === 'claude' ? (
          <CliTerminal sessionId={sessionId} />
        ) : (
          <CliTranscript sessionId={sessionId} />
        )
      ) : (sessionId || messages.length > 0) ? (
        <ChatMessages
          messages={messages}
          loading={loading}
          streamingText={streamingText}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={() => void loadOlderMessages()}
          focusMessageId={focusMessageId}
          hasNewer={hasNewer}
          onJumpToLatest={jumpToLatestMessages}
        />
      ) : null}

      {/* Context meter */}
      {viewMode === 'chat' && sessionId && typeof currentSession?.lastContextTokens === 'number' && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '4px 12px 0',
          }}
        >
          <ContextMeter
            tokens={currentSession.lastContextTokens as number}
            model={currentSession.model as string | null | undefined}
          />
        </div>
      )}

      {/* Queue panel */}
      {viewMode === 'chat' && (
        <QueuePanel
          sessionId={sessionId}
          events={events}
          paused={currentSession?.paused as boolean ?? false}
        />
      )}

      {/* Input */}
      {viewMode === 'chat' && (
        <ChatInput
          disabled={false}
          loading={loading}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          onNewSession={handleNewSession}
          onStatusRequest={handleStatusRequest}
          skillsVersion={skillsVersion}
          events={events}
          droppedFiles={droppedFiles}
          onDroppedFilesConsumed={() => setDroppedFiles(undefined)}
          focusTrigger={focusTrigger}
          onShortcutsClick={onShortcutsClick}
        />
      )}
    </div>
  )
}

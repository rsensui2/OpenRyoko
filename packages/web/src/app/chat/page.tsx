"use client"
import { useState, useCallback, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { useGateway } from '@/hooks/use-gateway'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { ChatMessages } from '@/components/chat/chat-messages'
import { ChatInput } from '@/components/chat/chat-input'
import { QueuePanel } from '@/components/chat/queue-panel'
import { CliTranscript } from '@/components/chat/cli-transcript'
import type { Message, MediaAttachment } from '@/lib/conversations'
import { saveIntermediateMessages, loadIntermediateMessages, clearIntermediateMessages } from '@/lib/conversations'
import { useSettings } from '@/app/settings-provider'

function getOnboardingPrompt(portalName: string, userMessage: string) {
  return `This is your first time being activated. The user just set up ${portalName} and opened the web dashboard for the first time.

Read your CLAUDE.md instructions and the onboarding skill at ~/.jinn/skills/onboarding/SKILL.md, then follow the onboarding flow:
- Greet the user warmly and introduce yourself as ${portalName}
- Briefly explain what you can do (manage cron jobs, hire AI employees, connect to Slack, etc.)
- Ask the user what they'd like to set up first

The user said: "${userMessage}"`
}

export default function ChatPageWrapper() {
  return (
    <Suspense fallback={
      <PageLayout>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
          Loading...
        </div>
      </PageLayout>
    }>
      <ChatPage />
    </Suspense>
  )
}

function ChatPage() {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? 'Jinn'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  const [sessionMeta, setSessionMeta] = useState<{ engine?: string; engineSessionId?: string; model?: string; title?: string; employee?: string } | null>(null)
  // Sibling sessions for the currently selected employee (empty if direct/single session)
  const [employeeSessions, setEmployeeSessions] = useState<Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>>([])
  const streamingTextRef = useRef('')
  const [streamingText, setStreamingText] = useState('')
  // Track the index in messages[] where intermediate (streaming) messages start
  const intermediateStartRef = useRef<number>(-1)
  // When true, user explicitly started a new chat — don't auto-select first session
  const newChatIntentRef = useRef(false)
  const [currentSession, setCurrentSession] = useState<Record<string, unknown> | null>(null)
  const [viewMode, setViewMode] = useState<'chat' | 'cli'>('chat')
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const sessionPickerRef = useRef<HTMLDivElement>(null)
  const { events, connectionSeq, skillsVersion, subscribe } = useGateway()
  const selectedIdRef = useRef(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  const searchParams = useSearchParams()
  const onboardingTriggered = useRef(false)
  // When set, the current session is a stub awaiting the user's first message
  const stubSessionRef = useRef(false)

  // Close more menu on outside click
  useEffect(() => {
    if (!showMoreMenu && !showSessionPicker) return
    function handleClick(e: MouseEvent) {
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
      if (showSessionPicker && sessionPickerRef.current && !sessionPickerRef.current.contains(e.target as Node)) {
        setShowSessionPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMoreMenu, showSessionPicker])

  const copyToClipboard = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setShowMoreMenu(false)
    setTimeout(() => setCopiedField(null), 1500)
  }, [])

  // Auto-trigger onboarding on first visit
  useEffect(() => {
    if (onboardingTriggered.current) return

    const shouldOnboard = searchParams.get('onboarding') === '1'

    if (shouldOnboard) {
      onboardingTriggered.current = true
      triggerOnboarding()
    } else {
      api.getOnboarding().then((data) => {
        if (data.needed && !onboardingTriggered.current) {
          onboardingTriggered.current = true
          triggerOnboarding()
        }
      }).catch(() => {})
    }
  }, [searchParams])

  function triggerOnboarding() {
    // Create a stub session with a greeting — engine does NOT run yet.
    // The real onboarding prompt fires when the user sends their first message.
    api.createStubSession({
      greeting: `Hey! 👋 Say hi when you're ready to get started.`,
      title: 'Welcome',
    }).then((session) => {
      const id = String((session as Record<string, unknown>).id)
      stubSessionRef.current = true
      setSelectedId(id)
      setRefreshKey((k) => k + 1)
    }).catch(() => {
      // Silently fail — user can still start a normal chat
    })
  }

  // Helper: persist intermediate messages to localStorage
  const persistIntermediate = useCallback((msgs: Message[], sessionId: string | null) => {
    if (!sessionId) return
    const start = intermediateStartRef.current
    if (start < 0) return
    const intermediate = msgs.slice(start)
    if (intermediate.length > 0) {
      saveIntermediateMessages(sessionId, intermediate)
    }
  }, [])

  // Listen for session events via subscribe — processes every event synchronously,
  // bypassing React 18 automatic batching that would otherwise drop intermediate deltas.
  useEffect(() => {
    return subscribe((event, payload) => {
      const p = payload as Record<string, unknown>
      const sid = selectedIdRef.current
      if (!sid || p.sessionId !== sid) return

      if (event === 'session:delta') {
        const deltaType = String(p.type || 'text')

        if (deltaType === 'text') {
          const chunk = String(p.content || '')
          streamingTextRef.current += chunk
          setStreamingText(streamingTextRef.current)
        } else if (deltaType === 'text_snapshot') {
          // Full text snapshot from assistant partial message — replace streaming text
          // to correct any dropped deltas
          const snapshot = String(p.content || '')
          if (snapshot.length >= streamingTextRef.current.length) {
            streamingTextRef.current = snapshot
            setStreamingText(snapshot)
          }
        } else if (deltaType === 'tool_use') {
          // If we were streaming text, flush it as a message first
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
        }
      }

      if (event === 'session:notification') {
        // Internal notification (e.g. child session completed) — display as a system notification
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
        // Engine was interrupted — clear streaming, wait for new turn
        streamingTextRef.current = ''
        setStreamingText('')
      }

      if (event === 'session:stopped') {
        setLoading(false)
        setStreamingText('')
      }

      if (event === 'session:completed') {
        // Clear streaming state
        streamingTextRef.current = ''
        setStreamingText('')
        setLoading(false)
        intermediateStartRef.current = -1

        // Clear intermediate messages from localStorage (keep showing in UI)
        const completedSessionId = sid || (p.sessionId ? String(p.sessionId) : null)
        if (completedSessionId) {
          clearIntermediateMessages(completedSessionId)
        }

        if (p.result) {
          // Replace any partially-streamed message with the final complete result
          setMessages((prev) => {
            // Remove trailing non-tool assistant message if it was from streaming
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
        setRefreshKey((k) => k + 1)
      }
    })
  }, [subscribe, persistIntermediate])

  const loadSession = useCallback(async (id: string) => {
    try {
      const session = (await api.getSession(id)) as Record<string, unknown>
      setCurrentSession(session)
      setSessionMeta({
        engine: session.engine ? String(session.engine) : undefined,
        engineSessionId: session.engineSessionId ? String(session.engineSessionId) : undefined,
        model: session.model ? String(session.model) : undefined,
        title: session.title ? String(session.title) : undefined,
        employee: session.employee ? String(session.employee) : undefined,
      })
      const history = session.messages || session.history || []
      const backendMessages: Message[] = Array.isArray(history)
        ? history.map((m: Record<string, unknown>) => ({
            id: crypto.randomUUID(),
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

      if (isRunning) {
        // Restore intermediate messages from localStorage
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
        // Session is done — clear any stale intermediate cache and just show backend messages
        clearIntermediateMessages(id)
        intermediateStartRef.current = -1
        setMessages(backendMessages)
      }
    } catch {
      setMessages([])
      setSessionMeta(null)
      setCurrentSession(null)
      intermediateStartRef.current = -1
    }
  }, [])

  useEffect(() => {
    if (!connectionSeq || !selectedId) return
    loadSession(selectedId)
  }, [connectionSeq, selectedId, loadSession])

  useEffect(() => {
    if (!selectedId || !loading) return
    const timer = setInterval(async () => {
      try {
        const session = (await api.getSession(selectedId)) as Record<string, unknown>
        if (session.status !== 'running') {
          await loadSession(selectedId)
          setLoading(false)
        }
      } catch {
        // ignore transient polling errors while WS reconnects
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [selectedId, loading, loadSession])

  const handleEmployeeSessionsAvailable = useCallback(
    (sessions: Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>) => {
      setEmployeeSessions(sessions.length > 1 ? sessions : [])
    },
    []
  )

  const handleSelect = useCallback(
    (id: string) => {
      newChatIntentRef.current = false
      setSelectedId(id)
      setMessages([])
      setLoading(false)
      setMobileView('chat')
      setViewMode('chat')
      loadSession(id)
    },
    [loadSession]
  )

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true
    setSelectedId(null)
    setMessages([])
    setLoading(false)
    setSessionMeta(null)
    setMobileView('chat')
    setEmployeeSessions([])
    intermediateStartRef.current = -1
  }, [])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !onboardingTriggered.current && !newChatIntentRef.current && sessions.length > 0) {
        handleSelect(sessions[0].id)
      }
    },
    [selectedId, handleSelect]
  )

  const handleInterrupt = useCallback(async () => {
    if (!selectedId) return
    try {
      await api.stopSession(selectedId)
    } catch {
      // ignore — session may already be done
    }
  }, [selectedId])

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
        intermediateStartRef.current = prev.length + 1 // after the user message
        return [...prev, userMsg]
      })
      setLoading(true)

      try {
        let sessionId = selectedId

        // If this is a stub session (lazy onboarding), the first user message
        // triggers the real onboarding prompt sent to the engine.
        if (sessionId && stubSessionRef.current) {
          stubSessionRef.current = false
          const onboardingPrompt = getOnboardingPrompt(portalName, message)
          await api.sendMessage(sessionId, { message: onboardingPrompt })
          setRefreshKey((k) => k + 1)
        } else if (!sessionId) {
          const session = (await api.createSession({
            source: 'web',
            prompt: message,
          })) as Record<string, unknown>
          sessionId = String(session.id)
          setSelectedId(sessionId)
          setRefreshKey((k) => k + 1)
        } else {
          await api.sendMessage(sessionId, { message, interrupt: interrupt || undefined })
          setRefreshKey((k) => k + 1)
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
    [selectedId, portalName]
  )

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(id)
      if (selectedId === id) {
        setSelectedId(null)
        setMessages([])
        setLoading(false)
        setSessionMeta(null)
        streamingTextRef.current = ''
        setStreamingText('')
        intermediateStartRef.current = -1
      }
      clearIntermediateMessages(id)
      setRefreshKey((k) => k + 1)
    } catch { /* ignore */ }
    setConfirmDelete(false)
    setShowMoreMenu(false)
  }, [selectedId])

  const handleStatusRequest = useCallback(async () => {
    if (!selectedId) {
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
      const session = (await api.getSession(selectedId)) as Record<string, unknown>
      const info = [
        '**Session Info**',
        `ID: \`${session.id}\``,
        `Status: ${session.status || 'unknown'}`,
        session.employee ? `Employee: ${session.employee}` : null,
        session.engine ? `Engine: ${session.engine}` : null,
        session.model ? `Model: ${session.model}` : null,
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
  }, [selectedId])

  return (
    <PageLayout>
      <div className="h-[calc(100%-48px)] lg:h-full" style={{
        display: 'flex',
        overflow: 'hidden',
      }}>
        {/* Desktop sidebar — always visible on md+ */}
        <div className="hidden lg:block" style={{ width: 280, flexShrink: 0, height: '100%' }}>
          <ChatSidebar
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            onDelete={handleDeleteSession}
            refreshKey={refreshKey}
            connectionSeq={connectionSeq}
            onSessionsLoaded={handleSessionsLoaded}
            events={events}
            onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
          />
        </div>

        {/* Mobile: sidebar view */}
        <div
          className={mobileView === 'sidebar' ? 'block lg:hidden' : 'hidden'}
          style={{
            width: '100%',
            height: '100%',
          }}
        >
          <ChatSidebar
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            onDelete={handleDeleteSession}
            refreshKey={refreshKey}
            connectionSeq={connectionSeq}
            onSessionsLoaded={handleSessionsLoaded}
            events={events}
            onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
          />
        </div>

        {/* Chat area */}
        <div
          style={{
            flex: 1,
            flexDirection: 'column',
            height: '100%',
            background: 'var(--bg)',
            minWidth: 0,
            overflow: 'hidden',
          }}
          className={mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'}
        >
          {/* Header */}
          <div style={{
            height: 52,
            display: 'flex',
            alignItems: 'center',
            padding: '0 var(--space-4)',
            borderBottom: '1px solid var(--separator)',
            background: 'var(--material-thick)',
            flexShrink: 0,
          }}>
            {/* Mobile back button — use Tailwind flex + lg:hidden (no inline display to avoid specificity conflict) */}
            <button
              className="flex lg:hidden"
              onClick={() => setMobileView('sidebar')}
              aria-label="Back to sessions"
              style={{
                padding: 'var(--space-1) var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                marginRight: 'var(--space-2)',
                fontSize: 'var(--text-subheadline)',
                alignItems: 'center',
                gap: 'var(--space-1)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--accent)',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Back
            </button>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 'var(--text-subheadline)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                letterSpacing: '-0.2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {selectedId
                  ? (sessionMeta?.title || sessionMeta?.employee || portalName)
                  : 'New Chat'}
              </div>
            </div>

            {/* Session picker — dropdown + new session button */}
            {selectedId && employeeSessions.length >= 1 && (() => {
              const currentIndex = employeeSessions.findIndex(s => s.id === selectedId)
              const total = employeeSessions.length
              const canPrev = currentIndex < total - 1
              const canNext = currentIndex > 0
              return (
                <div ref={sessionPickerRef} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  marginRight: 'var(--space-2)',
                  flexShrink: 0,
                  position: 'relative',
                }}>
                  {/* Prev/counter/next */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    background: 'var(--fill-tertiary)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '2px 4px',
                  }}>
                    <button
                      onClick={() => {
                        if (canPrev) {
                          const prev = employeeSessions[currentIndex + 1]
                          handleSelect(prev.id)
                        }
                      }}
                      disabled={!canPrev}
                      aria-label="Older session"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: canPrev ? 'pointer' : 'default',
                        padding: '2px 4px',
                        color: canPrev ? 'var(--text-secondary)' : 'var(--text-quaternary)',
                        display: 'flex',
                        alignItems: 'center',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </button>
                    <button
                      onClick={() => setShowSessionPicker(v => !v)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 'var(--text-caption2)',
                        color: 'var(--text-secondary)',
                        whiteSpace: 'nowrap',
                        padding: '0 2px',
                        minWidth: 40,
                        textAlign: 'center',
                      }}
                    >
                      {currentIndex + 1} / {total} ▾
                    </button>
                    <button
                      onClick={() => {
                        if (canNext) {
                          const next = employeeSessions[currentIndex - 1]
                          handleSelect(next.id)
                        }
                      }}
                      disabled={!canNext}
                      aria-label="Newer session"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: canNext ? 'pointer' : 'default',
                        padding: '2px 4px',
                        color: canNext ? 'var(--text-secondary)' : 'var(--text-quaternary)',
                        display: 'flex',
                        alignItems: 'center',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  </div>

                  {/* New session button */}
                  <button
                    onClick={() => {
                      setShowSessionPicker(false)
                      handleNewChat()
                    }}
                    aria-label="New session"
                    title="New session"
                    style={{
                      background: 'var(--fill-tertiary)',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '4px 8px',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      fontSize: 'var(--text-caption2)',
                      fontWeight: 'var(--weight-medium)',
                      gap: 3,
                      transition: 'color 150ms ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    New
                  </button>

                  {/* Session dropdown */}
                  {showSessionPicker && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      marginTop: 4,
                      background: 'var(--material-thick)',
                      border: '1px solid var(--separator)',
                      borderRadius: 'var(--radius-md, 12px)',
                      boxShadow: 'var(--shadow-overlay)',
                      minWidth: 280,
                      maxHeight: 300,
                      overflowY: 'auto',
                      zIndex: 100,
                      padding: 'var(--space-1)',
                    }}>
                      {employeeSessions.map((s, i) => {
                        const isSelected = s.id === selectedId
                        const title = (s as Record<string, unknown>).title as string || `Session ${i + 1}`
                        const time = s.lastActivity || s.createdAt || ''
                        const timeLabel = time ? new Date(time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
                        return (
                          <button
                            key={s.id}
                            onClick={() => {
                              handleSelect(s.id)
                              setShowSessionPicker(false)
                            }}
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 'var(--space-2)',
                              padding: 'var(--space-2) var(--space-3)',
                              background: isSelected ? 'var(--fill-secondary)' : 'transparent',
                              border: 'none',
                              borderRadius: 'var(--radius-sm)',
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            <span style={{
                              fontSize: 'var(--text-caption1)',
                              color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                              fontWeight: isSelected ? 'var(--weight-semibold)' : 'var(--weight-regular)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: 1,
                            }}>
                              {title}
                            </span>
                            <span style={{
                              fontSize: 'var(--text-caption2)',
                              color: 'var(--text-quaternary)',
                              flexShrink: 0,
                            }}>
                              {timeLabel}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* View mode toggle — only shown when a session is selected */}
            {selectedId && (
              <div style={{
                display: 'flex',
                gap: 2,
                padding: 2,
                background: 'var(--fill-tertiary)',
                borderRadius: 'var(--radius-sm)',
                marginRight: 'var(--space-2)',
              }}>
                <button
                  onClick={() => setViewMode('chat')}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 'calc(var(--radius-sm) - 2px)',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 'var(--text-caption1)',
                    fontWeight: viewMode === 'chat' ? 'var(--weight-semibold)' : 'var(--weight-regular)',
                    background: viewMode === 'chat' ? 'var(--bg)' : 'transparent',
                    color: viewMode === 'chat' ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    boxShadow: viewMode === 'chat' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                    transition: 'all 120ms ease',
                  }}
                >
                  Chat
                </button>
                <button
                  onClick={() => setViewMode('cli')}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 'calc(var(--radius-sm) - 2px)',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 'var(--text-caption1)',
                    fontWeight: viewMode === 'cli' ? 'var(--weight-semibold)' : 'var(--weight-regular)',
                    background: viewMode === 'cli' ? 'var(--bg)' : 'transparent',
                    color: viewMode === 'cli' ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    boxShadow: viewMode === 'cli' ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                    transition: 'all 120ms ease',
                    fontFamily: '"SF Mono", Menlo, monospace',
                  }}
                >
                  CLI
                </button>
              </div>
            )}

            {/* Copied toast */}
            {copiedField && (
              <div style={{
                fontSize: 'var(--text-caption1)',
                color: 'var(--accent)',
                marginRight: 'var(--space-2)',
                whiteSpace: 'nowrap',
              }}>
                Copied!
              </div>
            )}

            {/* More menu */}
            {selectedId && (
              <div ref={moreMenuRef} style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowMoreMenu((v) => !v)}
                  aria-label="More options"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 'var(--space-1)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    transition: 'color 150ms ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="12" cy="19" r="2" />
                  </svg>
                </button>

                {showMoreMenu && (
                  <div style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 4,
                    background: 'var(--material-thick)',
                    border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    zIndex: 100,
                    minWidth: 200,
                    overflow: 'hidden',
                  }}>
                    <button
                      onClick={() => copyToClipboard(selectedId, 'id')}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: 'var(--space-2) var(--space-3)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 'var(--text-subheadline)',
                        color: 'var(--text-primary)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill-tertiary)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      Copy Session ID
                    </button>
                    {sessionMeta?.engineSessionId && (
                      <button
                        onClick={() => {
                          const cli = sessionMeta.engine === 'codex' ? 'codex' : 'claude'
                          copyToClipboard(`${cli} --resume ${sessionMeta.engineSessionId}`, 'cli')
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: 'var(--space-2) var(--space-3)',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: 'var(--text-subheadline)',
                          color: 'var(--text-primary)',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill-tertiary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        Copy CLI Resume Command
                      </button>
                    )}
                    <div style={{ borderTop: '1px solid var(--separator)', margin: '2px 0' }} />
                    <button
                      onClick={() => { setShowMoreMenu(false); setConfirmDelete(true) }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        width: '100%',
                        padding: 'var(--space-2) var(--space-3)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 'var(--text-subheadline)',
                        color: 'var(--system-red)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill-tertiary)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      Delete Session
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Messages / CLI transcript */}
          {viewMode === 'cli' && selectedId ? (
            <CliTranscript sessionId={selectedId} />
          ) : (
            <ChatMessages messages={messages} loading={loading} streamingText={streamingText} />
          )}

          {/* Queue panel — shows pending messages with cancel buttons */}
          {viewMode === 'chat' && (
            <QueuePanel
              sessionId={selectedId}
              events={events}
              paused={currentSession?.paused as boolean ?? false}
            />
          )}

          {/* Input — hidden in CLI view */}
          {viewMode === 'chat' && (
            <ChatInput
              disabled={false}
              loading={loading}
              onSend={handleSend}
              onInterrupt={handleInterrupt}
              onNewSession={handleNewChat}
              onStatusRequest={handleStatusRequest}
              skillsVersion={skillsVersion}
              events={events}
            />
          )}
        </div>
      </div>

      {/* Confirm delete dialog from header menu */}
      {confirmDelete && selectedId && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirmDelete(false)}
        >
          <div
            style={{
              background: 'var(--bg)', borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-6)', maxWidth: 400, width: '90%',
              boxShadow: 'var(--shadow-overlay)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 'var(--text-headline)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', marginBottom: 'var(--space-2)' }}>
              Delete Session?
            </h3>
            <p style={{ fontSize: 'var(--text-body)', color: 'var(--text-secondary)', marginBottom: 'var(--space-5)' }}>
              This will permanently delete the session and all its messages.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)',
                  background: 'var(--fill-tertiary)', color: 'var(--text-primary)',
                  border: 'none', cursor: 'pointer', fontSize: 'var(--text-body)',
                }}
              >Cancel</button>
              <button
                onClick={() => handleDeleteSession(selectedId)}
                style={{
                  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)',
                  background: 'var(--system-red)', color: '#fff',
                  border: 'none', cursor: 'pointer', fontSize: 'var(--text-body)',
                  fontWeight: 'var(--weight-semibold)',
                }}
              >Delete</button>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  )
}

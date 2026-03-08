"use client"
import { useState, useCallback, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { useGateway } from '@/hooks/use-gateway'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { ChatMessages } from '@/components/chat/chat-messages'
import { ChatInput } from '@/components/chat/chat-input'
import type { Message, MediaAttachment } from '@/lib/conversations'

const ONBOARDING_PROMPT = `This is your first time being activated. The user just set up Jimmy and opened the web dashboard for the first time.

Read your CLAUDE.md instructions and the onboarding skill at ~/.jimmy/skills/onboarding/SKILL.md, then follow the onboarding flow:
- Greet the user warmly and introduce yourself as Jimmy
- Briefly explain what you can do (manage cron jobs, hire AI employees, connect to Slack, etc.)
- Check if ~/.openclaw/ exists and mention migration if so
- Ask the user what they'd like to set up first`

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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  const [sessionMeta, setSessionMeta] = useState<{ engine?: string; engineSessionId?: string; model?: string } | null>(null)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const { events } = useGateway()
  const searchParams = useSearchParams()
  const onboardingTriggered = useRef(false)

  // Close more menu on outside click
  useEffect(() => {
    if (!showMoreMenu) return
    function handleClick(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMoreMenu])

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
    setMessages([{
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Starting up for the first time...',
      timestamp: Date.now(),
    }])
    setLoading(true)

    api.createSession({
      source: 'web',
      prompt: ONBOARDING_PROMPT,
    }).then((session) => {
      const id = String((session as Record<string, unknown>).id)
      setSelectedId(id)
      setRefreshKey((k) => k + 1)
    }).catch((err) => {
      setLoading(false)
      setMessages([{
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Failed to start onboarding: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      }])
    })
  }

  // Listen for session events (tool calls + completion)
  useEffect(() => {
    if (events.length === 0) return
    const latest = events[events.length - 1]
    const payload = latest.payload as Record<string, unknown>

    const matchesSession = selectedId && payload.sessionId === selectedId
    const isOnboarding = !selectedId && onboardingTriggered.current
    if (!matchesSession && !isOnboarding) return

    if (latest.event === 'session:delta') {
      const deltaType = String(payload.type || 'text')

      if (deltaType === 'tool_use') {
        const toolName = String(payload.toolName || 'tool')
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `Using ${toolName}`,
            timestamp: Date.now(),
            toolCall: toolName,
          },
        ])
      } else if (deltaType === 'tool_result') {
        setMessages((prev) => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (last && last.role === 'assistant' && last.toolCall) {
            updated[updated.length - 1] = { ...last, content: `Used ${last.toolCall}` }
          }
          return updated
        })
      }
    }

    if (latest.event === 'session:completed') {
      if (isOnboarding && payload.sessionId) {
        setSelectedId(String(payload.sessionId))
      }
      setLoading(false)

      if (payload.result) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: String(payload.result),
            timestamp: Date.now(),
          },
        ])
      }
      if (payload.error && !payload.result) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `Error: ${payload.error}`,
            timestamp: Date.now(),
          },
        ])
      }
      setRefreshKey((k) => k + 1)
    }
  }, [events, selectedId])

  const loadSession = useCallback(async (id: string) => {
    try {
      const session = (await api.getSession(id)) as Record<string, unknown>
      setSessionMeta({
        engine: session.engine ? String(session.engine) : undefined,
        engineSessionId: session.engineSessionId ? String(session.engineSessionId) : undefined,
        model: session.model ? String(session.model) : undefined,
      })
      const history = session.messages || session.history || []
      if (Array.isArray(history)) {
        setMessages(
          history.map((m: Record<string, unknown>) => ({
            id: crypto.randomUUID(),
            role: (m.role as 'user' | 'assistant') || 'assistant',
            content: String(m.content || m.text || ''),
            timestamp: m.timestamp ? Number(m.timestamp) : Date.now(),
          }))
        )
      }
      if (session.status === 'running') {
        setLoading(true)
      }
    } catch {
      setMessages([])
      setSessionMeta(null)
    }
  }, [])

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id)
      setMessages([])
      setLoading(false)
      setMobileView('chat')
      loadSession(id)
    },
    [loadSession]
  )

  const handleNewChat = useCallback(() => {
    setSelectedId(null)
    setMessages([])
    setLoading(false)
    setSessionMeta(null)
    setMobileView('chat')
  }, [])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !onboardingTriggered.current && sessions.length > 0) {
        handleSelect(sessions[0].id)
      }
    },
    [selectedId, handleSelect]
  )

  const handleSend = useCallback(
    async (message: string, media?: MediaAttachment[]) => {
      const isOnboardingMsg = message === ONBOARDING_PROMPT
      if (!isOnboardingMsg) {
        const userMsg: Message = {
          id: crypto.randomUUID(),
          role: 'user',
          content: message,
          timestamp: Date.now(),
          media,
        }
        setMessages((prev) => [...prev, userMsg])
      }
      setLoading(true)

      try {
        let sessionId = selectedId

        if (!sessionId) {
          const session = (await api.createSession({
            source: 'web',
            prompt: message,
          })) as Record<string, unknown>
          sessionId = String(session.id)
          setSelectedId(sessionId)
          setRefreshKey((k) => k + 1)
        } else {
          await api.sendMessage(sessionId, { message })
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
    [selectedId]
  )

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
      <div style={{
        display: 'flex',
        height: '100%',
        overflow: 'hidden',
      }}>
        {/* Desktop sidebar — always visible on md+ */}
        <div className="hidden lg:block" style={{ width: 280, flexShrink: 0, height: '100%' }}>
          <ChatSidebar
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            refreshKey={refreshKey}
            onSessionsLoaded={handleSessionsLoaded}
          />
        </div>

        {/* Mobile: sidebar view */}
        <div
          className="lg:hidden"
          style={{
            width: '100%',
            height: '100%',
            display: mobileView === 'sidebar' ? 'block' : 'none',
          }}
        >
          <ChatSidebar
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            refreshKey={refreshKey}
            onSessionsLoaded={handleSessionsLoaded}
          />
        </div>

        {/* Chat area */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--bg)',
            minWidth: 0,
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
            {/* Mobile back button */}
            <button
              className="lg:hidden"
              onClick={() => setMobileView('sidebar')}
              aria-label="Back to sessions"
              style={{
                padding: 'var(--space-1) var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                marginRight: 'var(--space-2)',
                fontSize: 'var(--text-subheadline)',
                display: 'flex',
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

            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: 'var(--text-subheadline)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                letterSpacing: '-0.2px',
              }}>
                {selectedId ? `Session ${selectedId.slice(0, 8)}...` : 'New Chat'}
              </div>
            </div>

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
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Messages */}
          <ChatMessages messages={messages} loading={loading} />

          {/* Input */}
          <ChatInput
            disabled={loading}
            onSend={handleSend}
            onNewSession={handleNewChat}
            onStatusRequest={handleStatusRequest}
          />
        </div>
      </div>
    </PageLayout>
  )
}

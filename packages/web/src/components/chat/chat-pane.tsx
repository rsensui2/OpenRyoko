"use client"

import { useState, useCallback, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { ChatMessages } from '@/components/chat/chat-messages'
import { ChatInput } from '@/components/chat/chat-input'
import { QueuePanel } from '@/components/chat/queue-panel'
import { CliTranscript } from '@/components/chat/cli-transcript'
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
}: ChatPaneProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const streamingTextRef = useRef('')
  const [streamingText, setStreamingText] = useState('')
  const intermediateStartRef = useRef<number>(-1)
  const [currentSession, setCurrentSession] = useState<Record<string, unknown> | null>(null)
  const sessionIdRef = useRef(sessionId)
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
        onRefresh?.()
      }
    })
  }, [subscribe, persistIntermediate, onRefresh])

  // Load session data
  const loadSession = useCallback(async (id: string) => {
    try {
      const session = (await api.getSession(id)) as Record<string, unknown>
      setCurrentSession(session)
      const meta = {
        engine: session.engine ? String(session.engine) : undefined,
        engineSessionId: session.engineSessionId ? String(session.engineSessionId) : undefined,
        model: session.model ? String(session.model) : undefined,
        title: session.title ? String(session.title) : undefined,
        employee: session.employee ? String(session.employee) : undefined,
      }
      onSessionMetaChange?.(meta)

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
      setMessages([])
      setCurrentSession(null)
      intermediateStartRef.current = -1
    }
  }, [onSessionMetaChange])

  // Load on session change
  useEffect(() => {
    if (!sessionId) {
      setMessages([])
      setLoading(false)
      setCurrentSession(null)
      streamingTextRef.current = ''
      setStreamingText('')
      intermediateStartRef.current = -1
      return
    }
    loadSession(sessionId)
  }, [sessionId, loadSession])

  // Reload on reconnect
  useEffect(() => {
    if (!connectionSeq || !sessionId) return
    loadSession(sessionId)
  }, [connectionSeq, sessionId, loadSession])

  // Poll for completion while loading
  useEffect(() => {
    if (!sessionId || !loading) return
    const timer = setInterval(async () => {
      try {
        const session = (await api.getSession(sessionId)) as Record<string, unknown>
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
        let sid = sessionId

        // Handle stub session (onboarding)
        if (sid && isStubSession && getOnboardingPrompt) {
          onStubCleared?.()
          const onboardingPrompt = getOnboardingPrompt(message)
          await api.sendMessage(sid, { message: onboardingPrompt })
          onRefresh?.()
        } else if (!sid) {
          const session = (await api.createSession({
            source: 'web',
            prompt: message,
          })) as Record<string, unknown>
          sid = String(session.id)
          onSessionCreated?.(sid)
          onRefresh?.()
        } else {
          await api.sendMessage(sid, { message, interrupt: interrupt || undefined })
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
    [sessionId, isStubSession, getOnboardingPrompt, onStubCleared, onSessionCreated, onRefresh]
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
      const session = (await api.getSession(sessionId)) as Record<string, unknown>
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
  }, [sessionId])

  const handleNewSession = useCallback(() => {
    // This just clears the pane state — parent handles actual new session flow
    setMessages([])
    setLoading(false)
    setCurrentSession(null)
    streamingTextRef.current = ''
    setStreamingText('')
    intermediateStartRef.current = -1
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--bg)',
      }}
      onClick={onFocus}
    >
      {/* Messages / CLI transcript */}
      {viewMode === 'cli' && sessionId ? (
        <CliTranscript sessionId={sessionId} />
      ) : (
        <ChatMessages messages={messages} loading={loading} streamingText={streamingText} />
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
        />
      )}
    </div>
  )
}

"use client"
import React, { useState, useCallback, useEffect, useRef, useMemo, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { useGateway } from '@/hooks/use-gateway'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar, type SidebarOrder } from '@/components/chat/chat-sidebar'
import { ChatTabBar } from '@/components/chat/chat-tabs'
import { ChatPane } from '@/components/chat/chat-pane'
import { ShortcutOverlay } from '@/components/chat/shortcut-overlay'
import { ShortcutHint } from '@/components/chat/shortcut-hint'
import { useChatTabs } from '@/hooks/use-chat-tabs'
import { useKeyboardShortcuts, type ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { useDeleteSession } from '@/hooks/use-sessions'
import { clearIntermediateMessages } from '@/lib/conversations'
import { useSettings } from '@/app/settings-provider'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { Check, EllipsisVertical, Trash2 } from 'lucide-react'

function getOnboardingPrompt(portalName: string, userMessage: string) {
  return `This is your first time being activated. The user just set up ${portalName} and opened the web dashboard for the first time.

Read your CLAUDE.md instructions and the onboarding skill at ~/.jinn/skills/onboarding/SKILL.md, then follow the onboarding flow:
- Greet the user warmly and introduce yourself as ${portalName}
- Briefly explain what you can do (manage cron jobs, hire AI employees, connect to Slack, etc.)
- Ask the user what they'd like to set up first

The user said: "${userMessage}"`
}

class ChatErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ChatErrorBoundary]', error.message, '\nComponent stack:', info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <PageLayout>
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="text-lg font-semibold text-[var(--system-red)]">Chat crashed</p>
            <pre className="max-w-lg overflow-auto rounded-lg bg-[var(--bg-tertiary)] p-4 text-left text-xs text-muted-foreground">
              {this.state.error.message}{'\n'}{this.state.error.stack?.split('\n').slice(0, 5).join('\n')}
            </pre>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload() }}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
            >
              Reload
            </button>
          </div>
        </PageLayout>
      )
    }
    return this.props.children
  }
}

export default function ChatPageWrapper() {
  return (
    <ChatErrorBoundary>
      <Suspense fallback={
        <PageLayout>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Loading...
          </div>
        </PageLayout>
      }>
        <ChatPage />
      </Suspense>
    </ChatErrorBoundary>
  )
}

function ChatPage() {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? 'Jinn'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  const [sessionMeta, setSessionMeta] = useState<{ engine?: string; engineSessionId?: string; model?: string; title?: string; employee?: string } | null>(null)
  // Sibling sessions for the currently selected employee (empty if direct/single session)
  const [employeeSessions, setEmployeeSessions] = useState<Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>>([])
  // When true, user explicitly started a new chat — don't auto-select first session
  const newChatIntentRef = useRef(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('jinn-chat-sidebar-collapsed') === 'true'
    }
    return false
  })
  const toggleSidebar = useCallback(() => {
    // Mobile: toggle mobileView between sidebar and chat
    const isMobile = window.innerWidth < 1024
    if (isMobile) {
      setMobileView((prev) => (prev === 'sidebar' ? 'chat' : 'sidebar'))
    } else {
      setSidebarCollapsed((prev) => {
        const next = !prev
        localStorage.setItem('jinn-chat-sidebar-collapsed', String(next))
        return next
      })
    }
  }, [])
  const [viewMode, setViewMode] = useState<'chat' | 'cli'>('chat')
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [focusTrigger, setFocusTrigger] = useState(0)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const sessionPickerRef = useRef<HTMLDivElement>(null)
  const { events, connectionSeq, skillsVersion, subscribe } = useGateway()
  const chatTabs = useChatTabs()
  const searchParams = useSearchParams()
  const onboardingTriggered = useRef(false)
  // When set, the current session is a stub awaiting the user's first message
  const stubSessionRef = useRef(false)
  const deleteSessionMutation = useDeleteSession()
  const qc = useQueryClient()
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
  const sidebarOrderRef = useRef<SidebarOrder>({ sessionIds: [], employeeNames: [], employeeSessionMap: {} })
  const handleOrderComputed = useCallback((order: SidebarOrder) => { sidebarOrderRef.current = order }, [])


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
    api.createStubSession({
      greeting: `Hey! \u{1F44B} Say hi when you're ready to get started.`,
      title: 'Welcome',
    }).then((session) => {
      const id = String((session as Record<string, unknown>).id)
      stubSessionRef.current = true
      setSelectedId(id)
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    }).catch(() => {
      // Silently fail — user can still start a normal chat
    })
  }

  // Update tab label/status when session meta changes
  const { updateTabStatus } = chatTabs
  useEffect(() => {
    if (!selectedId || !sessionMeta) return
    updateTabStatus(selectedId, {
      label: sessionMeta.title || sessionMeta.employee || portalName,
      employeeName: sessionMeta.employee || undefined,
    })
  }, [selectedId, sessionMeta, portalName, updateTabStatus])

  const handleEmployeeSessionsAvailable = useCallback(
    (sessions: Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>) => {
      setEmployeeSessions(sessions.length > 1 ? sessions : [])
    },
    []
  )

  const handleSelect = useCallback(
    (id: string) => {
      newChatIntentRef.current = false
      stubSessionRef.current = false
      setSelectedId(id)
      setMobileView('chat')
      setViewMode('chat')
      // Open a tab — label will be updated once session meta loads
      chatTabs.openTab({ sessionId: id, label: 'Loading...', status: 'idle', unread: false })
    },
    [chatTabs]
  )

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true
    setSelectedId(null)
    setSessionMeta(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
    setFocusTrigger(prev => prev + 1)
  }, [chatTabs])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !onboardingTriggered.current && !newChatIntentRef.current && sessions.length > 0) {
        handleSelect(sessions[0].id)
      }
    },
    [selectedId, handleSelect]
  )

  const handleDeleteSession = useCallback((id: string) => {
    // Session already deleted by sidebar mutation — just clear local state
    if (selectedId === id) {
      setSelectedId(null)
      setSessionMeta(null)
    }
    clearIntermediateMessages(id)
    chatTabs.closeTab(chatTabs.tabs.findIndex(t => t.sessionId === id))
    setConfirmDelete(false)
    setShowMoreMenu(false)
  }, [selectedId, chatTabs])

  // ChatPane callbacks
  const handleSessionCreated = useCallback((newId: string) => {
    setSelectedId(newId)
    chatTabs.openTab({ sessionId: newId, label: 'New Chat', status: 'running', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])

  const handleSessionMetaChange = useCallback((meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => {
    setSessionMeta(meta)
  }, [])

  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [qc])

  const handleGetOnboardingPrompt = useCallback((message: string) => {
    return getOnboardingPrompt(portalName, message)
  }, [portalName])

  const handleStubCleared = useCallback(() => {
    stubSessionRef.current = false
  }, [])

  // Navigation helpers for keyboard shortcuts
  const navigateSession = useCallback((direction: 1 | -1) => {
    const { sessionIds } = sidebarOrderRef.current
    if (sessionIds.length === 0) return
    if (!selectedId) {
      handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
      return
    }
    const idx = sessionIds.indexOf(selectedId)
    if (idx === -1) {
      handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
      return
    }
    const next = (idx + direction + sessionIds.length) % sessionIds.length
    handleSelect(sessionIds[next])
  }, [selectedId, handleSelect])

  const cycleEmployee = useCallback(() => {
    const { employeeNames, employeeSessionMap } = sidebarOrderRef.current
    if (employeeNames.length === 0) return
    const currentEmployee = sessionMeta?.employee ?? null
    const currentIdx = currentEmployee ? employeeNames.indexOf(currentEmployee) : -1
    const nextIdx = (currentIdx + 1) % employeeNames.length
    const nextEmployee = employeeNames[nextIdx]
    const firstSession = employeeSessionMap[nextEmployee]?.[0]
    if (firstSession) handleSelect(firstSession)
  }, [sessionMeta, handleSelect])

  const copyChat = useCallback(async () => {
    if (!selectedId) return
    try {
      const session = await api.getSession(selectedId) as { messages?: Array<{ role: string; content: string }> }
      const messages = session.messages ?? []
      const text = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n\n')
      await navigator.clipboard.writeText(text)
      setCopiedField('chat')
      setTimeout(() => setCopiedField(null), 1500)
    } catch { /* silently fail */ }
  }, [selectedId])

  // Centralized keyboard shortcut registry
  const shortcuts = useMemo<ShortcutDef[]>(() => [
    { key: 'n', category: 'Actions', description: 'New chat', action: handleNewChat },
    { key: 'j', category: 'Navigation', description: 'Next session', action: () => navigateSession(1) },
    { key: 'k', category: 'Navigation', description: 'Previous session', action: () => navigateSession(-1) },
    { key: 'e', category: 'Navigation', description: 'Next employee', action: cycleEmployee },
    { key: 'Backspace', category: 'Actions', description: 'Delete session', action: () => setConfirmDelete(true), enabled: !!selectedId },
    { key: 'Delete', category: 'Actions', description: 'Delete session', action: () => setConfirmDelete(true), enabled: !!selectedId },
    { key: 'c', category: 'Actions', description: 'Copy chat', action: copyChat, enabled: !!selectedId },
    { key: 'Escape', category: 'Navigation', description: 'Close overlay', action: () => {
      if (showShortcutOverlay) setShowShortcutOverlay(false)
      else if (showMoreMenu) setShowMoreMenu(false)
    }},
    { key: '/', category: 'Actions', description: 'Search', action: () => {
      const el = document.getElementById('chat-search')
      if (el) el.focus()
    }},
    { key: '?', category: 'Help', description: 'Keyboard shortcuts', action: () => setShowShortcutOverlay(v => !v) },
    { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action: () => {
      if (chatTabs.activeIndex >= 0) chatTabs.closeTab(chatTabs.activeIndex)
    }},
    { key: '[', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Previous tab', action: () => chatTabs.prevTab() },
    { key: ']', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Next tab', action: () => chatTabs.nextTab() },
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      modifiers: ['meta' as const, 'alt' as const],
      category: 'Navigation' as const,
      description: `Tab ${i + 1}`,
      action: () => chatTabs.switchTab(i),
    })),
  ], [handleNewChat, navigateSession, cycleEmployee, copyChat, selectedId, showShortcutOverlay, showMoreMenu, chatTabs])

  useKeyboardShortcuts(shortcuts, { isModalOpen: confirmDelete })

  // When active tab changes, sync selectedId
  useEffect(() => {
    if (chatTabs.activeTab && chatTabs.activeTab.sessionId !== selectedId) {
      setSelectedId(chatTabs.activeTab.sessionId)
      setViewMode('chat')
      return
    }

    if (!chatTabs.activeTab && selectedId && !newChatIntentRef.current) {
      setSelectedId(null)
      setSessionMeta(null)
      setEmployeeSessions([])
    }
  }, [chatTabs.activeTab, selectedId])

  // More menu (shared between desktop tab bar and mobile header)
  const moreMenu = selectedId ? (
    <div ref={moreMenuRef} className="relative">
      <button
        onClick={() => setShowMoreMenu((v) => !v)}
        aria-label="More options"
        className="flex items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <EllipsisVertical className="size-[18px]" />
      </button>

      {showMoreMenu && (
        <div className="absolute right-0 top-full z-[200] mt-1 min-w-[220px] overflow-hidden rounded-[var(--radius-md)] border border-border bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-xl">
          <button
            onClick={() => copyToClipboard(selectedId, 'id')}
            className="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            Copy Session ID
          </button>
          {sessionMeta?.engineSessionId && (
            <button
              onClick={() => {
                const cli = sessionMeta.engine === 'codex' ? 'codex' : 'claude'
                copyToClipboard(`${cli} --resume ${sessionMeta.engineSessionId}`, 'cli')
              }}
              className="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              Copy CLI Resume Command
            </button>
          )}
          <div className="my-0.5 border-t border-border" />
          <button
            onClick={() => { setShowMoreMenu(false); setConfirmDelete(true) }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--system-red)] transition-colors hover:bg-accent"
          >
            <Trash2 className="size-3.5" />
            <span className="flex-1">Delete Session</span>
            <kbd className="font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
          </button>
        </div>
      )}
    </div>
  ) : null

  // Build toolbar actions to pass into tab bar (desktop only content)
  const toolbarActions = (
    <>
      {selectedId && (
        <div className="flex items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5">
          <button
            onClick={() => setViewMode('chat')}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] font-medium transition-all",
              viewMode === 'chat'
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Chat
          </button>
          <button
            onClick={() => setViewMode('cli')}
            className={cn(
              "rounded-full px-2.5 py-1 font-mono text-[11px] font-medium transition-all",
              viewMode === 'cli'
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            CLI
          </button>
        </div>
      )}

      <div className="hidden lg:block">{moreMenu}</div>

      {copiedField && (
        <div className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-[var(--accent)]">
          <Check className="size-3" />
          Copied!
        </div>
      )}
    </>
  )

  return (
    <PageLayout mobileHeaderActions={moreMenu}>
      <div className="flex overflow-hidden h-full">
        <div
          className="hidden h-full shrink-0 overflow-hidden lg:block"
          style={{
            width: sidebarCollapsed ? 0 : 280,
            transition: 'width 200ms ease-in-out',
          }}
        >
          <div className="h-full w-[280px]">
            <ChatSidebar
              selectedId={selectedId}
              onSelect={handleSelect}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              onSessionsLoaded={handleSessionsLoaded}
              onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
              onOrderComputed={handleOrderComputed}
            />
          </div>
        </div>

        <div className="min-w-0 flex-1 flex-col overflow-hidden bg-background flex">
          <ChatTabBar
            tabs={chatTabs.tabs}
            activeIndex={chatTabs.activeIndex}
            onSwitch={chatTabs.switchTab}
            onClose={chatTabs.closeTab}
            onNew={handleNewChat}
            onPin={chatTabs.pinTab}
            onMove={chatTabs.moveTab}
            toolbarActions={toolbarActions}
            sidebarCollapsed={mobileView === 'chat' || sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
          />

          <div
            className={mobileView === 'sidebar' ? 'flex-1 overflow-hidden lg:hidden' : 'hidden'}
          >
            <ChatSidebar
              selectedId={selectedId}
              onSelect={handleSelect}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              onSessionsLoaded={handleSessionsLoaded}
              onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
              onOrderComputed={handleOrderComputed}
            />
          </div>

          <div className={cn(
            "flex-1 overflow-hidden flex flex-col",
            mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'
          )}>
            <ChatPane
              sessionId={selectedId}
              isActive={true}
              onFocus={() => {}}
              onSessionCreated={handleSessionCreated}
              onSessionMetaChange={handleSessionMetaChange}
              onRefresh={handleRefresh}
              portalName={portalName}
              subscribe={subscribe}
              connectionSeq={connectionSeq}
              skillsVersion={skillsVersion}
              events={events}
              viewMode={viewMode}
              getOnboardingPrompt={stubSessionRef.current ? handleGetOnboardingPrompt : undefined}
              isStubSession={stubSessionRef.current}
              onStubCleared={handleStubCleared}
              focusTrigger={focusTrigger}
            />
          </div>
        </div>
      </div>

      {!showShortcutOverlay && (
        <ShortcutHint onClick={() => setShowShortcutOverlay(true)} />
      )}

      {showShortcutOverlay && (
        <ShortcutOverlay
          shortcuts={shortcuts}
          onClose={() => setShowShortcutOverlay(false)}
        />
      )}

      <Dialog open={confirmDelete && !!selectedId} onOpenChange={setConfirmDelete}>
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Session?</DialogTitle>
            <DialogDescription>
              This will permanently delete the session and all its messages.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => selectedId && handleDeleteSession(selectedId)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  )
}

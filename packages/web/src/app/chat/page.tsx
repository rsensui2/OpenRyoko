"use client"
import { useState, useCallback, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { useGateway } from '@/hooks/use-gateway'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { ChatTabBar } from '@/components/chat/chat-tabs'
import { ChatPane } from '@/components/chat/chat-pane'
import { useChatTabs } from '@/hooks/use-chat-tabs'
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
import { ChevronLeft, Check, EllipsisVertical, Trash2 } from 'lucide-react'

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
        <div className="flex h-full items-center justify-center text-muted-foreground">
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
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  const [sessionMeta, setSessionMeta] = useState<{ engine?: string; engineSessionId?: string; model?: string; title?: string; employee?: string } | null>(null)
  // Sibling sessions for the currently selected employee (empty if direct/single session)
  const [employeeSessions, setEmployeeSessions] = useState<Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>>([])
  // When true, user explicitly started a new chat — don't auto-select first session
  const newChatIntentRef = useRef(false)
  const [viewMode, setViewMode] = useState<'chat' | 'cli'>('chat')
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
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
  useEffect(() => {
    if (!selectedId || !sessionMeta) return
    chatTabs.updateTabStatus(selectedId, {
      label: sessionMeta.title || sessionMeta.employee || portalName,
    })
  }, [selectedId, sessionMeta, portalName, chatTabs])

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
  }, [chatTabs])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !onboardingTriggered.current && !newChatIntentRef.current && sessions.length > 0) {
        handleSelect(sessions[0].id)
      }
    },
    [selectedId, handleSelect]
  )

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await deleteSessionMutation.mutateAsync(id)
      if (selectedId === id) {
        setSelectedId(null)
        setSessionMeta(null)
      }
      clearIntermediateMessages(id)
    } catch { /* ignore */ }
    setConfirmDelete(false)
    setShowMoreMenu(false)
  }, [selectedId, deleteSessionMutation])

  // ChatPane callbacks
  const handleSessionCreated = useCallback((newId: string) => {
    setSelectedId(newId)
    chatTabs.openTab({ sessionId: newId, label: 'New Chat', status: 'running', unread: false })
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

  // Tab keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === 'w') {
        e.preventDefault()
        if (chatTabs.activeIndex >= 0) chatTabs.closeTab(chatTabs.activeIndex)
      }
      if (e.metaKey && e.shiftKey && e.key === '[') {
        e.preventDefault()
        chatTabs.prevTab()
      }
      if (e.metaKey && e.shiftKey && e.key === ']') {
        e.preventDefault()
        chatTabs.nextTab()
      }
      if (e.metaKey && e.altKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        chatTabs.switchTab(parseInt(e.key) - 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chatTabs])

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
            Delete Session
          </button>
        </div>
      )}
    </div>
  ) : null

  // Build toolbar actions to pass into tab bar (desktop only content)
  const toolbarActions = (
    <>
      <button
        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-accent lg:hidden"
        onClick={() => setMobileView('sidebar')}
        aria-label="Back to sessions"
      >
        <ChevronLeft className="size-4" />
        Back
      </button>

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
      <div className="flex h-[calc(100%-48px)] overflow-hidden lg:h-full">
        <div className="hidden h-full w-[280px] shrink-0 lg:block">
          <ChatSidebar
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            onDelete={handleDeleteSession}
            onSessionsLoaded={handleSessionsLoaded}
            onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
          />
        </div>

        <div
          className={mobileView === 'sidebar' ? 'block lg:hidden' : 'hidden'}
          style={{ width: '100%', height: '100%' }}
        >
          <ChatSidebar
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            onDelete={handleDeleteSession}
            onSessionsLoaded={handleSessionsLoaded}
            onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
          />
        </div>

        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden bg-background",
            mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'
          )}
        >
          <ChatTabBar
            tabs={chatTabs.tabs}
            activeIndex={chatTabs.activeIndex}
            onSwitch={chatTabs.switchTab}
            onClose={chatTabs.closeTab}
            onNew={handleNewChat}
            toolbarActions={toolbarActions}
          />

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
          />
        </div>
      </div>

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

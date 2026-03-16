"use client"
import { useEffect, useState, useRef, useCallback } from 'react'
import { api, type Employee } from '@/lib/api'
import { useSettings } from '@/app/settings-provider'

interface Session {
  id: string
  connector?: string | null
  employee?: string
  title?: string
  status?: string
  source?: string
  sourceRef?: string
  sessionKey?: string
  transportState?: string
  queueDepth?: number
  lastActivity?: string
  createdAt?: string
  [key: string]: unknown
}

interface ChatSidebarProps {
  selectedId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete?: (id: string) => void
  refreshKey: number
  connectionSeq?: number
  onSessionsLoaded?: (sessions: Session[]) => void
  events?: Array<{ event: string; payload: unknown }>
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
}

// A flat list item: either an employee contact or a direct session
interface FlatItem {
  type: 'employee' | 'direct'
  // For employee type
  employeeName?: string
  employeeData?: Employee
  sessions?: Session[] // all sessions for this employee, sorted by activity
  // For direct type
  session?: Session
  // Common
  sortKey: string // for overall sort (most recent activity)
  pinKey: string  // the key stored in pinned set
}

const COLLAPSE_STORAGE_KEY = 'jinn-sidebar-collapsed'
const PINNED_STORAGE_KEY = 'jinn-pinned-sessions'

function formatTime(dateStr?: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return 'now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
  if (diff < 86400000) return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getReadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem('jinn-read-sessions')
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

function markSessionRead(id: string) {
  const read = getReadSessions()
  read.add(id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem('jinn-read-sessions', JSON.stringify(arr))
}

function getPinnedSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

function savePinnedSessions(pinned: Set<string>) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(pinned)))
  } catch { /* ignore */ }
}

function loadCollapsedState(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

function saveCollapsedState(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsed)))
  } catch { /* ignore */ }
}

function isCronSession(session: Session): boolean {
  return session.source === 'cron' || (session.sourceRef || '').startsWith('cron:')
}

function isDirectSession(session: Session, portalSlug: string): boolean {
  return !isCronSession(session) && (!session.employee || session.employee === portalSlug)
}

function getSessionActivity(session: Session): string {
  return session.lastActivity || session.createdAt || ''
}

function sortSessionsByActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => getSessionActivity(b).localeCompare(getSessionActivity(a)))
}

export function ChatSidebar({
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
  refreshKey,
  connectionSeq,
  onSessionsLoaded,
  events,
  onEmployeeSessionsAvailable,
}: ChatSidebarProps) {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? 'Jinn'
  const portalSlug = portalName.toLowerCase()

  // Replace stale "Jinn" prefix in stored session titles with the current portal name
  const fixTitle = (title: string | undefined, employee: string | undefined) => {
    if (!title) return employee || portalName
    if (portalName !== 'Jinn' && title.startsWith('Jinn - ')) {
      return portalName + title.slice(4)
    }
    return title
  }

  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [confirmDeleteEmployee, setConfirmDeleteEmployee] = useState<{ name: string; displayName: string; sessions: Session[] } | null>(null)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [readSessions, setReadSessions] = useState<Set<string>>(new Set())
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [employeeData, setEmployeeData] = useState<Map<string, Employee>>(new Map())
  const lastEventKey = useRef<string | null>(null)

  // Load persisted state from localStorage + fetch employee data
  useEffect(() => {
    setReadSessions(getReadSessions())
    setPinnedSessions(getPinnedSessions())
    setCollapsed(loadCollapsedState())

    // Fetch org to build employee name → Employee data map
    api.getOrg().then(async (org) => {
      const dataMap = new Map<string, Employee>()
      await Promise.all(
        org.employees.map(async (name) => {
          try {
            const emp = await api.getEmployee(name)
            dataMap.set(name, emp)
          } catch { /* ignore */ }
        })
      )
      setEmployeeData(dataMap)
    }).catch(() => {})
  }, [])

  // Mark selected session as read
  useEffect(() => {
    if (selectedId) {
      markSessionRead(selectedId)
      setReadSessions(prev => {
        const next = new Set(prev)
        next.add(selectedId)
        return next
      })
    }
  }, [selectedId])

  // Fetch sessions
  const fetchSessions = useCallback(() => {
    api
      .getSessions()
      .then((data) => {
        const filtered = (data as Session[]).filter(
          (s) => s.source === 'web' || s.source === 'cron' || s.source === 'whatsapp' || s.source === 'discord' || !s.source
        )
        filtered.sort((a, b) => {
          const ta = a.lastActivity || a.createdAt || ''
          const tb = b.lastActivity || b.createdAt || ''
          return tb.localeCompare(ta)
        })
        setSessions(filtered)
        onSessionsLoaded?.(filtered)
      })
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [onSessionsLoaded])

  // Initial load + refreshKey changes
  useEffect(() => {
    setLoading(true)
    fetchSessions()
  }, [refreshKey, fetchSessions])

  useEffect(() => {
    if (!connectionSeq) return
    fetchSessions()
  }, [connectionSeq, fetchSessions])

  // Auto-refresh sidebar on relevant WS events
  useEffect(() => {
    if (!events || events.length === 0) return
    const latest = events[events.length - 1]
    const eventKey = `${latest.event}:${JSON.stringify(latest.payload)}`
    if (eventKey === lastEventKey.current) return
    lastEventKey.current = eventKey

    const shouldRefresh =
      latest.event === 'session:started' ||
      latest.event === 'session:completed' ||
      latest.event === 'session:deleted' ||
      latest.event === 'session:error'
    if (shouldRefresh) {
      fetchSessions()
    }
  }, [events, fetchSessions])

  const toggleCronCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has('cron')) {
        next.delete('cron')
      } else {
        next.add('cron')
      }
      saveCollapsedState(next)
      return next
    })
  }, [])

  const togglePin = useCallback((pinKey: string) => {
    setPinnedSessions(prev => {
      const next = new Set(prev)
      if (next.has(pinKey)) {
        next.delete(pinKey)
      } else {
        next.add(pinKey)
      }
      savePinnedSessions(next)
      return next
    })
  }, [])

  async function handleDeleteEmployee(empName: string, empSessions: Session[]) {
    const ids = empSessions.map(s => s.id)
    try {
      await api.bulkDeleteSessions(ids)
      setSessions(prev => prev.filter(s => !ids.includes(s.id)))
      setPinnedSessions(prev => {
        const next = new Set(prev)
        next.delete(`emp:${empName}`)
        for (const id of ids) next.delete(id)
        savePinnedSessions(next)
        return next
      })
      if (selectedId && ids.includes(selectedId)) onNewChat()
    } catch { /* ignore */ }
    setConfirmDeleteEmployee(null)
  }

  async function handleDelete(sessionId: string) {
    try {
      await api.deleteSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      setPinnedSessions(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        savePinnedSessions(next)
        return next
      })
      if (onDelete) onDelete(sessionId)
      else if (selectedId === sessionId) onNewChat()
    } catch { /* ignore */ }
    setConfirmDelete(null)
  }

  // Build the displayed sessions list (search filtered)
  const displayed = search.trim()
    ? sessions.filter((s) => {
        const q = search.toLowerCase()
        const empData = s.employee ? employeeData.get(s.employee) : undefined
        return (
          s.id.toLowerCase().includes(q) ||
          (s.employee && s.employee.toLowerCase().includes(q)) ||
          (empData?.displayName && empData.displayName.toLowerCase().includes(q)) ||
          (s.title && s.title.toLowerCase().includes(q))
        )
      })
    : sessions

  // Partition into cron, direct, and employee sessions
  const cronSessions: Session[] = []
  const directSessions: Session[] = []
  const employeeSessionMap = new Map<string, Session[]>()

  for (const s of displayed) {
    if (isCronSession(s)) {
      cronSessions.push(s)
    } else if (isDirectSession(s, portalSlug)) {
      directSessions.push(s)
    } else {
      const emp = s.employee!
      if (!employeeSessionMap.has(emp)) employeeSessionMap.set(emp, [])
      employeeSessionMap.get(emp)!.push(s)
    }
  }

  // Build flat items list (employee entries + direct sessions, mixed and sorted)
  const flatItems: FlatItem[] = []

  // Employee entries — one per employee
  for (const [empName, empSessions] of employeeSessionMap) {
    const sorted = sortSessionsByActivity(empSessions)
    const latestSession = sorted[0]
    flatItems.push({
      type: 'employee',
      employeeName: empName,
      employeeData: employeeData.get(empName),
      sessions: sorted,
      sortKey: getSessionActivity(latestSession),
      pinKey: `emp:${empName}`,
    })
  }

  // Direct sessions — grouped into a single entry (like employees)
  if (directSessions.length > 0) {
    const sorted = sortSessionsByActivity(directSessions)
    flatItems.push({
      type: 'employee',
      employeeName: portalSlug,
      employeeData: { name: portalSlug, displayName: portalName, emoji: '💬', department: 'direct', role: '', rank: 'manager', engine: '', model: '', persona: '' } as Employee,
      sessions: sorted,
      sortKey: getSessionActivity(sorted[0]),
      pinKey: `emp:${portalSlug}`,
    })
  }

  // Sort: pinned float to top, then by most recent activity
  const pinnedFlat = flatItems.filter(item => pinnedSessions.has(item.pinKey))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  const unpinnedFlat = flatItems.filter(item => !pinnedSessions.has(item.pinKey))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  const sortedFlatItems = [...pinnedFlat, ...unpinnedFlat]

  const cronCollapsed = collapsed.has('cron')
  const sortedCron = sortSessionsByActivity(cronSessions)

  // Compute status dot colour for a session
  function getStatusDotColor(session: Session, readSet: Set<string>): string {
    if (session.status === 'running') return 'var(--system-blue)'
    if (session.status === 'error') return 'var(--system-red)'
    if (readSet.has(session.id)) return 'var(--text-quaternary)'
    return 'var(--system-green)'
  }

  // Compute status dot for an employee entry (based on most recent session)
  function getEmployeeStatusDot(empSessions: Session[], readSet: Set<string>): { color: string; pulse: boolean } {
    const latest = empSessions[0]
    if (!latest) return { color: 'var(--text-quaternary)', pulse: false }
    const color = getStatusDotColor(latest, readSet)
    const pulse = latest.status === 'running'
    return { color, pulse }
  }

  // Check if any of an employee's sessions is currently selected
  function isEmployeeActive(empSessions: Session[]): boolean {
    return empSessions.some(s => s.id === selectedId)
  }

  // Handle clicking an employee entry: select latest session + notify page of sibling sessions
  function handleEmployeeClick(item: FlatItem) {
    const empSessions = item.sessions!
    const latestSession = empSessions[0]
    onSelect(latestSession.id)
    onEmployeeSessionsAvailable?.(empSessions)
  }

  // Handle clicking a direct session
  function handleDirectClick(session: Session) {
    onSelect(session.id)
    onEmployeeSessionsAvailable?.([session])
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--sidebar-bg)',
      borderRight: '1px solid var(--separator)',
    }}>
      {/* Header */}
      <div style={{
        padding: 'var(--space-4) var(--space-4) var(--space-3)',
        borderBottom: '1px solid var(--separator)',
        background: 'var(--material-thick)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-3)',
        }}>
          <h2 style={{
            fontSize: 'var(--text-title3)',
            fontWeight: 'var(--weight-bold)',
            letterSpacing: '-0.5px',
            color: 'var(--text-primary)',
            margin: 0,
          }}>
            Chats
          </h2>
          <button
            onClick={onNewChat}
            aria-label="New chat"
            style={{
              padding: 'var(--space-1) var(--space-3)',
              fontSize: 'var(--text-footnote)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--accent-contrast)',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New
          </button>
        </div>

        {/* Search */}
        <div style={{
          background: 'var(--fill-tertiary)',
          borderRadius: 'var(--radius-md)',
          padding: '7px var(--space-3)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
        }}>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0 }}
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats..."
            aria-label="Search chats"
            style={{
              flex: 1,
              fontSize: 'var(--text-footnote)',
              color: 'var(--text-primary)',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              padding: 0,
              margin: 0,
              lineHeight: 1.4,
            }}
          />
          {search.trim() && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              style={{
                padding: 2,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-tertiary)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-1) 0' }}>
        {loading ? (
          <div style={{ padding: 'var(--space-8) var(--space-4)', textAlign: 'center' }}>
            <span style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-quaternary)' }}>
              Loading sessions...
            </span>
          </div>
        ) : sortedFlatItems.length === 0 && cronSessions.length === 0 ? (
          <div style={{ padding: 'var(--space-8) var(--space-4)', textAlign: 'center' }}>
            <span style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-quaternary)' }}>
              {search.trim() ? 'No matching chats' : 'No conversations yet'}
            </span>
          </div>
        ) : (
          <>
            {/* Flat contact list: employee entries + direct sessions mixed */}
            {sortedFlatItems.map((item) => {
              if (item.type === 'employee') {
                const empName = item.employeeName!
                const empSessions = item.sessions!
                const latestSession = empSessions[0]
                const empInfo = item.employeeData
                const displayName = empInfo?.displayName || empName
                const emoji = empInfo?.emoji || '🤖'
                const department = empInfo?.department || ''
                const timeLabel = formatTime(getSessionActivity(latestSession))
                const { color: dotColor, pulse } = getEmployeeStatusDot(empSessions, readSessions)
                const isActive = isEmployeeActive(empSessions)
                const isPinned = pinnedSessions.has(item.pinKey)
                const isHovered = hoveredKey === item.pinKey
                const sessionCount = empSessions.length
                // Unread: any session in this employee group is unread
                const hasUnread = empSessions.some(s => !readSessions.has(s.id) && s.status !== 'running' && s.status !== 'error')

                return (
                  <button
                    key={item.pinKey}
                    onClick={() => handleEmployeeClick(item)}
                    onMouseEnter={() => setHoveredKey(item.pinKey)}
                    onMouseLeave={() => setHoveredKey(null)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-3) var(--space-4)',
                      background: isActive ? 'var(--fill-secondary)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                      position: 'relative',
                    }}
                  >
                    {/* Emoji avatar */}
                    <div style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: 'var(--fill-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 18,
                      flexShrink: 0,
                      position: 'relative',
                    }}>
                      {emoji}
                      {/* Status dot on avatar */}
                      <div style={{
                        position: 'absolute',
                        bottom: 0,
                        right: 0,
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: dotColor,
                        border: '2px solid var(--sidebar-bg)',
                        animation: pulse ? 'sidebar-pulse 2s ease-in-out infinite' : 'none',
                        boxShadow: pulse ? `0 0 5px ${dotColor}` : 'none',
                      }} />
                    </div>

                    {/* Text content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        marginBottom: 2,
                      }}>
                        <span style={{
                          fontSize: 'var(--text-footnote)',
                          fontWeight: hasUnread || isActive ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                          color: 'var(--text-primary)',
                          letterSpacing: '-0.2px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        }}>
                          {displayName}
                        </span>
                        <span style={{
                          fontSize: 'var(--text-caption2)',
                          color: 'var(--text-tertiary)',
                          flexShrink: 0,
                          marginLeft: 'var(--space-1)',
                        }}>
                          {timeLabel}
                        </span>
                      </div>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-1)',
                        fontSize: 'var(--text-caption1)',
                        color: 'var(--text-tertiary)',
                        overflow: 'hidden',
                      }}>
                        {department && (
                          <span style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                            minWidth: 0,
                          }}>
                            {department}
                          </span>
                        )}
                        {sessionCount > 1 && (
                          <span style={{
                            flexShrink: 0,
                            background: 'var(--fill-tertiary)',
                            borderRadius: 'var(--radius-sm)',
                            padding: '0 5px',
                            lineHeight: '16px',
                            fontSize: 'var(--text-caption2)',
                            whiteSpace: 'nowrap',
                          }}>
                            {sessionCount} chats
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Pin indicator (when not hovered) */}
                    {isPinned && !isHovered && (
                      <span style={{ fontSize: 11, flexShrink: 0, opacity: 0.5 }}>📌</span>
                    )}

                    {/* Action buttons on hover */}
                    {isHovered && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); togglePin(item.pinKey) }}
                          aria-label={isPinned ? 'Unpin' : 'Pin'}
                          style={{
                            padding: 4,
                            borderRadius: 'var(--radius-sm)',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: isPinned ? 'var(--accent)' : 'var(--text-tertiary)',
                            display: 'flex',
                            alignItems: 'center',
                            flexShrink: 0,
                            transition: 'color 150ms ease',
                          }}
                          onMouseEnter={(e) => { if (!isPinned) e.currentTarget.style.color = 'var(--accent)' }}
                          onMouseLeave={(e) => { if (!isPinned) e.currentTarget.style.color = 'var(--text-tertiary)' }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 17v5" />
                            <path d="M9 2h6l-1 7h4l-2 4H8l-2-4h4L9 2z" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            const empInfo = item.employeeData
                            setConfirmDeleteEmployee({
                              name: empName,
                              displayName: empInfo?.displayName || empName,
                              sessions: empSessions,
                            })
                          }}
                          aria-label={`Delete all chats with ${displayName}`}
                          style={{
                            padding: 4,
                            borderRadius: 'var(--radius-sm)',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: 'var(--text-tertiary)',
                            display: 'flex',
                            alignItems: 'center',
                            flexShrink: 0,
                            transition: 'color 150ms ease',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--system-red)')}
                          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </>
                    )}
                  </button>
                )
              }

              // Direct session entry
              const session = item.session!
              const isActive = session.id === selectedId
              const isHovered = hoveredKey === item.pinKey
              const isRunning = session.status === 'running'
              const isRead = readSessions.has(session.id)
              const isError = session.status === 'error'
              const isPinned = pinnedSessions.has(item.pinKey)
              const timeLabel = formatTime(getSessionActivity(session))

              let dotColor: string
              if (isRunning) dotColor = 'var(--system-blue)'
              else if (isError) dotColor = 'var(--system-red)'
              else if (isRead) dotColor = 'var(--text-quaternary)'
              else dotColor = 'var(--system-green)'

              return (
                <button
                  key={item.pinKey}
                  onClick={() => handleDirectClick(session)}
                  onMouseEnter={() => setHoveredKey(item.pinKey)}
                  onMouseLeave={() => setHoveredKey(null)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3) var(--space-4)',
                    background: isActive ? 'var(--fill-secondary)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                    position: 'relative',
                  }}
                >
                  {/* Emoji avatar for direct session */}
                  <div style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    background: 'var(--fill-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 18,
                    flexShrink: 0,
                    position: 'relative',
                  }}>
                    💬
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      right: 0,
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: dotColor,
                      border: '2px solid var(--sidebar-bg)',
                      animation: isRunning ? 'sidebar-pulse 2s ease-in-out infinite' : 'none',
                      boxShadow: isRunning ? `0 0 5px ${dotColor}` : 'none',
                    }} />
                  </div>

                  {/* Text content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      marginBottom: 2,
                    }}>
                      <span style={{
                        fontSize: 'var(--text-footnote)',
                        fontWeight: isRead && !isActive ? 'var(--weight-medium)' : 'var(--weight-semibold)',
                        color: 'var(--text-primary)',
                        letterSpacing: '-0.2px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        minWidth: 0,
                      }}>
                        {fixTitle(session.title, session.employee)}
                      </span>
                      <span style={{
                        fontSize: 'var(--text-caption2)',
                        color: 'var(--text-tertiary)',
                        flexShrink: 0,
                        marginLeft: 'var(--space-1)',
                      }}>
                        {timeLabel}
                      </span>
                    </div>
                    <div style={{
                      fontSize: 'var(--text-caption1)',
                      color: 'var(--text-tertiary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {portalName}
                    </div>
                  </div>

                  {/* Pin indicator (when not hovered) */}
                  {isPinned && !isHovered && (
                    <span style={{ fontSize: 11, flexShrink: 0, opacity: 0.5 }}>📌</span>
                  )}

                  {/* Action buttons on hover */}
                  {isHovered && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); togglePin(item.pinKey) }}
                        aria-label={isPinned ? 'Unpin session' : 'Pin session'}
                        style={{
                          padding: 4,
                          borderRadius: 'var(--radius-sm)',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          color: isPinned ? 'var(--accent)' : 'var(--text-tertiary)',
                          display: 'flex',
                          alignItems: 'center',
                          flexShrink: 0,
                          transition: 'color 150ms ease',
                        }}
                        onMouseEnter={(e) => { if (!isPinned) e.currentTarget.style.color = 'var(--accent)' }}
                        onMouseLeave={(e) => { if (!isPinned) e.currentTarget.style.color = 'var(--text-tertiary)' }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 17v5" />
                          <path d="M9 2h6l-1 7h4l-2 4H8l-2-4h4L9 2z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(session.id) }}
                        aria-label="Delete session"
                        style={{
                          padding: 4,
                          borderRadius: 'var(--radius-sm)',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--text-tertiary)',
                          display: 'flex',
                          alignItems: 'center',
                          flexShrink: 0,
                          transition: 'color 150ms ease',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--system-red)')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </>
                  )}
                </button>
              )
            })}

            {/* Cron section — collapsible, always at bottom */}
            {cronSessions.length > 0 && (
              <div style={{ marginTop: sortedFlatItems.length > 0 ? 'var(--space-2)' : 0 }}>
                {/* Cron group header */}
                <div
                  onMouseEnter={() => setHoveredKey('cron-header')}
                  onMouseLeave={() => setHoveredKey(null)}
                  style={{ display: 'flex', alignItems: 'center', marginTop: 'var(--space-1)' }}
                >
                  <button
                    onClick={toggleCronCollapsed}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      padding: 'var(--space-2) var(--space-4)',
                      paddingRight: 'var(--space-1)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: 'var(--text-caption1)' }}>⏰</span>
                    <span style={{
                      fontSize: 'var(--text-caption1)',
                      fontWeight: 'var(--weight-semibold)',
                      color: 'var(--text-secondary)',
                      letterSpacing: '0.3px',
                      textTransform: 'uppercase',
                      flex: 1,
                    }}>
                      Scheduled
                    </span>
                    <span style={{
                      fontSize: 'var(--text-caption2)',
                      color: 'var(--text-tertiary)',
                      background: 'var(--fill-tertiary)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0 5px',
                      lineHeight: '18px',
                      minWidth: 18,
                      textAlign: 'center',
                    }}>
                      {cronSessions.length}
                    </span>
                    <svg
                      width="10" height="10" viewBox="0 0 24 24" fill="none"
                      stroke="var(--text-tertiary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      style={{
                        flexShrink: 0,
                        transition: 'transform 150ms ease',
                        transform: cronCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                      }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                </div>

                {/* Cron sessions list */}
                {!cronCollapsed && sortedCron.map((session) => {
                  const isActive = session.id === selectedId
                  const isHovered = hoveredKey === session.id
                  const isRunning = session.status === 'running'
                  const isRead = readSessions.has(session.id)
                  const isError = session.status === 'error'
                  const isPinned = pinnedSessions.has(session.id)
                  const timeLabel = formatTime(getSessionActivity(session))

                  let dotColor: string
                  if (isRunning) dotColor = 'var(--system-blue)'
                  else if (isError) dotColor = 'var(--system-red)'
                  else if (isRead) dotColor = 'var(--text-quaternary)'
                  else dotColor = 'var(--system-green)'

                  return (
                    <button
                      key={session.id}
                      onClick={() => { onSelect(session.id); onEmployeeSessionsAvailable?.([session]) }}
                      onMouseEnter={() => setHoveredKey(session.id)}
                      onMouseLeave={() => setHoveredKey(null)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        padding: 'var(--space-3) var(--space-4)',
                        paddingLeft: 'calc(var(--space-4) + 8px)',
                        background: isActive ? 'var(--fill-secondary)' : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                        position: 'relative',
                      }}
                    >
                      {/* Status dot */}
                      <div style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: dotColor,
                        flexShrink: 0,
                        animation: isRunning ? 'sidebar-pulse 2s ease-in-out infinite' : 'none',
                        boxShadow: isRunning ? `0 0 6px ${dotColor}` : 'none',
                      }} />

                      {/* Text content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          marginBottom: 2,
                        }}>
                          <span style={{
                            fontSize: 'var(--text-footnote)',
                            fontWeight: isRead && !isActive ? 'var(--weight-medium)' : 'var(--weight-semibold)',
                            color: 'var(--text-primary)',
                            letterSpacing: '-0.2px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                            minWidth: 0,
                          }}>
                            {fixTitle(session.title, session.employee)}
                          </span>
                          <span style={{
                            fontSize: 'var(--text-caption2)',
                            color: 'var(--text-tertiary)',
                            flexShrink: 0,
                            marginLeft: 'var(--space-1)',
                          }}>
                            {timeLabel}
                          </span>
                        </div>
                        <div style={{
                          fontSize: 'var(--text-caption1)',
                          color: 'var(--text-tertiary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {session.employee || portalName}
                        </div>
                      </div>

                      {/* Pin indicator */}
                      {isPinned && !isHovered && (
                        <span style={{ fontSize: 11, flexShrink: 0, opacity: 0.5 }}>📌</span>
                      )}

                      {/* Action buttons on hover */}
                      {isHovered && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); togglePin(session.id) }}
                            aria-label={isPinned ? 'Unpin session' : 'Pin session'}
                            style={{
                              padding: 4,
                              borderRadius: 'var(--radius-sm)',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              color: isPinned ? 'var(--accent)' : 'var(--text-tertiary)',
                              display: 'flex',
                              alignItems: 'center',
                              flexShrink: 0,
                              transition: 'color 150ms ease',
                            }}
                            onMouseEnter={(e) => { if (!isPinned) e.currentTarget.style.color = 'var(--accent)' }}
                            onMouseLeave={(e) => { if (!isPinned) e.currentTarget.style.color = 'var(--text-tertiary)' }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 17v5" />
                              <path d="M9 2h6l-1 7h4l-2 4H8l-2-4h4L9 2z" />
                            </svg>
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(session.id) }}
                            aria-label="Delete session"
                            style={{
                              padding: 4,
                              borderRadius: 'var(--radius-sm)',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              color: 'var(--text-tertiary)',
                              display: 'flex',
                              alignItems: 'center',
                              flexShrink: 0,
                              transition: 'color 150ms ease',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--system-red)')}
                            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Confirm delete single session dialog */}
      {confirmDelete && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirmDelete(null)}
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
                onClick={() => setConfirmDelete(null)}
                style={{
                  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)',
                  background: 'var(--fill-tertiary)', color: 'var(--text-primary)',
                  border: 'none', cursor: 'pointer', fontSize: 'var(--text-body)',
                }}
              >Cancel</button>
              <button
                onClick={() => handleDelete(confirmDelete)}
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

      {/* Confirm delete employee (all their sessions) dialog */}
      {confirmDeleteEmployee && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirmDeleteEmployee(null)}
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
              Delete All Chats?
            </h3>
            <p style={{ fontSize: 'var(--text-body)', color: 'var(--text-secondary)', marginBottom: 'var(--space-5)' }}>
              Delete all {confirmDeleteEmployee.sessions.length} chat{confirmDeleteEmployee.sessions.length !== 1 ? 's' : ''} with &ldquo;{confirmDeleteEmployee.displayName}&rdquo;? This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDeleteEmployee(null)}
                style={{
                  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)',
                  background: 'var(--fill-tertiary)', color: 'var(--text-primary)',
                  border: 'none', cursor: 'pointer', fontSize: 'var(--text-body)',
                }}
              >Cancel</button>
              <button
                onClick={() => handleDeleteEmployee(confirmDeleteEmployee.name, confirmDeleteEmployee.sessions)}
                style={{
                  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)',
                  background: 'var(--system-red)', color: '#fff',
                  border: 'none', cursor: 'pointer', fontSize: 'var(--text-body)',
                  fontWeight: 'var(--weight-semibold)',
                }}
              >Delete {confirmDeleteEmployee.sessions.length} Chat{confirmDeleteEmployee.sessions.length !== 1 ? 's' : ''}</button>
            </div>
          </div>
        </div>
      )}

      {/* Pulse animation for running sessions */}
      <style>{`
        @keyframes sidebar-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
      `}</style>
    </div>
  )
}

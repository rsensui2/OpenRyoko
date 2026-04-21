"use client"

import { useEffect, useState, useRef, useCallback, useMemo, startTransition } from "react"
import { ChevronDown, Clock3, Copy, EllipsisVertical, Pencil, Pin, Plus, Search, Trash2, X } from "lucide-react"
import { api, type Employee } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { useSettings } from "@/app/settings-provider"
import { cleanPreview } from "@/lib/clean-preview"
import { useSessions, useUpdateSession, useDeleteSession, useBulkDeleteSessions, useDuplicateSession } from "@/hooks/use-sessions"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

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

export interface SidebarOrder {
  sessionIds: string[]
  employeeNames: string[]
  employeeSessionMap: Record<string, string[]>
}

interface ChatSidebarProps {
  selectedId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete?: (id: string) => void
  onDuplicate?: (newSessionId: string) => void
  onSessionsLoaded?: (sessions: Session[]) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  onOrderComputed?: (order: SidebarOrder) => void
}

interface FlatItem {
  type: "employee" | "direct"
  employeeName?: string
  employeeData?: Employee
  sessions?: Session[]
  session?: Session
  sortKey: string
  pinKey: string
}

const COLLAPSE_STORAGE_KEY = "jinn-sidebar-collapsed"
const EXPANDED_STORAGE_KEY = "jinn-sidebar-expanded"
const PINNED_STORAGE_KEY = "jinn-pinned-sessions"

function formatTime(dateStr?: string): string {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return "now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) {
    return new Date(dateStr).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  }
  if (diff < 172_800_000) return "yesterday"
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function getReadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem("jinn-read-sessions")
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function markSessionRead(id: string) {
  const read = getReadSessions()
  read.add(id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem("jinn-read-sessions", JSON.stringify(arr))
}

function markAllReadForEmployee(sessions: Session[]) {
  const read = getReadSessions()
  for (const s of sessions) read.add(s.id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem("jinn-read-sessions", JSON.stringify(arr))
}

function getPinnedSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function savePinnedSessions(pinned: Set<string>) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(pinned)))
  } catch {}
}

function loadCollapsedState(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsedState(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsed)))
  } catch {}
}

function loadExpandedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveExpandedState(expanded: Record<string, boolean>) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
  } catch {}
}

function titleCase(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

function isCronSession(session: Session): boolean {
  return session.source === "cron" || (session.sourceRef || "").startsWith("cron:")
}

function isDirectSession(session: Session, portalSlug: string): boolean {
  return !isCronSession(session) && (!session.employee || session.employee === portalSlug)
}

function getSessionActivity(session: Session): string {
  return session.lastActivity || session.createdAt || ""
}

function sortSessionsByActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => getSessionActivity(b).localeCompare(getSessionActivity(a)))
}

function getStatusDotColor(session: Session, readSet: Set<string>): string {
  if (session.status === "running") return "var(--system-blue)"
  if (session.status === "error") return "var(--system-red)"
  if (readSet.has(session.id)) return "var(--text-quaternary)"
  return "var(--system-green)"
}

function StatusDot({
  color,
  pulse = false,
  className,
}: {
  color: string
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      className={cn("shrink-0 rounded-full", className)}
      style={{
        background: color,
        animation: pulse ? "sidebar-pulse 2s ease-in-out infinite" : "none",
        boxShadow: pulse ? `0 0 8px ${color}` : "none",
      }}
    />
  )
}

function SectionLabel({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode
  label: string
  count?: number
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className="text-xs">{icon}</span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {typeof count === "number" && (
        <span className="ml-auto rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
          {count}
        </span>
      )}
    </div>
  )
}

export function ChatSidebar({
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
  onDuplicate,
  onSessionsLoaded,
  onEmployeeSessionsAvailable,
  onOrderComputed,
}: ChatSidebarProps) {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? "Ryoko"
  const portalSlug = portalName.toLowerCase()

  const fixTitle = (title: string | undefined, employee: string | undefined) => {
    if (!title) return employee || portalName
    if (portalName !== "Jinn" && title.startsWith("Jinn - ")) {
      return portalName + title.slice(4)
    }
    return title
  }

  const { data: rawSessions, isLoading: loading } = useSessions()
  const updateSessionMutation = useUpdateSession()
  const deleteSessionMutation = useDeleteSession()
  const bulkDeleteMutation = useBulkDeleteSessions()
  const duplicateSessionMutation = useDuplicateSession()

  const sessions = useMemo(() => {
    if (!rawSessions) return []
    const filtered = (rawSessions as Session[]).filter(
      (s) => s.source === "web" || s.source === "cron" || s.source === "whatsapp" || s.source === "discord" || !s.source
    )
    filtered.sort((a, b) => {
      const ta = a.lastActivity || a.createdAt || ""
      const tb = b.lastActivity || b.createdAt || ""
      return tb.localeCompare(ta)
    })
    return filtered
  }, [rawSessions])

  const [search, setSearch] = useState("")
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const renameCancelledRef = useRef(false)
  const [readSessions, setReadSessions] = useState<Set<string>>(new Set())
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [fullyExpanded, setFullyExpanded] = useState<Record<string, boolean>>({})
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "session" | "employee"
    id: string
    label: string
    sessions?: Session[]
  } | null>(null)
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const [employeeData, setEmployeeData] = useState<Map<string, Employee>>(new Map())
  const onSessionsLoadedRef = useRef(onSessionsLoaded)

  useEffect(() => {
    onSessionsLoadedRef.current = onSessionsLoaded
  }, [onSessionsLoaded])

  useEffect(() => {
    if (sessions.length > 0) {
      startTransition(() => {
        onSessionsLoadedRef.current?.(sessions)
      })
    }
  }, [sessions])

  useEffect(() => {
    setReadSessions(getReadSessions())
    setPinnedSessions(getPinnedSessions())
    setCollapsed(loadCollapsedState())
    setExpanded(loadExpandedState())
  }, [])

  useEffect(() => {
    if (selectedId) {
      markSessionRead(selectedId)
      setReadSessions((prev) => {
        const next = new Set(prev)
        next.add(selectedId)
        return next
      })
    }
  }, [selectedId])

  // Fetch employee display names from org API
  useEffect(() => {
    api.getOrg().then((org) => {
      const map = new Map<string, Employee>()
      for (const emp of org.employees) {
        map.set(emp.name, emp)
      }
      setEmployeeData(map)
    }).catch(() => { /* best-effort */ })
  }, [])

  const toggleCronCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has("cron")) next.delete("cron")
      else next.add("cron")
      saveCollapsedState(next)
      return next
    })
  }, [])

  const toggleEmployeeExpanded = useCallback((empName: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [empName]: !prev[empName] }
      saveExpandedState(next)
      if (!next[empName]) {
        setFullyExpanded((fe) => {
          if (!fe[empName]) return fe
          const { [empName]: _, ...rest } = fe
          return rest
        })
      }
      return next
    })
  }, [])

  const togglePin = useCallback((pinKey: string) => {
    setPinnedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(pinKey)) next.delete(pinKey)
      else next.add(pinKey)
      savePinnedSessions(next)
      return next
    })
  }, [])

  const handleMarkAllRead = useCallback((empSessions: Session[]) => {
    markAllReadForEmployee(empSessions)
    setReadSessions((prev) => {
      const next = new Set(prev)
      for (const s of empSessions) next.add(s.id)
      return next
    })
  }, [])

  async function handleDeleteEmployee(empName: string, empSessions: Session[]) {
    const ids = empSessions.map((s) => s.id)
    try {
      await bulkDeleteMutation.mutateAsync(ids)
      setPinnedSessions((prev) => {
        const next = new Set(prev)
        next.delete(`emp:${empName}`)
        for (const id of ids) next.delete(id)
        savePinnedSessions(next)
        return next
      })
      startTransition(() => {
        if (selectedId && ids.includes(selectedId)) onNewChat()
      })
    } catch {}
  }

  async function handleDelete(sessionId: string) {
    // Compute next session to select before removing
    let nextSelectId: string | null = null
    if (selectedId === sessionId) {
      // Build a flat ordered list of all visible session IDs
      const allVisible: string[] = []
      const addGroup = (items: FlatItem[]) => {
        for (const item of items) {
          const empName = item.employeeName!
          const empSessions = item.sessions || []
          // Always add the latest session (employee row click selects it)
          if (empSessions.length === 1) {
            allVisible.push(empSessions[0].id)
          } else if (expanded[empName]) {
            const visible = fullyExpanded[empName] ? empSessions : empSessions.slice(0, 5)
            for (const s of visible) allVisible.push(s.id)
          } else {
            // Collapsed — only the latest session is reachable
            if (empSessions.length > 0) allVisible.push(empSessions[0].id)
          }
        }
      }
      addGroup(pinnedFlat)
      addGroup(unpinnedFlat)
      for (const s of sortedCron) allVisible.push(s.id)

      const idx = allVisible.indexOf(sessionId)
      if (idx !== -1) {
        // Prefer next item, then previous
        if (idx + 1 < allVisible.length) nextSelectId = allVisible[idx + 1]
        else if (idx - 1 >= 0) nextSelectId = allVisible[idx - 1]
      }
    }

    try {
      await deleteSessionMutation.mutateAsync(sessionId)
      setPinnedSessions((prev) => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        savePinnedSessions(next)
        return next
      })
      startTransition(() => {
        if (nextSelectId) {
          onSelect(nextSelectId)
        } else if (onDelete) {
          onDelete(sessionId)
        } else if (selectedId === sessionId) {
          onNewChat()
        }
      })
    } catch {}
  }

  async function handleDuplicate(sessionId: string) {
    try {
      const result = await duplicateSessionMutation.mutateAsync(sessionId) as { id?: string }
      if (result?.id) {
        onDuplicate?.(result.id)
        onSelect(result.id)
        // Auto-start rename on the new session
        setRenamingSessionId(result.id)
        renameCancelledRef.current = false
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || "Unknown error"}`)
    }
  }

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

  const cronSessions: Session[] = []
  const directSessions: Session[] = []
  const employeeSessionMap = new Map<string, Session[]>()

  for (const s of displayed) {
    if (isCronSession(s)) cronSessions.push(s)
    else if (isDirectSession(s, portalSlug)) directSessions.push(s)
    else {
      const emp = s.employee!
      if (!employeeSessionMap.has(emp)) employeeSessionMap.set(emp, [])
      employeeSessionMap.get(emp)!.push(s)
    }
  }

  const flatItems: FlatItem[] = []

  for (const [empName, empSessions] of employeeSessionMap) {
    const sorted = sortSessionsByActivity(empSessions)
    flatItems.push({
      type: "employee",
      employeeName: empName,
      employeeData: employeeData.get(empName),
      sessions: sorted,
      sortKey: getSessionActivity(sorted[0]),
      pinKey: `emp:${empName}`,
    })
  }

  if (directSessions.length > 0) {
    const sorted = sortSessionsByActivity(directSessions)
    flatItems.push({
      type: "employee",
      employeeName: portalSlug,
      employeeData: {
        name: portalSlug,
        displayName: portalName,
        emoji: "\u{1F4AC}",
        department: "direct",
        role: "",
        rank: "manager",
        engine: "",
        model: "",
        persona: "",
      } as Employee,
      sessions: sorted,
      sortKey: getSessionActivity(sorted[0]),
      pinKey: `emp:${portalSlug}`,
    })
  }

  const pinnedFlat = flatItems
    .filter((item) => pinnedSessions.has(item.pinKey))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  const unpinnedFlat = flatItems
    .filter((item) => !pinnedSessions.has(item.pinKey))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))

  const cronCollapsed = collapsed.has("cron")
  const sortedCron = sortSessionsByActivity(cronSessions)

  // Emit flat session order for keyboard navigation (J/K/E shortcuts)
  const orderRef = useRef<string>('')
  const allFlatIds = useMemo(() => {
    const ids: string[] = []
    const empNames: string[] = []
    const empMap: Record<string, string[]> = {}
    for (const item of [...pinnedFlat, ...unpinnedFlat]) {
      const name = item.employeeName!
      empNames.push(name)
      const sessionIds = item.sessions!.map(s => s.id)
      empMap[name] = sessionIds
      ids.push(...sessionIds)
    }
    for (const s of sortedCron) ids.push(s.id)
    return { sessionIds: ids, employeeNames: empNames, employeeSessionMap: empMap }
  }, [pinnedFlat, unpinnedFlat, sortedCron])

  useEffect(() => {
    const key = allFlatIds.sessionIds.join(',')
    if (key !== orderRef.current) {
      orderRef.current = key
      onOrderComputed?.(allFlatIds)
    }
  }, [allFlatIds, onOrderComputed])

  function isEmployeeActive(empSessions: Session[]): boolean {
    return empSessions.some((s) => s.id === selectedId)
  }

  function handleEmployeeClick(item: FlatItem) {
    const empName = item.employeeName!
    const empSessions = item.sessions!
    if (empSessions.length > 1) {
      // Toggle expand/collapse — selecting latest session when expanding
      const wasExpanded = expanded[empName] || false
      toggleEmployeeExpanded(empName)
      if (!wasExpanded) {
        onSelect(empSessions[0].id)
        onEmployeeSessionsAvailable?.(empSessions)
      }
    } else {
      onSelect(empSessions[0].id)
      onEmployeeSessionsAvailable?.(empSessions)
    }
  }

  function renderSessionRow(session: Session, parentSessions?: Session[]) {
    const sessionIsActive = session.id === selectedId
    const sessionDotColor = getStatusDotColor(session, readSessions)
    const sessionIsRunning = session.status === "running"
    const sessionTitle = fixTitle(session.title, session.employee)
    const displayTitle = cleanPreview(sessionTitle) || sessionTitle
    const sessionTime = formatTime(getSessionActivity(session))
    const isPinned = pinnedSessions.has(session.id)
    const isRenaming = renamingSessionId === session.id
    const RowTag = isRenaming ? "div" : "button"

    return (
      <ContextMenu key={session.id}>
        <ContextMenuTrigger asChild>
          <RowTag
            {...(!isRenaming && { onClick: () => {
              onSelect(session.id)
              onEmployeeSessionsAvailable?.(parentSessions ?? [session])
            }})}
            className={cn(
              "group/session relative flex w-full items-center gap-2.5 border-l-2 px-4 py-2 text-left transition-colors",
              parentSessions
                ? "pl-11"
                : "pl-6",
              sessionIsActive
                ? "border-l-[var(--accent)] bg-[var(--fill-secondary)]"
                : "border-l-transparent hover:bg-accent"
            )}
          >
            <StatusDot color={sessionDotColor} pulse={sessionIsRunning} className="size-1.5" />
            {isRenaming ? (
              <input
                autoFocus
                maxLength={200}
                defaultValue={displayTitle}
                className={cn(
                  "min-w-0 flex-1 truncate border-none bg-transparent text-xs outline-none ring-1 ring-[var(--accent)] rounded px-0.5",
                  sessionIsActive ? "font-semibold text-foreground" : "text-[var(--text-secondary)]"
                )}
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur()
                  } else if (e.key === "Escape") {
                    renameCancelledRef.current = true
                    setRenamingSessionId(null)
                  }
                }}
                onBlur={(e) => {
                  if (renameCancelledRef.current) {
                    renameCancelledRef.current = false
                    return
                  }
                  const val = e.target.value.trim()
                  if (val && val !== displayTitle) {
                    updateSessionMutation.mutate({ id: session.id, data: { title: val } })
                  }
                  setRenamingSessionId(null)
                }}
              />
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  sessionIsActive ? "font-semibold text-foreground" : "text-[var(--text-secondary)]"
                )}
              >
                {cleanPreview(sessionTitle) || "Untitled"}
              </span>
            )}
            {isPinned ? (
              <Pin className="size-3 shrink-0 text-[var(--accent)] group-hover/session:lg:hidden group-has-[[data-state=open]]/session:lg:hidden" />
            ) : null}
            {/* Date on default, ... on hover (desktop only) */}
            <span className="shrink-0 text-[10px] text-[var(--text-quaternary)] group-hover/session:lg:hidden group-has-[[data-state=open]]/session:lg:hidden">{sessionTime}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="hidden shrink-0 text-muted-foreground transition-colors hover:text-foreground group-hover/session:lg:block group-has-[[data-state=open]]/session:lg:block"
                >
                  <EllipsisVertical className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}>
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => togglePin(session.id)}>
                  {isPinned ? "Unpin" : "Pin"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleDuplicate(session.id)}>
                  Duplicate...
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "session", id: session.id, label: cleanPreview(sessionTitle) || "Untitled" })}>
                  Delete session
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </RowTag>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}>
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={() => togglePin(session.id)}>
            {isPinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleDuplicate(session.id)}>
            Duplicate...
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "session", id: session.id, label: cleanPreview(sessionTitle) || "Untitled" })}>
            <span className="flex-1">Delete session</span>
            <kbd className="ml-auto pl-3 font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  function renderEmployeeItem(item: FlatItem) {
    const empName = item.employeeName!
    const empSessions = item.sessions!
    const latestSession = empSessions[0]
    const empInfo = item.employeeData
    const displayName = empInfo?.displayName || titleCase(empName)
    const department = empInfo?.department || ""
    const timeLabel = formatTime(getSessionActivity(latestSession))
    const dotColor = getStatusDotColor(latestSession, readSessions)
    const pulse = latestSession.status === "running"
    const isActive = isEmployeeActive(empSessions)
    const isPinned = pinnedSessions.has(item.pinKey)
    const sessionCount = empSessions.length
    const isExpanded = expanded[empName] || false
    const hasUnread = empSessions.some(
      (s) => !readSessions.has(s.id) && s.status !== "running" && s.status !== "error"
    )

    return (
      <div key={item.pinKey}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              onClick={() => handleEmployeeClick(item)}
              className={cn(
                "group/emp relative flex w-full items-center gap-3 border-l-2 px-4 py-3 text-left transition-colors",
                isActive
                  ? "border-l-[var(--accent)] bg-[var(--fill-secondary)]"
                  : "border-l-transparent hover:bg-accent"
              )}
            >
              <div className="relative flex size-9 shrink-0 items-center justify-center">
                <EmployeeAvatar name={empName} size={36} />
                <StatusDot
                  color={dotColor}
                  pulse={pulse}
                  className="absolute -bottom-0.5 -right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-baseline gap-2">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13px] tracking-[-0.2px] text-foreground",
                      hasUnread || isActive ? "font-semibold" : "font-medium"
                    )}
                  >
                    {displayName}
                  </span>
                  {/* Date on default, ... on hover (desktop only) */}
                  <span className="shrink-0 text-[10px] text-[var(--text-tertiary)] group-hover/emp:lg:hidden group-has-[[data-state=open]]/emp:lg:hidden">{timeLabel}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="hidden shrink-0 text-muted-foreground transition-colors hover:text-foreground group-hover/emp:lg:block group-has-[[data-state=open]]/emp:lg:block"
                      >
                        <EllipsisVertical className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => togglePin(item.pinKey)}>
                        {isPinned ? "Unpin" : "Pin"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleMarkAllRead(empSessions)}>
                        Mark all as read
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "employee", id: empName, label: displayName, sessions: empSessions })}>
                        Delete all chats
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex items-center gap-1.5 overflow-hidden text-[11px] text-[var(--text-tertiary)]">
                  {department ? <span className="truncate">{department}</span> : null}
                  {sessionCount > 1 ? (
                    <span className="shrink-0 rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px]">
                      {sessionCount} chats
                    </span>
                  ) : null}
                  {isPinned ? (
                    <Pin className="size-3 shrink-0 text-[var(--accent)]" />
                  ) : null}
                </div>
              </div>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => togglePin(item.pinKey)}>
              {isPinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => handleMarkAllRead(empSessions)}>
              Mark all as read
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "employee", id: empName, label: displayName, sessions: empSessions })}>
              Delete all chats
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {isExpanded && sessionCount > 1 ? (
          fullyExpanded[empName]
            ? empSessions.map((session) => renderSessionRow(session, empSessions))
            : empSessions.slice(0, 5).map((session) => renderSessionRow(session, empSessions))
        ) : null}
        {isExpanded && sessionCount > 5 && !fullyExpanded[empName] ? (
          <button
            onClick={() => setFullyExpanded((prev) => ({ ...prev, [empName]: true }))}
            className="w-full cursor-pointer px-4 pb-2 pl-11 text-left text-[10px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)]"
          >
            +{sessionCount - 5} more
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-[var(--sidebar-bg)]">
      <div className="shrink-0 border-b border-border bg-[var(--material-thick)] px-4 pb-3 pt-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-[-0.03em] text-foreground">Chats</h2>
            <p className="text-xs text-muted-foreground">All conversations</p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" className="gap-1.5" onClick={onNewChat} title="New chat (N)">
              <Plus className="size-3.5" />
              New
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-2">
          <Search className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
          <input
            id="chat-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            aria-label="Search chats"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-[var(--text-tertiary)]"
          />
          {search.trim() ? (
            <button
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="rounded-full p-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
            Loading sessions...
          </div>
        ) : pinnedFlat.length === 0 && unpinnedFlat.length === 0 && cronSessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
            {search.trim() ? "No matching chats" : "No conversations yet"}
          </div>
        ) : (
          <>
            {pinnedFlat.map((item) => renderEmployeeItem(item))}
            {unpinnedFlat.map((item) => renderEmployeeItem(item))}

            {cronSessions.length > 0 ? (
              <div className={cn("mt-2", pinnedFlat.length === 0 && unpinnedFlat.length === 0 && "mt-0")}>
                <button
                  onClick={toggleCronCollapsed}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-accent"
                >
                  <Clock3 className="size-3.5 text-muted-foreground" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Scheduled
                  </span>
                  <span className="ml-auto rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                    {cronSessions.length}
                  </span>
                  <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", cronCollapsed && "-rotate-90")} />
                </button>
                {!cronCollapsed ? sortedCron.map((session) => renderSessionRow(session)) : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent showCloseButton={false} className="max-w-sm" onOpenAutoFocus={(e) => { e.preventDefault(); deleteButtonRef.current?.focus() }}>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.type === "employee"
                ? `Delete all chats with "${deleteTarget.label}"?`
                : `Delete "${deleteTarget?.label}"?`}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.type === "employee"
                ? `This will permanently delete ${deleteTarget.sessions?.length ?? 0} session(s) and all their messages. This cannot be undone.`
                : "This will permanently delete the session and all its messages. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              ref={deleteButtonRef}
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return
                if (deleteTarget.type === "employee" && deleteTarget.sessions) {
                  handleDeleteEmployee(deleteTarget.id, deleteTarget.sessions)
                } else {
                  handleDelete(deleteTarget.id)
                }
                setDeleteTarget(null)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <style jsx>{`
        @keyframes sidebar-pulse {
          0%,
          100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.55;
            transform: scale(0.85);
          }
        }
      `}</style>
    </div>
  )
}

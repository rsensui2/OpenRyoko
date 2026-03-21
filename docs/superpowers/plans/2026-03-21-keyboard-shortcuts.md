# Keyboard Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a centralized keyboard shortcut system with a Linear-style hint overlay to the Jinn web dashboard chat page.

**Architecture:** A `useKeyboardShortcuts` hook manages a declarative shortcut registry, handles keydown events with input/modal safety guards, and exposes the registry for the overlay. The `ShortcutOverlay` component renders a grouped hints panel. The chat page wires shortcuts to actions and renders the overlay. The sidebar exposes computed session/employee ordering via callbacks for J/K/E navigation.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, Tailwind CSS v4, Next.js 15 App Router

**Spec:** `docs/superpowers/specs/2026-03-21-keyboard-shortcuts-design.md`

**Test runner:** `cd packages/web && pnpm test` (runs `vitest run`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/web/src/hooks/use-keyboard-shortcuts.ts` | Create | Core hook: registry types, key matching, safety guards, event listener |
| `packages/web/src/hooks/__tests__/use-keyboard-shortcuts.test.ts` | Create | Unit tests for the hook |
| `packages/web/src/components/chat/shortcut-overlay.tsx` | Create | Overlay UI component |
| `packages/web/src/components/chat/__tests__/shortcut-overlay.test.tsx` | Create | Component tests for overlay |
| `packages/web/src/components/chat/chat-sidebar.tsx` | Modify | Add `id="chat-search"` + `onOrderComputed` + `onEmployeeOrderComputed` props |
| `packages/web/src/app/chat/page.tsx` | Modify | Replace inline keyboard handler, wire all shortcuts, render overlay |

---

### Task 1: useKeyboardShortcuts Hook — Types & Key Matching

**Files:**
- Create: `packages/web/src/hooks/use-keyboard-shortcuts.ts`
- Create: `packages/web/src/hooks/__tests__/use-keyboard-shortcuts.test.ts`

- [ ] **Step 1: Write failing tests for key matching**

```typescript
// packages/web/src/hooks/__tests__/use-keyboard-shortcuts.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeyboardShortcuts, type ShortcutDef } from '../use-keyboard-shortcuts'

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }))
}

describe('useKeyboardShortcuts', () => {
  describe('key matching', () => {
    it('fires action for matching single key', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('n')
      expect(action).toHaveBeenCalledOnce()
    })

    it('does not fire when wrong key pressed', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('x')
      expect(action).not.toHaveBeenCalled()
    })

    it('matches case-insensitively for letters', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('N')
      expect(action).toHaveBeenCalledOnce()
    })

    it('fires action for modifier shortcut', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('w', { metaKey: true })
      expect(action).toHaveBeenCalledOnce()
    })

    it('does not fire modifier shortcut without modifier', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('w')
      expect(action).not.toHaveBeenCalled()
    })

    it('does not fire single-key shortcut when modifier is held', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('n', { metaKey: true })
      expect(action).not.toHaveBeenCalled()
    })

    it('matches ? key (shift+/ produces ?)', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: '?', category: 'Help', description: 'Help', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('?', { shiftKey: true })
      expect(action).toHaveBeenCalledOnce()
    })

    it('skips disabled shortcuts', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action, enabled: false },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))
      fireKey('n')
      expect(action).not.toHaveBeenCalled()
    })
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1 | tail -30`
Expected: FAIL — module `../use-keyboard-shortcuts` not found

- [ ] **Step 3: Implement hook with types and key matching**

```typescript
// packages/web/src/hooks/use-keyboard-shortcuts.ts
import { useEffect } from 'react'

export interface ShortcutDef {
  key: string
  modifiers?: ('meta' | 'shift' | 'alt')[]
  category: 'Navigation' | 'Actions' | 'Help'
  description: string
  action: () => void
  enabled?: boolean
}

function matchesShortcut(e: KeyboardEvent, s: ShortcutDef): boolean {
  const mods = s.modifiers ?? []
  const hasMeta = mods.includes('meta')
  const hasShift = mods.includes('shift')
  const hasAlt = mods.includes('alt')

  // Key comparison: case-insensitive for single letters
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const defKey = s.key.length === 1 ? s.key.toLowerCase() : s.key

  // Special case: '?' is produced by Shift+/, match on e.key directly
  if (s.key === '?') {
    if (e.key !== '?') return false
    // Don't require shift as a modifier — it's implicit in the key
    if (e.metaKey || e.altKey || e.ctrlKey) return false
    return true
  }

  if (eventKey !== defKey) return false

  // Check modifiers
  if (hasMeta !== e.metaKey) return false
  if (hasShift !== e.shiftKey) return false
  if (hasAlt !== e.altKey) return false

  // Block if ctrl is pressed (not in our modifier system)
  if (e.ctrlKey && !hasMeta) return false

  return true
}

export function useKeyboardShortcuts(shortcuts: ShortcutDef[]) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      for (const s of shortcuts) {
        if (s.enabled === false) continue
        if (matchesShortcut(e, s)) {
          e.preventDefault()
          s.action()
          return
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcuts])
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1 | tail -30`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/jimmy-wt-ici-424 && git add packages/web/src/hooks/use-keyboard-shortcuts.ts packages/web/src/hooks/__tests__/use-keyboard-shortcuts.test.ts && git commit -m "feat(ICI-424): add useKeyboardShortcuts hook with key matching"
```

---

### Task 2: Safety Guards (Input & Modal)

**Files:**
- Modify: `packages/web/src/hooks/__tests__/use-keyboard-shortcuts.test.ts`
- Modify: `packages/web/src/hooks/use-keyboard-shortcuts.ts`

- [ ] **Step 1: Write failing tests for safety guards**

Add to the test file after the `key matching` describe block:

```typescript
  describe('input guard', () => {
    afterEach(() => {
      document.body.innerHTML = ''
    })

    it('blocks single-key shortcuts when input is focused', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireKey('n')
      expect(action).not.toHaveBeenCalled()
    })

    it('blocks single-key shortcuts when textarea is focused', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      fireKey('n')
      expect(action).not.toHaveBeenCalled()
    })

    it('allows modifier shortcuts when input is focused', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireKey('w', { metaKey: true })
      expect(action).toHaveBeenCalledOnce()
    })

    it('allows Escape when input is focused', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'Escape', category: 'Navigation', description: 'Close', action },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts))

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireKey('Escape')
      expect(action).toHaveBeenCalledOnce()
    })
  })

  describe('modal guard', () => {
    it('blocks all shortcuts except Escape when isModalOpen is true', () => {
      const nAction = vi.fn()
      const escAction = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action: nAction },
        { key: 'Escape', category: 'Navigation', description: 'Close', action: escAction },
      ]
      renderHook(() => useKeyboardShortcuts(shortcuts, { isModalOpen: true }))

      fireKey('n')
      expect(nAction).not.toHaveBeenCalled()

      fireKey('Escape')
      expect(escAction).toHaveBeenCalledOnce()
    })
  })

  describe('cleanup', () => {
    it('removes event listener on unmount', () => {
      const action = vi.fn()
      const shortcuts: ShortcutDef[] = [
        { key: 'n', category: 'Actions', description: 'New chat', action },
      ]
      const { unmount } = renderHook(() => useKeyboardShortcuts(shortcuts))
      unmount()
      fireKey('n')
      expect(action).not.toHaveBeenCalled()
    })
  })
```

- [ ] **Step 2: Run tests — verify new tests fail**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1 | tail -40`
Expected: New tests FAIL (input guard, modal guard logic not yet implemented)

- [ ] **Step 3: Implement safety guards**

Update the hook signature and `handleKeyDown`:

```typescript
// In use-keyboard-shortcuts.ts — update the function signature:
export interface ShortcutOptions {
  isModalOpen?: boolean
}

export function useKeyboardShortcuts(shortcuts: ShortcutDef[], options: ShortcutOptions = {}) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isEscape = e.key === 'Escape'
      const target = e.target as HTMLElement | null
      const tagName = target?.tagName?.toLowerCase() ?? ''
      const isEditing = tagName === 'input' || tagName === 'textarea' || target?.isContentEditable === true

      for (const s of shortcuts) {
        if (s.enabled === false) continue
        if (!matchesShortcut(e, s)) continue

        const hasModifiers = (s.modifiers ?? []).length > 0
        const isThisEscape = s.key === 'Escape'

        // Modal guard: only Escape passes
        if (options.isModalOpen && !isThisEscape) continue

        // Input guard: block single-key shortcuts (except Escape) when editing
        if (isEditing && !hasModifiers && !isThisEscape) continue

        e.preventDefault()
        s.action()
        return
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcuts, options.isModalOpen])
}
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1 | tail -40`
Expected: All tests PASS (key matching + safety guards + cleanup)

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/jimmy-wt-ici-424 && git add packages/web/src/hooks/use-keyboard-shortcuts.ts packages/web/src/hooks/__tests__/use-keyboard-shortcuts.test.ts && git commit -m "feat(ICI-424): add input and modal safety guards to keyboard shortcuts hook"
```

---

### Task 3: ShortcutOverlay Component

**Files:**
- Create: `packages/web/src/components/chat/shortcut-overlay.tsx`
- Create: `packages/web/src/components/chat/__tests__/shortcut-overlay.test.tsx`

- [ ] **Step 1: Write failing tests for overlay**

```typescript
// packages/web/src/components/chat/__tests__/shortcut-overlay.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShortcutOverlay } from '../shortcut-overlay'
import type { ShortcutDef } from '@/hooks/use-keyboard-shortcuts'

const shortcuts: ShortcutDef[] = [
  { key: 'j', category: 'Navigation', description: 'Next session', action: vi.fn() },
  { key: 'k', category: 'Navigation', description: 'Previous session', action: vi.fn() },
  { key: 'n', category: 'Actions', description: 'New chat', action: vi.fn() },
  { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action: vi.fn() },
  { key: '?', category: 'Help', description: 'Toggle shortcuts', action: vi.fn() },
  { key: 'x', category: 'Actions', description: 'Disabled', action: vi.fn(), enabled: false },
]

describe('ShortcutOverlay', () => {
  it('renders category headings', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.getByText('Navigation')).toBeTruthy()
    expect(screen.getByText('Actions')).toBeTruthy()
    expect(screen.getByText('Help')).toBeTruthy()
  })

  it('renders shortcut descriptions', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.getByText('Next session')).toBeTruthy()
    expect(screen.getByText('New chat')).toBeTruthy()
  })

  it('renders key badges with uppercase letters', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.getByText('J')).toBeTruthy()
    expect(screen.getByText('K')).toBeTruthy()
    expect(screen.getByText('N')).toBeTruthy()
  })

  it('renders modifier symbols', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    // Meta+W should show the ⌘ symbol
    const badges = screen.getAllByText((_, el) => el?.textContent?.includes('⌘') ?? false)
    expect(badges.length).toBeGreaterThan(0)
  })

  it('hides disabled shortcuts', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.queryByText('Disabled')).toBeNull()
  })

  it('has keyboard shortcuts heading', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    expect(screen.getByText('Keyboard Shortcuts')).toBeTruthy()
  })

  it('has correct aria attributes', () => {
    render(<ShortcutOverlay shortcuts={shortcuts} onClose={vi.fn()} />)
    const el = screen.getByRole('complementary')
    expect(el).toBeTruthy()
    expect(el.getAttribute('aria-label')).toBe('Keyboard shortcuts')
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ShortcutOverlay component**

```tsx
// packages/web/src/components/chat/shortcut-overlay.tsx
"use client"

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ShortcutDef } from '@/hooks/use-keyboard-shortcuts'

const MODIFIER_SYMBOLS: Record<string, string> = {
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
}

const CATEGORY_ORDER: ShortcutDef['category'][] = ['Navigation', 'Actions', 'Help']

function formatKeyLabel(shortcut: ShortcutDef): string {
  const parts: string[] = []
  for (const mod of shortcut.modifiers ?? []) {
    parts.push(MODIFIER_SYMBOLS[mod] ?? mod)
  }
  // Display key: uppercase letters, named keys as-is
  const keyLabel = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key
  parts.push(keyLabel)
  return parts.join('')
}

interface ShortcutOverlayProps {
  shortcuts: ShortcutDef[]
  onClose: () => void
}

export function ShortcutOverlay({ shortcuts, onClose }: ShortcutOverlayProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Click-outside dismiss
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [onClose])

  const enabled = shortcuts.filter(s => s.enabled !== false)
  const grouped = CATEGORY_ORDER
    .map(cat => ({
      category: cat,
      items: enabled.filter(s => s.category === cat),
    }))
    .filter(g => g.items.length > 0)

  return (
    <div
      ref={ref}
      role="complementary"
      aria-label="Keyboard shortcuts"
      className="fixed bottom-4 right-4 z-40 w-[280px] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-xl animate-fade-in"
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <span className="text-sm font-semibold text-foreground">Keyboard Shortcuts</span>
        <button
          onClick={onClose}
          className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="px-3 py-2 max-h-[60vh] overflow-y-auto">
        {grouped.map((group, gi) => (
          <div key={group.category} className={gi > 0 ? 'mt-3' : ''}>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {group.category}
            </div>
            <div className="space-y-1">
              {group.items.map(s => (
                <div key={s.key + (s.modifiers?.join('') ?? '')} className="flex items-center gap-2 py-0.5">
                  <kbd className="inline-flex min-w-[24px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)] px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
                    {formatKeyLabel(s)}
                  </kbd>
                  <span className="text-xs text-muted-foreground">{s.description}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1 | tail -30`
Expected: All overlay tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/jimmy-wt-ici-424 && git add packages/web/src/components/chat/shortcut-overlay.tsx packages/web/src/components/chat/__tests__/shortcut-overlay.test.tsx && git commit -m "feat(ICI-424): add ShortcutOverlay component with grouped key hints"
```

---

### Task 4: Sidebar — Expose Session Order & Search ID

**Files:**
- Modify: `packages/web/src/components/chat/chat-sidebar.tsx`

This task adds:
1. `id="chat-search"` on the search input
2. `onOrderComputed` callback — emits a combined object with flat session IDs, employee names, and employee→sessionIds map

- [ ] **Step 1: Add `id="chat-search"` to the search input**

Find the search `<input>` element in `chat-sidebar.tsx` and add `id="chat-search"`. It should be near the search bar area. Look for `type="text"` with a search-related placeholder.

- [ ] **Step 2: Add the new optional prop to `ChatSidebarProps`**

```typescript
export interface SidebarOrder {
  sessionIds: string[]
  employeeNames: string[]
  employeeSessionMap: Record<string, string[]>
}

interface ChatSidebarProps {
  // ... existing props ...
  onOrderComputed?: (order: SidebarOrder) => void
}
```

- [ ] **Step 3: Add a `useEffect` that computes and emits the order**

After the sidebar computes its `displayed` list and groups it into employees/direct/cron sections, add an effect that:
1. Iterates through the rendered groups in display order (same order as the JSX)
2. Collects all session IDs into a flat array
3. Collects unique employee names in group order
4. Builds a `Record<string, string[]>` mapping employee name → session IDs
5. Calls `onOrderComputed({ sessionIds, employeeNames, employeeSessionMap })`

The effect should depend on the displayed sessions list. Use `JSON.stringify` of the ID list for change detection to avoid infinite loops.

- [ ] **Step 4: Verify existing tests still pass**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1 | tail -20`
Expected: All existing tests PASS (sidebar changes are additive — new optional props)

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/jimmy-wt-ici-424 && git add packages/web/src/components/chat/chat-sidebar.tsx && git commit -m "feat(ICI-424): expose session/employee order from sidebar for keyboard nav"
```

---

### Task 5: Wire Shortcuts into Chat Page

**Files:**
- Modify: `packages/web/src/app/chat/page.tsx`

This is the integration task. Wire all shortcuts to page actions.

- [ ] **Step 1: Add imports and state**

At the top of `chat/page.tsx`, add:

```typescript
import { useKeyboardShortcuts, type ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { ShortcutOverlay } from '@/components/chat/shortcut-overlay'
import type { SidebarOrder } from '@/components/chat/chat-sidebar'
```

Inside `ChatPage`, add state:

```typescript
const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
const sidebarOrderRef = useRef<SidebarOrder>({ sessionIds: [], employeeNames: [], employeeSessionMap: {} })
```

- [ ] **Step 2: Remove the existing keyboard handler**

Delete the `useEffect` block at lines 268-290 that handles `Cmd+W`, `Cmd+Shift+[/]`, and `Cmd+Alt+1-9`.

- [ ] **Step 3: Add order callbacks to ChatSidebar**

In both `<ChatSidebar>` instances (desktop and mobile), add:

```tsx
onOrderComputed={useCallback((order: SidebarOrder) => { sidebarOrderRef.current = order }, [])}
```

- [ ] **Step 4: Build navigation helpers**

```typescript
const navigateSession = useCallback((direction: 1 | -1) => {
  const { sessionIds } = sidebarOrderRef.current
  if (sessionIds.length === 0) return
  if (!selectedId) {
    handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
    return
  }
  const idx = sessionIds.indexOf(selectedId)
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
```

- [ ] **Step 5: Build the copy chat action**

```typescript
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
    // Show toast — use a simple approach since notification system is event-based
    setCopiedField('chat')
    setTimeout(() => setCopiedField(null), 1500)
  } catch {
    // Silently fail
  }
}, [selectedId])
```

- [ ] **Step 6: Define the shortcuts array**

```typescript
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
```

- [ ] **Step 7: Render the overlay**

Add before the closing `</PageLayout>` tag, just before the `<Dialog>`:

```tsx
{showShortcutOverlay && (
  <ShortcutOverlay
    shortcuts={shortcuts}
    onClose={() => setShowShortcutOverlay(false)}
  />
)}
```

- [ ] **Step 8: Run all tests**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1 | tail -30`
Expected: All tests PASS

- [ ] **Step 9: Run type check**

Run: `cd ~/Projects/jimmy-wt-ici-424 && pnpm typecheck 2>&1 | tail -20`
Expected: No type errors

- [ ] **Step 10: Commit**

```bash
cd ~/Projects/jimmy-wt-ici-424 && git add packages/web/src/app/chat/page.tsx packages/web/src/components/chat/chat-sidebar.tsx && git commit -m "feat(ICI-424): wire keyboard shortcuts into chat page with overlay"
```

---

### Task 6: Build & Visual Verification

**Files:** None new — verify existing changes work together.

- [ ] **Step 1: Run full test suite**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm test -- --reporter=verbose 2>&1`
Expected: All tests PASS

- [ ] **Step 2: Run build**

Run: `cd ~/Projects/jimmy-wt-ici-424/packages/web && pnpm build 2>&1 | tail -20`
Expected: Build succeeds with no errors

- [ ] **Step 3: Run lint**

Run: `cd ~/Projects/jimmy-wt-ici-424 && pnpm lint 2>&1 | tail -20`
Expected: No lint errors

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
cd ~/Projects/jimmy-wt-ici-424 && git add -u && git commit -m "fix(ICI-424): address build/lint issues"
```

(Only run this step if the build or lint step required fixes.)

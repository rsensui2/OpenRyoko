import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatTabs } from '../use-chat-tabs'

describe('useChatTabs', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })

  it('starts with no tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    expect(result.current.tabs).toHaveLength(0)
    expect(result.current.activeTab).toBeNull()
  })

  it('opens a tab and makes it active', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => {
      result.current.openTab({ sessionId: 's1', label: 'Test', status: 'idle', unread: false })
    })
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeIndex).toBe(0)
  })

  it('does not duplicate existing tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    const tab = { sessionId: 's1', label: 'Test', status: 'idle' as const, unread: false }
    act(() => result.current.openTab(tab))
    act(() => result.current.openTab(tab))
    expect(result.current.tabs).toHaveLength(1)
  })

  it('closes a tab and adjusts active index', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false }))
    act(() => result.current.openTab({ sessionId: 's2', label: 'B', status: 'idle', unread: false }))
    act(() => result.current.closeTab(0))
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.tabs[0].sessionId).toBe('s2')
  })

  it('clears the active tab without dropping open tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false }))
    act(() => result.current.openTab({ sessionId: 's2', label: 'B', status: 'idle', unread: false }))
    act(() => result.current.clearActiveTab())
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.activeTab).toBeNull()
    expect(result.current.activeIndex).toBe(-1)
  })

  it('removes the active tab cleanly when the last tab is closed', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false }))
    act(() => result.current.closeTab(0))
    expect(result.current.tabs).toHaveLength(0)
    expect(result.current.activeTab).toBeNull()
    expect(result.current.activeIndex).toBe(-1)
  })
})

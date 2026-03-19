"use client"

import { useState, useCallback, useEffect } from 'react'

export interface ChatTab {
  sessionId: string
  label: string        // Employee name or session title
  emoji?: string       // Employee avatar emoji
  status: 'idle' | 'running' | 'error'
  unread: boolean
}

const STORAGE_KEY = 'jinn-chat-tabs'
const DRAFT_PREFIX = 'jinn-chat-draft-'
const MAX_TABS = 12

interface TabState {
  tabs: ChatTab[]
  activeIndex: number
}

function clampState(state: TabState): TabState {
  if (state.tabs.length === 0) return { tabs: [], activeIndex: -1 }
  if (state.activeIndex < 0 || state.activeIndex >= state.tabs.length) {
    return { tabs: state.tabs, activeIndex: 0 }
  }
  return state
}

function loadTabs(): TabState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return clampState(JSON.parse(raw))
  } catch {}
  return { tabs: [], activeIndex: -1 }
}

function saveTabs(state: TabState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function useChatTabs() {
  const [{ tabs, activeIndex }, setState] = useState<TabState>({ tabs: [], activeIndex: -1 })

  useEffect(() => {
    setState(loadTabs())
  }, [])

  useEffect(() => {
    saveTabs({ tabs, activeIndex })
  }, [tabs, activeIndex])

  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null

  const openTab = useCallback((tab: ChatTab) => {
    setState((current) => {
      const existing = current.tabs.findIndex((t) => t.sessionId === tab.sessionId)
      if (existing >= 0) {
        const nextTabs = current.tabs.map((existingTab, index) =>
          index === existing ? { ...existingTab, ...tab } : existingTab
        )
        return { tabs: nextTabs, activeIndex: existing }
      }

      if (current.tabs.length >= MAX_TABS) {
        const replaceIdx = current.tabs.findIndex((_, index) => index !== current.activeIndex)
        if (replaceIdx >= 0) {
          const nextTabs = [...current.tabs]
          nextTabs[replaceIdx] = tab
          return { tabs: nextTabs, activeIndex: replaceIdx }
        }
      }

      return {
        tabs: [...current.tabs, tab],
        activeIndex: current.tabs.length,
      }
    })
  }, [])

  const closeTab = useCallback((index: number) => {
    setState((current) => {
      const sessionId = current.tabs[index]?.sessionId
      if (sessionId) localStorage.removeItem(DRAFT_PREFIX + sessionId)

      const nextTabs = current.tabs.filter((_, i) => i !== index)
      if (nextTabs.length === 0) return { tabs: [], activeIndex: -1 }

      let nextActiveIndex = current.activeIndex
      if (current.activeIndex === index) nextActiveIndex = Math.min(index, nextTabs.length - 1)
      else if (current.activeIndex > index) nextActiveIndex = current.activeIndex - 1

      return { tabs: nextTabs, activeIndex: nextActiveIndex }
    })
  }, [])

  const switchTab = useCallback((index: number) => {
    setState((current) => {
      if (index < 0 || index >= current.tabs.length) return current
      return { ...current, activeIndex: index }
    })
  }, [tabs.length])

  const nextTab = useCallback(() => {
    setState((current) => {
      if (current.tabs.length === 0) return current
      return { ...current, activeIndex: (current.activeIndex + 1 + current.tabs.length) % current.tabs.length }
    })
  }, [tabs.length])

  const prevTab = useCallback(() => {
    setState((current) => {
      if (current.tabs.length === 0) return current
      return { ...current, activeIndex: (current.activeIndex - 1 + current.tabs.length) % current.tabs.length }
    })
  }, [tabs.length])

  const clearActiveTab = useCallback(() => {
    setState((current) => ({ ...current, activeIndex: -1 }))
  }, [])

  const saveDraft = useCallback((sessionId: string, text: string) => {
    if (text.trim()) {
      localStorage.setItem(DRAFT_PREFIX + sessionId, text)
    } else {
      localStorage.removeItem(DRAFT_PREFIX + sessionId)
    }
  }, [])

  const loadDraft = useCallback((sessionId: string) => {
    return localStorage.getItem(DRAFT_PREFIX + sessionId) || ''
  }, [])

  const updateTabStatus = useCallback((sessionId: string, updates: Partial<ChatTab>) => {
    setState((current) => ({
      ...current,
      tabs: current.tabs.map((t) => (t.sessionId === sessionId ? { ...t, ...updates } : t)),
    }))
  }, [])

  return {
    tabs, activeTab, activeIndex,
    openTab, closeTab, switchTab, nextTab, prevTab,
    clearActiveTab, saveDraft, loadDraft, updateTabStatus,
  }
}

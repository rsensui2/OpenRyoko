"use client"

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { ThemeId } from '@/lib/themes'

interface ThemeContextValue {
  theme: ThemeId
  setTheme: (t: ThemeId) => void
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'ryoko', setTheme: () => {} })

const THEME_STORAGE_KEY = 'openryoko-theme'
const LEGACY_THEME_STORAGE_KEY = 'jinn-theme'

function readStoredTheme(): ThemeId | null {
  if (typeof window === 'undefined') return null
  const current = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null
  if (current) return current
  const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY) as ThemeId | null
  if (legacy) {
    // Migrate the legacy key to the new one and keep the legacy read for
    // other tabs that may still be on the old code
    localStorage.setItem(THEME_STORAGE_KEY, legacy)
    return legacy
  }
  return null
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>('ryoko')

  const apply = useCallback((t: ThemeId) => {
    setThemeState(t)
    localStorage.setItem(THEME_STORAGE_KEY, t)
    const el = document.documentElement
    el.removeAttribute('data-theme')
    if (t === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      el.setAttribute('data-theme', prefersDark ? 'dark' : 'ryoko')
    } else {
      el.setAttribute('data-theme', t)
    }
  }, [])

  useEffect(() => {
    const saved = readStoredTheme()
    if (saved) apply(saved)
  }, [apply])

  // React to OS color scheme changes when theme is "system"
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    function handleChange() {
      const current = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null
      if (current === 'system') {
        const el = document.documentElement
        el.setAttribute('data-theme', mq.matches ? 'dark' : 'ryoko')
      }
    }
    mq.addEventListener('change', handleChange)
    return () => mq.removeEventListener('change', handleChange)
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme: apply }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}

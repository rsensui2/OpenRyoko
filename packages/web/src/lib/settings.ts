export interface EmployeeOverride {
  emoji?: string
  profileImage?: string
}

export interface JimmySettings {
  accentColor: string | null
  portalName: string | null
  portalSubtitle: string | null
  portalEmoji: string | null
  portalIcon: string | null
  iconBgHidden: boolean
  emojiOnly: boolean
  operatorName: string | null
  language: string
  employeeOverrides: Record<string, EmployeeOverride>
}

export const DEFAULTS: JimmySettings = {
  accentColor: null,
  portalName: null,
  portalSubtitle: null,
  portalEmoji: null,
  portalIcon: null,
  iconBgHidden: false,
  emojiOnly: false,
  operatorName: null,
  language: "English",
  employeeOverrides: {},
}

const STORAGE_KEY = 'jimmy-settings'

export function loadSettings(): JimmySettings {
  if (typeof window === 'undefined') return { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: JimmySettings): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function hexToAccentFill(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},0.15)`
}

export function hexToContrastText(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  return lum > 0.4 ? '#000' : '#fff'
}

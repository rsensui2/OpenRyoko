export type ThemeId = 'dark' | 'glass' | 'color' | 'light' | 'system'

export const THEMES: { id: ThemeId; label: string; emoji: string }[] = [
  { id: 'dark',   label: 'Dark',   emoji: '🌑' },
  { id: 'glass',  label: 'Glass',  emoji: '🪟' },
  { id: 'color',  label: 'Color',  emoji: '🎨' },
  { id: 'light',  label: 'Light',  emoji: '☀️' },
  { id: 'system', label: 'System', emoji: '⚙️' },
]

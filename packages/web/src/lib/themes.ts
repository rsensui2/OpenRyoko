export type ThemeId = 'ryoko' | 'dark' | 'glass' | 'color' | 'light' | 'system'

export const THEMES: { id: ThemeId; label: string; emoji: string }[] = [
  { id: 'ryoko',  label: 'Ryoko',   emoji: '🐕' },
  { id: 'light',  label: 'ライト',   emoji: '☀️' },
  { id: 'dark',   label: 'ダーク',   emoji: '🌑' },
  { id: 'glass',  label: 'ガラス',   emoji: '🪟' },
  { id: 'color',  label: 'カラー',   emoji: '🎨' },
  { id: 'system', label: 'システム',  emoji: '⚙️' },
]

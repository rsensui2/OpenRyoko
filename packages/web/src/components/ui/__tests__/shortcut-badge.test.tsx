import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShortcutBadge } from '../shortcut-badge'

describe('ShortcutBadge', () => {
  it('renders the shortcut key text', () => {
    render(<ShortcutBadge>N</ShortcutBadge>)
    expect(screen.getByText('N')).toBeTruthy()
  })

  it('renders as a <kbd> element', () => {
    render(<ShortcutBadge>K</ShortcutBadge>)
    const el = screen.getByText('K')
    expect(el.tagName.toLowerCase()).toBe('kbd')
  })

  it('applies default styling classes', () => {
    render(<ShortcutBadge>J</ShortcutBadge>)
    const el = screen.getByText('J')
    expect(el.className).toContain('font-mono')
    expect(el.className).toContain('text-[10px]')
  })

  it('accepts additional className', () => {
    render(<ShortcutBadge className="my-custom">E</ShortcutBadge>)
    const el = screen.getByText('E')
    expect(el.className).toContain('my-custom')
  })

  it('renders compound shortcuts (multiple children)', () => {
    render(<ShortcutBadge>⌘⇧[</ShortcutBadge>)
    expect(screen.getByText('⌘⇧[')).toBeTruthy()
  })
})

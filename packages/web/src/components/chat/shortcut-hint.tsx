"use client"

interface ShortcutHintProps {
  onClick: () => void
}

export function ShortcutHint({ onClick }: ShortcutHintProps) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-3 right-3 z-30 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-tertiary)]"
    >
      <kbd className="rounded bg-[var(--fill-tertiary)] px-1 py-0.5 font-mono text-[10px] leading-none">
        ?
      </kbd>
      <span>shortcuts</span>
    </button>
  )
}

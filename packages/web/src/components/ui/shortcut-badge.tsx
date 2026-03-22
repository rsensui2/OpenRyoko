import { cn } from '@/lib/utils'

interface ShortcutBadgeProps {
  children: React.ReactNode
  className?: string
}

export function ShortcutBadge({ children, className }: ShortcutBadgeProps) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)] px-1 py-0.5 font-mono text-[10px] leading-none text-[var(--text-tertiary)]',
        className
      )}
    >
      {children}
    </kbd>
  )
}

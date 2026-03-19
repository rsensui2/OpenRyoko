"use client"

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useBreadcrumbs } from '@/context/breadcrumb-context'

export function BreadcrumbBar() {
  const { items } = useBreadcrumbs()

  if (items.length === 0) return null

  if (items.length === 1) {
    return (
      <h1 className="text-lg font-semibold text-[var(--text-primary)] tracking-tight">
        {items[0].label}
      </h1>
    )
  }

  return (
    <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight size={14} className="text-[var(--text-quaternary)]" />}
            {isLast || !item.href ? (
              <span className={isLast ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-tertiary)]'}>
                {item.label}
              </span>
            ) : (
              <Link href={item.href} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors">
                {item.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}

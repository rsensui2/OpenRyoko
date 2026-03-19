"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbContextValue {
  items: BreadcrumbItem[]
  setItems: (items: BreadcrumbItem[]) => void
}

const BreadcrumbContext = createContext<BreadcrumbContextValue>({
  items: [],
  setItems: () => {},
})

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<BreadcrumbItem[]>([])

  useEffect(() => {
    if (items.length > 0) {
      const trail = items.map(i => i.label).join(' > ')
      document.title = `${trail} - Jinn`
    }
  }, [items])

  return (
    <BreadcrumbContext.Provider value={{ items, setItems }}>
      {children}
    </BreadcrumbContext.Provider>
  )
}

export function useBreadcrumbs(items?: BreadcrumbItem[]) {
  const ctx = useContext(BreadcrumbContext)

  // Serialize items for stable dependency comparison
  const itemsKey = items ? JSON.stringify(items) : ''

  useEffect(() => {
    if (items) ctx.setItems(items)
  }, [itemsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return ctx
}

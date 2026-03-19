"use client"

import type { ReactNode } from "react"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { ThemeProvider } from "@/app/providers"
import { SettingsProvider, DocumentTitle } from "@/app/settings-provider"
import { NotificationProvider } from "@/components/notifications/notification-provider"
import { useQueryInvalidation } from '@/hooks/use-query-invalidation'
import { BreadcrumbProvider } from '@/context/breadcrumb-context'

function QueryInvalidationBridge() {
  useQueryInvalidation()
  return null
}

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BreadcrumbProvider>
          <SettingsProvider>
            <NotificationProvider>
              {children}
              <DocumentTitle />
              <QueryInvalidationBridge />
            </NotificationProvider>
          </SettingsProvider>
        </BreadcrumbProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

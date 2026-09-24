"use client"
import { PageLayout } from "@/components/page-layout"
import { ModelManagementPanel } from "@/components/settings/model-management"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
export default function ModelsPage() {
  useBreadcrumbs([{ label: "モデル設定" }])
  return <PageLayout><div className="h-full overflow-y-auto p-6"><ModelManagementPanel /></div></PageLayout>
}

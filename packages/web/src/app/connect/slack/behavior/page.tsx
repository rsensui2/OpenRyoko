"use client"

import { PageLayout } from "@/components/page-layout"
import { useSettings } from "@/app/settings-provider"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { SlackBehaviorEditor } from "@/components/onboarding/slack-behavior-editor"

export default function SlackBehaviorPage() {
  useBreadcrumbs([{ label: "設定", href: "/settings" }, { label: "Slack での振る舞い" }])
  const { settings } = useSettings()

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-[var(--space-5)] py-[var(--space-6)] flex flex-col gap-[var(--space-5)]">
          <header>
            <h1 className="m-0 text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
              Slack での振る舞い
            </h1>
            <p className="mt-[var(--space-2)] mb-0 text-[length:var(--text-body)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)]">
              {settings.portalName || "Ryoko"} がどこで、どんなときに話すかを決めます。選ぶと下に「こうなります」が出るので、確かめてから保存してください。
            </p>
          </header>
          <SlackBehaviorEditor />
        </div>
      </div>
    </PageLayout>
  )
}

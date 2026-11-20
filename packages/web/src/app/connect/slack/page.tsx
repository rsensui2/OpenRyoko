"use client"

import { PageLayout } from "@/components/page-layout"
import { useSettings } from "@/app/settings-provider"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { SlackConnectPanel } from "@/components/onboarding/slack-connect-panel"

export default function ConnectSlackPage() {
  useBreadcrumbs([{ label: "設定", href: "/settings" }, { label: "Slack につなぐ" }])
  const { settings } = useSettings()

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-[var(--space-5)] py-[var(--space-6)] flex flex-col gap-[var(--space-4)]">
          <header>
            <h1 className="m-0 text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
              Slack につなぐ
            </h1>
            <p className="mt-[var(--space-2)] mb-0 text-[length:var(--text-body)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)]">
              4 つの手順で、{settings.portalName || "Ryoko"} を Slack で話せるようにします。Slack の画面の写真を見ながら進めてください（3〜5 分ほど）。
              Slack のワークスペースにアプリを追加できる権限が必要です。
            </p>
          </header>
          <SlackConnectPanel defaultName={settings.portalName || "Ryoko"} />
        </div>
      </div>
    </PageLayout>
  )
}

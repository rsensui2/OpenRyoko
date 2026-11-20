"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { RyokoForm } from "@/components/ryokos/ryoko-form"
import { api } from "@/lib/api"

export default function NewRyokoPage() {
  useBreadcrumbs([{ label: "Ryoko たち", href: "/ryokos" }, { label: "新しい Ryoko" }])
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto">
        <div className="max-w-[680px] mx-auto px-[var(--space-5)] py-[var(--space-6)] flex flex-col gap-[var(--space-5)]">
          <header>
            <h1 className="m-0 text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">新しい Ryoko をつくる</h1>
            <p className="mt-[var(--space-2)] mb-0 text-[length:var(--text-body)] text-[var(--text-secondary)]">
              名前・人格・記憶を決めたら、次の画面で Slack につなぎます。
            </p>
          </header>
          <RyokoForm
            submitLabel="つくって、Slack につなぐ →"
            busy={busy}
            onSubmit={async (input) => {
              setBusy(true)
              setError(null)
              try {
                const { ryoko } = await api.createRyoko(input)
                router.push(`/ryokos/detail?name=${encodeURIComponent(ryoko.name)}&created=1`)
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
                setBusy(false)
              }
            }}
          />
          {error && <div className="text-[length:var(--text-footnote)] text-[var(--system-red)]">つくれませんでした: {error}</div>}
        </div>
      </div>
    </PageLayout>
  )
}

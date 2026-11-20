"use client"

import { useEffect, useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { api, type RyokoSummary } from "@/lib/api"

const MEMORY_LABEL: Record<RyokoSummary["memory"], string> = {
  main: "メインの記憶",
  shared: "記憶を共有",
  own: "専用の記憶",
}

function RyokoCard({ ryoko }: { ryoko: RyokoSummary }) {
  return (
    <a href={`/ryokos/detail?name=${encodeURIComponent(ryoko.name)}`}
      className="flex items-start gap-[var(--space-3)] p-[var(--space-4)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-regular)] no-underline">
      <span className="w-11 h-11 rounded-[12px] bg-[var(--fill-tertiary)] flex items-center justify-center text-[24px] shrink-0">{ryoko.emoji ?? "🤖"}</span>
      <span className="flex flex-col gap-1 min-w-0">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{ryoko.displayName}</span>
          {ryoko.primary && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-fill)] text-[var(--accent)]">メイン</span>}
        </span>
        {ryoko.persona && <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] line-clamp-2">{ryoko.persona}</span>}
        <span className="flex gap-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          <span>{MEMORY_LABEL[ryoko.memory]}</span>
          {ryoko.engine && <span>{ryoko.engine === "codex" ? "Codex" : "Claude"}</span>}
          <span style={{ color: ryoko.slack.connected ? "var(--system-green)" : undefined }}>{ryoko.slack.connected ? "Slack 接続済み" : "Slack 未接続"}</span>
        </span>
      </span>
    </a>
  )
}

export default function RyokosPage() {
  useBreadcrumbs([{ label: "Ryoko たち" }])
  const [ryokos, setRyokos] = useState<RyokoSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.listRyokos().then((body) => setRyokos(body.ryokos)).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-[var(--space-5)] py-[var(--space-6)] flex flex-col gap-[var(--space-4)]">
          <header className="flex items-start justify-between gap-[var(--space-3)]">
            <div>
              <h1 className="m-0 text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">Ryoko たち</h1>
              <p className="mt-[var(--space-2)] mb-0 text-[length:var(--text-body)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)]">
                人格の違う Ryoko を何体でも置けます。それぞれが自分の Slack アプリを持ち、話し方や記憶を分けられます。部下（組織）とは別で、メインの Ryoko と並ぶ存在です。
              </p>
            </div>
            <a href="/ryokos/new" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] no-underline text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] shrink-0">
              <Plus size={16} /> 新しい Ryoko
            </a>
          </header>
          {error && <div className="text-[length:var(--text-footnote)] text-[var(--system-red)]">読み込めませんでした: {error}</div>}
          {!ryokos && !error && <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]"><Loader2 size={14} className="animate-spin inline mr-1" />読み込み中…</div>}
          {ryokos?.map((ryoko) => <RyokoCard key={ryoko.name} ryoko={ryoko} />)}
        </div>
      </div>
    </PageLayout>
  )
}

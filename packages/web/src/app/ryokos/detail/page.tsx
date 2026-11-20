"use client"

/**
 * One Ryoko: who it is, its own Slack app, and how it behaves there. The main
 * Ryoko's personality lives in SOUL.md / IDENTITY.md, so for it this page only
 * links to where those settings are.
 */

import { Suspense, useEffect, useState, type ReactNode } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2, Trash2 } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { RyokoForm } from "@/components/ryokos/ryoko-form"
import { SlackConnectPanel } from "@/components/onboarding/slack-connect-panel"
import { SlackBehaviorEditor } from "@/components/onboarding/slack-behavior-editor"
import { api, type RyokoSummary } from "@/lib/api"

function Card({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-[var(--space-3)]">
      <h2 className="m-0 text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)]">{title}</h2>
      <div className="rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-4)]">{children}</div>
    </section>
  )
}

function MainRyoko({ ryoko }: { ryoko: RyokoSummary }) {
  return (
    <Card title="メインの Ryoko">
      <div className="flex flex-col gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)]">
        <p className="m-0">{ryoko.displayName} の人格は SOUL.md・IDENTITY.md、記憶は MEMORY.md にあります。チャットで「話し方をこう変えて」と頼むと、本人が書き直します。</p>
        <p className="m-0">Slack の接続と振る舞いは <a href="/settings">設定ページのいちばん上</a> で変えられます。<a href="/connect/slack">Slack につなぐ・つなぎ直す →</a></p>
      </div>
    </Card>
  )
}

function PeerRyoko({ ryoko, created, onChanged }: { ryoko: RyokoSummary; created: boolean; onChanged: (next: RyokoSummary | null) => void }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const instanceId = ryoko.slack.instanceId ?? `slack-${ryoko.name}`

  const remove = async () => {
    if (!window.confirm(`${ryoko.displayName} を削除しますか？ Slack とのつながりも外れます（専用の記憶ファイルは残ります）。`)) return
    setBusy(true)
    try {
      const result = await api.deleteRyoko(ryoko.name)
      onChanged(null)
      router.push(result.keptMemory ? "/ryokos?deleted=kept" : "/ryokos")
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) })
      setBusy(false)
    }
  }

  return (
    <>
      {created && (
        <div className="rounded-[var(--radius-md)] border border-[var(--system-green)] p-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-primary)]">
          {ryoko.displayName} をつくりました。続けて Slack につなぎましょう。
        </div>
      )}

      <Card id="slack" title="Slack">
        <SlackConnectPanel defaultName={ryoko.displayName} bot={ryoko.name} instanceId={instanceId} behaviorHref="#behavior" />
      </Card>

      {ryoko.slack.connected && (
        <Card id="behavior" title="Slack での振る舞い">
          <SlackBehaviorEditor instanceId={instanceId} />
        </Card>
      )}

      <Card title="プロフィール">
        <RyokoForm
          initial={{ displayName: ryoko.displayName, emoji: ryoko.emoji, persona: ryoko.persona, engine: ryoko.engine === "codex" ? "codex" : "claude", model: ryoko.model, memory: ryoko.memory === "own" ? "own" : "shared" }}
          submitLabel="保存"
          busy={busy}
          onSubmit={async (input) => {
            setBusy(true)
            setMessage(null)
            try {
              const { ryoko: next } = await api.updateRyoko(ryoko.name, input)
              onChanged(next)
              setMessage({ ok: true, text: "保存しました。次の会話から反映されます。" })
            } catch (err) {
              setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) })
            } finally {
              setBusy(false)
            }
          }}
        />
        {message && <div className="mt-[var(--space-2)] text-[length:var(--text-footnote)]" style={{ color: message.ok ? "var(--system-green)" : "var(--system-red)" }}>{message.text}</div>}
      </Card>

      <button type="button" onClick={remove} disabled={busy}
        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--system-red)] bg-transparent cursor-pointer text-[length:var(--text-footnote)] text-[var(--system-red)]">
        <Trash2 size={14} /> この Ryoko を削除
      </button>
    </>
  )
}

function RyokoDetail() {
  const params = useSearchParams()
  const name = params.get("name") ?? ""
  const created = params.get("created") === "1"
  const [ryoko, setRyoko] = useState<RyokoSummary | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useBreadcrumbs([{ label: "Ryoko たち", href: "/ryokos" }, { label: ryoko?.displayName ?? name }])

  useEffect(() => {
    api.listRyokos()
      .then((body) => setRyoko(body.ryokos.find((item) => item.name === name) ?? null))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [name])

  if (error) return <div className="text-[length:var(--text-footnote)] text-[var(--system-red)]">読み込めませんでした: {error}</div>
  if (ryoko === undefined) return <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]"><Loader2 size={14} className="animate-spin inline mr-1" />読み込み中…</div>
  if (ryoko === null) return <div className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">この Ryoko は見つかりませんでした。<a href="/ryokos">一覧に戻る</a></div>

  return (
    <>
      <header className="flex items-center gap-[var(--space-3)]">
        <span className="w-14 h-14 rounded-[14px] bg-[var(--fill-tertiary)] flex items-center justify-center text-[30px]">{ryoko.emoji ?? "🤖"}</span>
        <h1 className="m-0 text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">{ryoko.displayName}</h1>
      </header>
      {ryoko.primary ? <MainRyoko ryoko={ryoko} /> : <PeerRyoko ryoko={ryoko} created={created} onChanged={(next) => setRyoko(next)} />}
    </>
  )
}

export default function RyokoDetailPage() {
  return (
    <PageLayout>
      <div className="h-full overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-[var(--space-5)] py-[var(--space-6)] flex flex-col gap-[var(--space-5)]">
          <Suspense fallback={null}>
            <RyokoDetail />
          </Suspense>
        </div>
      </div>
    </PageLayout>
  )
}

"use client"

import { useEffect, useState } from "react"
import { api, type ModelManagementStatus } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const control = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
const modeLabels = { auto: "おすすめに自動追従", notify: "通知して選ぶ", fixed: "特定モデルに固定" }
const profileLabels = { economy: "節約", balanced: "バランス", performance: "性能優先" }

export function ModelManagementPanel() {
  const [data, setData] = useState<ModelManagementStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [filter, setFilter] = useState("")
  const [channel, setChannel] = useState("")
  const [connector, setConnector] = useState("slack")
  const [selected, setSelected] = useState<string[]>([])
  useEffect(() => {
    let active = true
    api.getModels().then(value => { if (active) { setData(value); setChannel(value.notification?.channel ?? ""); setConnector(value.notification?.connector ?? "slack") } }).catch(err => { if (active) setError(err.message) })
    return () => { active = false }
  }, [])
  async function act(action: unknown) {
    setBusy(true); setError(""); setNotice("")
    try { setData(await api.modelAction(action)); setNotice("設定を保存しました。既定の変更は新規会話から適用します。") }
    catch (err) { setError(err instanceof Error ? err.message : "変更を保存できませんでした。") }
    finally { setBusy(false) }
  }
  async function inheritSelected() {
    setBusy(true); setError(""); setNotice("")
    let completed = 0
    try {
      for (const pin of data?.pins ?? []) {
        if (!selected.includes(`${pin.kind}:${pin.id}`)) continue
        setData(await api.modelAction({ action: "pin", kind: pin.kind, id: pin.id, model: null })); completed++
      }
      setSelected([]); setNotice(`${completed}件の固定を解除しました。`)
    } catch (err) { setError(`${completed}件を保存済み。${err instanceof Error ? err.message : "保存に失敗しました。"}`) }
    finally { setBusy(false) }
  }
  const visiblePins = data?.pins.filter(p => `${p.name} ${p.engine} ${p.effective}`.toLowerCase().includes(filter.toLowerCase())) ?? []
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-balance text-2xl font-semibold">モデルと更新方針</h1><p className="mt-2 text-pretty text-sm text-muted-foreground">使えるモデルをCLIから取得します。一覧は起動時と6時間ごとに更新されます。</p></div>
      <Button disabled={busy} variant="outline" onClick={() => act({ action: "refresh" })}>{busy ? "処理中…" : "モデル一覧を更新"}</Button>
    </div>
    {error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!data ? <div aria-busy="true" className="rounded-lg border p-6 text-muted-foreground">{error ? "一覧を更新して再試行してください。" : "モデル設定を読み込んでいます…"}</div> : <>
      <div className="grid gap-4 lg:grid-cols-2">
        {data.engines.map(entry => <section key={entry.engine} className="space-y-4 rounded-lg border border-border p-5">
          <h2 className="text-balance text-lg font-semibold">{entry.engine === "codex" ? "Codex" : "Claude"}</h2>
          <p className="break-all text-sm">現在の既定：<strong>{entry.current}</strong></p>
          <label className="block space-y-1 text-sm"><span>更新方針</span><select className={control} disabled={busy} value={entry.policy.mode} onChange={e => act({ action: "policy", engine: entry.engine, policy: { ...entry.policy, mode: e.target.value } })}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="block space-y-1 text-sm"><span>重視すること</span><select className={control} disabled={busy} value={entry.policy.profile} onChange={e => act({ action: "policy", engine: entry.engine, policy: { ...entry.policy, profile: e.target.value } })}>{Object.entries(profileLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="block space-y-1 text-sm"><span>モデルを選んで固定する</span><select className={control} disabled={busy || Boolean(entry.error)} value={entry.current} onChange={e => act({ action: "default", engine: entry.engine, model: e.target.value })}>
            {!entry.models.some(m => m.id === entry.current) && <option value={entry.current}>{entry.current}</option>}
            {entry.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select></label>
          {entry.error && <p className="text-pretty text-sm text-muted-foreground">{entry.error}</p>}
          <p className="text-xs text-muted-foreground tabular-nums">一覧の取得：{entry.checkedAt ? new Date(entry.checkedAt).toLocaleString() : "未取得"}。候補の表示は実際の回答成功を保証するものではありません。</p>
          {entry.candidate && entry.candidate !== entry.current && <div className="space-y-2 rounded-md bg-muted p-3"><p className="break-all text-sm">推奨候補：{entry.candidate}</p><Button disabled={busy} onClick={() => act({ action: "accept", engine: entry.engine, model: entry.candidate })}>推奨モデルに切り替える</Button></div>}
          {!entry.candidate && !entry.error && <p className="text-sm text-muted-foreground">この用途の推奨候補がないため、現在の既定を維持します。</p>}
          {entry.previous && <Button variant="outline" disabled={busy} onClick={() => act({ action: "rollback", engine: entry.engine })}>以前のモデルに戻して固定する</Button>}
        </section>)}
      </div>
      <section className="space-y-4 rounded-lg border border-border p-5">
        <h2 className="text-balance text-lg font-semibold">Slackで設定・通知</h2>
        <p className="text-pretty text-sm text-muted-foreground">Slackで「@Ryoko モデル設定」と送ると、ボタンで変更できます。通知先を空欄にすると通知を停止します。</p>
        {!data.slackAdminConfigured && <p className="text-sm text-destructive">Slack操作には、設定画面の管理者Slack ID（operatorSlackId）の登録が必要です。</p>}
        <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span>接続名</span><input className={control} value={connector} onChange={e => setConnector(e.target.value)} placeholder="slack" /></label><label className="space-y-1 text-sm"><span>通知先チャンネルID</span><input className={control} value={channel} onChange={e => setChannel(e.target.value)} placeholder="C0123456789" /></label></div>
        <Button disabled={busy || !connector.trim()} variant="outline" onClick={() => act({ action: "notification", connector: connector.trim(), channel: channel.trim() })}>通知先を保存</Button>
      </section>
      <section className="space-y-4 rounded-lg border border-border p-5">
        <h2 className="text-balance text-lg font-semibold">社員・定期実行のモデル</h2>
        <p className="text-pretty text-sm text-muted-foreground">固定を解除すると親設定を継承します。社員に紐づく定期実行は社員の指定が優先されます。既存の会話は維持します。</p>
        <div className="flex flex-wrap gap-3"><input aria-label="対象を検索" className={cn(control, "sm:max-w-sm")} placeholder="名前・モデルで検索" value={filter} onChange={e => setFilter(e.target.value)} /><Button variant="outline" disabled={busy || !selected.length} onClick={inheritSelected}>選択した{selected.length}件の固定を解除</Button></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">モデルの固定と継承の一覧</caption><thead><tr className="border-b"><th className="p-2">選択</th><th className="p-2">対象</th><th className="p-2">適用されるモデル</th><th className="p-2">設定</th></tr></thead><tbody>{visiblePins.map(pin => {
          const key = `${pin.kind}:${pin.id}`, engine = data.engines.find(e => e.engine === pin.engine)
          return <tr key={key} className="border-b"><td className="p-2"><input type="checkbox" aria-label={`${pin.name}を選択`} disabled={busy || !pin.model} checked={selected.includes(key)} onChange={e => setSelected(values => e.target.checked ? [...values, key] : values.filter(v => v !== key))} /></td><td className="p-2"><span>{pin.name}</span><span className="block text-xs text-muted-foreground">{pin.kind === "employee" ? "社員" : "定期実行"} · {pin.engine}{pin.remote ? " · リモート" : ""}</span></td><td className="p-2"><span className="break-all">{pin.effective}</span><span className="block text-xs text-muted-foreground">{pin.model ? "固定" : pin.inheritedFrom?.startsWith("employee:") ? "社員の設定を継承" : "既定を継承"}</span></td><td className="p-2"><select aria-label={`${pin.name}のモデル`} className={control} disabled={busy} value={pin.model ?? ""} onChange={e => act({ action: "pin", kind: pin.kind, id: pin.id, model: e.target.value || null })}><option value="">固定を解除して継承</option>{pin.model && !engine?.models.some(m => m.id === pin.model) && <option value={pin.model}>{pin.model}</option>}{engine?.models.map(m => <option key={m.id} value={m.id} disabled={pin.remote || Boolean(engine.error)}>{m.label}</option>)}</select></td></tr>
        })}</tbody></table></div>
        {!visiblePins.length && <p className="text-sm text-muted-foreground">該当する社員・定期実行はありません。</p>}
      </section>
      <p className="text-pretty text-sm text-muted-foreground">CLIやRyoko本体の更新が必要な場合は既存の更新機能で対応します。モデルの自動追従は、CLI・本体の自動インストールとは別の設定です。</p>
    </>}
  </div>
}

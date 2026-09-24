"use client"

import { useEffect, useState } from "react"
import { api, type ModelManagementStatus } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const control = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
const modeLabels = { auto: "選んだ系列に自動追従", notify: "通知して選ぶ", fixed: "特定モデルに固定" }
const profileLabels = { economy: "節約", balanced: "バランス", performance: "性能優先" }

const depths: Record<string, string> = { low: "軽く", medium: "標準", high: "じっくり", xhigh: "深く", max: "最大" }
function DepthPicker({ label, levels, value, disabled, onChange }: { label: string; levels: string[]; value?: string | null; disabled: boolean; onChange: (value: string) => void }) {
  return <fieldset className="space-y-2"><legend className="text-sm font-medium">{label}</legend>
    <div className="flex flex-wrap gap-2">{levels.map((level, index) => <button key={level} type="button" aria-pressed={value === level} disabled={disabled} onClick={() => onChange(level)} className={cn("min-h-11 rounded-lg border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", value === level ? "border-primary bg-primary/10 text-foreground" : "border-border hover:bg-muted")}>
      <span aria-hidden="true" className="mb-1 flex gap-1">{levels.map((_, step) => <span key={step} className={cn("h-1 w-3 rounded-full", step <= index ? "bg-primary" : "bg-muted")} />)}</span>{depths[level] ?? level}
    </button>)}</div>
    <p className="text-xs text-muted-foreground">{levels.length ? "深く考える設定ほど、時間や利用枠を多く使う場合があります。" : "このモデルには考える深さの設定がありません。"}</p>
  </fieldset>
}

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
      <div><h1 className="text-balance text-2xl font-semibold">モデル編成</h1><p className="mt-2 text-pretty text-sm text-muted-foreground">主担当の系列・考える深さ・代役を選びます。選んだ系列の最新版を、起動時と6時間ごとに確認します。</p></div>
      <Button disabled={busy} variant="outline" onClick={() => act({ action: "refresh" })}>{busy ? "処理中…" : "モデル一覧を更新"}</Button>
    </div>
    {error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!data ? <div aria-busy="true" className="rounded-lg border p-6 text-muted-foreground">{error ? "一覧を更新して再試行してください。" : "モデル設定を読み込んでいます…"}</div> : <>
      <div className="grid gap-4 lg:grid-cols-2">
        {data.engines.map(entry => <section key={entry.engine} className="space-y-5 rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3"><h2 className="text-balance text-xl font-semibold">{entry.engine === "codex" ? "Codex" : "Claude"}</h2><span className="rounded-full bg-muted px-3 py-1 text-xs">{entry.policy.mode === "auto" ? "自動追従中" : entry.policy.mode === "notify" ? "更新は通知で確認" : "モデル固定中"}</span></div>
          <fieldset className="space-y-2"><legend className="text-sm font-medium">01 主担当の系列</legend><div className="grid grid-cols-2 gap-2">{entry.families?.map(f => <button type="button" key={f.family} aria-label={`${entry.engine} ${f.label} の最新版に追従`} disabled={busy || Boolean(entry.error)} aria-pressed={(entry.policy.family ?? entry.families?.find(v => v.model === entry.candidate)?.family) === f.family && entry.policy.mode !== "fixed"} onClick={() => act({ action: "policy", engine: entry.engine, policy: { ...entry.policy, family: f.family, mode: "auto" } })} className={cn("min-h-20 rounded-xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", (entry.policy.family ?? entry.families?.find(v => v.model === entry.candidate)?.family) === f.family && entry.policy.mode !== "fixed" ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}><span className="block font-semibold">{f.label}</span><span className="mt-1 block break-all font-mono text-xs text-muted-foreground">{f.model}</span></button>)}</div></fieldset>
          <p className="break-all text-sm">現在の既定：<strong>{entry.current}</strong></p>
          <label className="block space-y-1 text-sm"><span>更新方針</span><select className={control} disabled={busy} value={entry.policy.mode} onChange={e => act({ action: "policy", engine: entry.engine, policy: { ...entry.policy, mode: e.target.value } })}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <DepthPicker label="02 考える深さ" levels={entry.models.find(m => m.id === entry.current)?.effortLevels ?? []} value={entry.effort} disabled={busy || Boolean(entry.error)} onChange={effort => act({ action: "default-effort", engine: entry.engine, effort })} />
          <div className="rounded-xl bg-muted p-4"><p className="text-sm font-medium">03 使えない時の代役</p><p className="mt-1 break-all font-mono text-sm">{data.fallbackEnabled ? `${entry.engine === "codex" ? "Claude" : "Codex"} → ${entry.fallback}` : "自動切替は停止中"}</p><p className="mt-2 text-xs text-muted-foreground">代役の組み合わせは下の「障害時の切替」で変更できます。</p></div>
          <details className="space-y-3"><summary className="cursor-pointer text-sm text-muted-foreground">詳細：固定モデル・従来の用途設定</summary>
          <label className="block space-y-1 text-sm"><span>重視すること</span><select className={control} disabled={busy} value={entry.policy.profile} onChange={e => act({ action: "policy", engine: entry.engine, policy: { mode: entry.policy.mode, profile: e.target.value, effort: entry.policy.effort } })}>{Object.entries(profileLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="block space-y-1 text-sm"><span>モデルを選んで固定する</span><select className={control} disabled={busy || Boolean(entry.error)} value={entry.current} onChange={e => act({ action: "default", engine: entry.engine, model: e.target.value })}>
            {!entry.models.some(m => m.id === entry.current) && <option value={entry.current}>{entry.current}</option>}
            {entry.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select></label></details>
          {entry.error && <p className="text-pretty text-sm text-muted-foreground">{entry.error}</p>}
          <p className="text-xs text-muted-foreground tabular-nums">一覧の取得：{entry.checkedAt ? new Date(entry.checkedAt).toLocaleString() : "未取得"}。候補の表示は実際の回答成功を保証するものではありません。</p>
          {entry.candidate && entry.candidate !== entry.current && <div className="space-y-2 rounded-md bg-muted p-3"><p className="break-all text-sm">推奨候補：{entry.candidate}</p><Button disabled={busy} onClick={() => act({ action: "accept", engine: entry.engine, model: entry.candidate })}>推奨モデルに切り替える</Button></div>}
          {!entry.candidate && !entry.error && <p className="text-sm text-muted-foreground">この用途の推奨候補がないため、現在の既定を維持します。</p>}
          {entry.previous && <Button variant="outline" disabled={busy} onClick={() => act({ action: "rollback", engine: entry.engine })}>以前のモデルに戻して固定する</Button>}
        </section>)}
      </div>
      <section className="space-y-4 rounded-2xl border border-border p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">障害時の切替</h2><p className="mt-1 text-sm text-muted-foreground">利用上限・無応答・タイムアウト時、別の会社のモデルへ引き継ぎます。</p></div><Button variant={data.fallbackEnabled ? "default" : "outline"} disabled={busy} aria-pressed={Boolean(data.fallbackEnabled)} onClick={() => act({ action: "fallback", enabled: !data.fallbackEnabled })}>{data.fallbackEnabled ? "自動切替 ON" : "自動切替 OFF"}</Button></div>
        <p className="text-sm text-muted-foreground">代役も選んだ系列の最新版を使います。各社の性能・料金は同等とは限りません。未対応の深さは代役で使える値に調整します。個別のモデルID対応表がある場合は、そちらを優先します。ワークフロー独自の切替指定は個別設定で管理します。</p>
        <div className="grid gap-4 lg:grid-cols-2">{data.engines.map(entry => {
          const other = data.engines.find(e => e.engine !== entry.engine)
          return <fieldset key={entry.engine} className="space-y-3 rounded-xl bg-muted/50 p-4"><legend className="px-1 text-sm font-semibold">{entry.engine} → {other?.engine ?? "代役"}</legend>{entry.families?.map(f => <label key={f.family} className="grid grid-cols-[5rem_1fr] items-center gap-3 text-sm"><span>{f.label} →</span><select aria-label={`${entry.engine} ${f.label}の代役`} className={control} value={entry.fallbackFamilies?.[f.family] ?? ""} disabled={busy || Boolean(other?.error)} onChange={e => act({ action: "fallback-family", engine: entry.engine, family: f.family, targetFamily: e.target.value || null })}><option value="">代役側の既定</option>{entry.fallbackFamilies?.[f.family] && !other?.families?.some(v => v.family === entry.fallbackFamilies?.[f.family]) && <option value={entry.fallbackFamilies[f.family]}>{entry.fallbackFamilies[f.family]}（未取得・既定を使用）</option>}{other?.families?.map(v => <option key={v.family} value={v.family}>{v.label} · {v.model}</option>)}</select></label>)}</fieldset>
        })}</div>
      </section>
      <section className="space-y-4 rounded-lg border border-border p-5">
        <h2 className="text-balance text-lg font-semibold">Slackで設定・通知</h2>
        <p className="text-pretty text-sm text-muted-foreground">Slackで「@Ryoko モデル設定」と送ると、ボタンで変更できます。通知先を空欄にすると通知を停止します。</p>
        {!data.slackAdminConfigured && <p className="text-sm text-destructive">Slack操作には、設定画面の管理者Slack ID（operatorSlackId）の登録が必要です。</p>}
        <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span>接続名</span><input className={control} value={connector} onChange={e => setConnector(e.target.value)} placeholder="slack" /></label><label className="space-y-1 text-sm"><span>通知先チャンネルID</span><input className={control} value={channel} onChange={e => setChannel(e.target.value)} placeholder="C0123456789" /></label></div>
        <Button disabled={busy || !connector.trim()} variant="outline" onClick={() => act({ action: "notification", connector: connector.trim(), channel: channel.trim() })}>通知先を保存</Button>
      </section>
      <section className="space-y-4 rounded-lg border border-border p-5">
        <h2 className="text-balance text-lg font-semibold">タスクごとの編成</h2>
        <p className="text-pretty text-sm text-muted-foreground">社員・定期実行・ワークフローの系列と深さを選べます。「継承」は親設定に従います。変更は今後の実行に適用します。</p>
        <div className="flex flex-wrap gap-3"><input aria-label="対象を検索" className={cn(control, "sm:max-w-sm")} placeholder="名前・モデルで検索" value={filter} onChange={e => setFilter(e.target.value)} /><Button variant="outline" disabled={busy || !selected.length} onClick={inheritSelected}>選択した{selected.length}件の固定を解除</Button></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">モデルの固定と継承の一覧</caption><thead><tr className="border-b"><th className="p-2">選択</th><th className="p-2">対象</th><th className="p-2">適用されるモデル</th><th className="p-2">系列・固定</th><th className="p-2">考える深さ</th></tr></thead><tbody>{visiblePins.map(pin => {
          const key = `${pin.kind}:${pin.id}`, engine = data.engines.find(e => e.engine === pin.engine)
          return <tr key={key} className="border-b"><td className="p-2"><input type="checkbox" aria-label={`${pin.name}を選択`} disabled={busy || !pin.model || pin.remote} checked={selected.includes(key)} onChange={e => setSelected(values => e.target.checked ? [...values, key] : values.filter(v => v !== key))} /></td><td className="p-2"><span>{pin.name}</span><span className="block text-xs text-muted-foreground">{pin.kind === "employee" ? "社員" : pin.kind === "workflow" ? "ワークフロー" : "定期実行"} · {pin.engine}{pin.remote ? ` · ${pin.unmanagedReason ?? "リモート"}` : ""}</span></td><td className="p-2"><span className="break-all">{pin.effective}</span><span className="block text-xs text-muted-foreground">{pin.followPaused ? "追従停止：個別設定が変更されました" : pin.family ? `${pin.family} の最新版に追従` : pin.model ? "固定" : pin.inheritedFrom?.startsWith("employee:") ? "社員の設定を継承" : "既定を継承"}</span></td><td className="p-2"><select aria-label={`${pin.name}のモデル`} className={control} disabled={busy || pin.remote} value={pin.family ? `family:${pin.family}` : pin.model ?? ""} onChange={e => act(e.target.value.startsWith("family:") ? { action: "follow", kind: pin.kind, id: pin.id, family: e.target.value.slice(7) } : { action: "pin", kind: pin.kind, id: pin.id, model: e.target.value || null })}><option value="">親設定を継承</option>{engine?.families?.map(f => <option key={f.family} value={`family:${f.family}`} disabled={Boolean(engine.error)}>{f.label} の最新版に追従</option>)}{pin.model && !engine?.models.some(m => m.id === pin.model) && <option value={pin.model}>{pin.model}</option>}{engine?.models.map(m => <option key={m.id} value={m.id} disabled={pin.remote || Boolean(engine.error)}>{m.label} に固定</option>)}</select></td><td className="p-2"><select aria-label={`${pin.name}の考える深さ`} className={control} value={pin.effort ?? ""} disabled={busy || pin.remote || Boolean(engine?.error)} onChange={e => act({ action: "effort", kind: pin.kind, id: pin.id, effort: e.target.value || null })}><option value="">親設定を継承</option>{pin.effort && !engine?.models.find(m => m.id === pin.effective)?.effortLevels.includes(pin.effort) && <option value={pin.effort}>{depths[pin.effort] ?? pin.effort}（設定済み）</option>}{engine?.models.find(m => m.id === pin.effective)?.effortLevels.map(level => <option key={level} value={level}>{depths[level] ?? level}</option>)}</select></td></tr>
        })}</tbody></table></div>
        {!visiblePins.length && <p className="text-sm text-muted-foreground">該当する社員・定期実行はありません。</p>}
      </section>
      <p className="text-pretty text-sm text-muted-foreground">CLIやRyoko本体の更新が必要な場合は既存の更新機能で対応します。モデルの自動追従は、CLI・本体の自動インストールとは別の設定です。</p>
    </>}
  </div>
}

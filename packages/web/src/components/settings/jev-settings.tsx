"use client"

import { useEffect, useId, useState, type ReactNode } from "react"
import { api, type TypeSafeKeyStatus } from "@/lib/api"
import { TRIAGE_MODEL_VENDORS, defaultTriageModelForEngine, type TriageModelEngine } from "@/lib/model-catalog"
import { triageMode, withTriageMode, type SlackTriageSettings, type TriageMode } from "@/lib/triage-settings"
import { ModelSelector } from "./model-selector"

const keyStatusChanged = "typesafe-key-status-changed"
const controlClass = "w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
const buttonClass = "px-[10px] py-[6px] border border-[var(--separator)] rounded-[var(--radius-sm)] text-[length:var(--text-footnote)] text-[var(--text-primary)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
const helpClass = "text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"

const modeDescriptions: Record<TriageMode, string> = {
  cli: "既存の CLI モデルで反応を判定します。",
  jev: "Jev で判定します。判断が難しい場合や API 障害時も判定用の CLI は起動しません。",
  "jev-fallback": "Jev で判断が難しい場合や API 障害時は、下の CLI モデルで再判定します。",
  "jev-shadow": "Jev と CLI の判定を比較します。実際の反応は CLI が決めます。",
}

const testErrors: Record<string, string> = {
  missing_key: "API キーが未設定です。",
  unauthorized: "API キーを認証できませんでした。",
  rate_limited: "利用制限に達しました。時間をおいて再試行してください。",
  timeout: "接続がタイムアウトしました。",
  busy: "別の接続テストが実行中です。少し待って再試行してください。",
  provider_error: "TypeSafe 側でエラーが発生しました。",
  network_error: "TypeSafe に接続できませんでした。",
  invalid_response: "TypeSafe の応答を確認できませんでした。",
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)] py-[var(--space-2)]">
    <label htmlFor={id} className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">{label}</label>
    <div className="w-[240px] max-w-full">{children}</div>
  </div>
}

interface JevSettingsProps {
  config?: SlackTriageSettings
  onChange: (config: SlackTriageSettings) => void
  /** All Slack instances use the gateway's shared TypeSafe credential. */
  showCredentials?: boolean
}

export function JevSettings({ config = {}, onChange, showCredentials = true }: JevSettingsProps) {
  const id = useId()
  const mode = triageMode(config)
  const native = mode !== "cli"
  const useCapabilities = config.jev?.useCapabilities !== false
  const showCli = mode !== "jev"
  const [keyStatus, setKeyStatus] = useState<TypeSafeKeyStatus | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState<"save" | "delete" | "test" | null>(null)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const [statusError, setStatusError] = useState(false)

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void api.getTypeSafeKeyStatus().then((status) => {
        if (mounted) { setKeyStatus(status); setStatusError(false) }
      }, () => {
        if (mounted) { setKeyStatus(null); setStatusError(true) }
      })
    }
    refresh()
    window.addEventListener(keyStatusChanged, refresh)
    return () => { mounted = false; window.removeEventListener(keyStatusChanged, refresh) }
  }, [])

  async function saveKey() {
    const value = apiKey.trim()
    if (!value || busy) return
    setApiKey("")
    setBusy("save")
    setFeedback(null)
    try {
      const status = await api.saveTypeSafeKey(value)
      setKeyStatus(status)
      setStatusError(false)
      setFeedback({ error: false, text: "API キーを保存しました。" })
      window.dispatchEvent(new Event(keyStatusChanged))
    } catch {
      setFeedback({ error: true, text: "API キーを保存できませんでした。入力内容と接続を確認してください。" })
    } finally { setBusy(null) }
  }

  async function deleteKey() {
    if (busy) return
    setApiKey("")
    setBusy("delete")
    setFeedback(null)
    try {
      const status = await api.deleteTypeSafeKey()
      setKeyStatus(status)
      setStatusError(false)
      setFeedback({ error: false, text: status.configured ? "保存したキーを削除しました。環境変数のキーを使用します。" : "保存した API キーを削除しました。" })
      window.dispatchEvent(new Event(keyStatusChanged))
    } catch {
      setFeedback({ error: true, text: "API キーを削除できませんでした。" })
    } finally { setBusy(null) }
  }

  async function testKey() {
    if (busy || !keyStatus?.configured) return
    setBusy("test")
    setFeedback(null)
    try {
      const result = await api.testTypeSafeKey()
      const elapsed = typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs) && result.latencyMs >= 0
        ? `（${Math.round(result.latencyMs)} ms）` : ""
      setFeedback(result.ok
        ? { error: false, text: `接続を確認しました${elapsed}。` }
        : { error: true, text: testErrors[result.error ?? ""] ?? "接続を確認できませんでした。" })
    } catch {
      setFeedback({ error: true, text: "接続を確認できませんでした。" })
    } finally { setBusy(null) }
  }

  const cliLabel = mode === "jev-shadow" ? "比較に使う CLI モデル" : mode === "jev-fallback" ? "再判定に使う CLI モデル" : "CLI モデル"

  return <div className="space-y-[var(--space-2)]">
    <Field label="空気読みを有効化" id={`${id}-enabled`}>
      <button type="button" id={`${id}-enabled`} role="switch" aria-checked={config.enabled ?? false}
        disabled={!config.enabled && native && !keyStatus?.configured}
        onClick={() => onChange({ ...config, enabled: !config.enabled })}
        className="relative block ml-auto w-[44px] h-[24px] rounded-[12px] border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: config.enabled ? "var(--system-green)" : "var(--fill-primary)" }}>
        <span className="absolute top-[2px] w-[20px] h-[20px] rounded-full bg-white" style={{ left: config.enabled ? 22 : 2 }} />
      </button>
    </Field>
    <Field label="判定方式" id={`${id}-mode`}>
      <select id={`${id}-mode`} value={mode} aria-describedby={`${id}-mode-help`}
        onChange={(event) => onChange(withTriageMode(config, event.target.value as TriageMode))} className={controlClass}>
        <option value="cli">CLI（従来方式）</option>
        <option value="jev" disabled={!keyStatus?.configured}>Jev のみ</option>
        <option value="jev-fallback" disabled={!keyStatus?.configured}>Jev + CLI 再判定</option>
        <option value="jev-shadow" disabled={!keyStatus?.configured}>比較（実際の判定は CLI）</option>
      </select>
    </Field>
    <p id={`${id}-mode-help`} className={helpClass}>{modeDescriptions[mode]}方式の変更は、ページ下部の「設定を保存」で反映されます。</p>

    {showCredentials ? <div className="space-y-[var(--space-2)] border-t border-[var(--separator)] pt-[var(--space-3)]">
      <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">TypeSafe API キー：{statusError ? "状態を取得できません" : !keyStatus ? "確認中…" : keyStatus.source === "stored" ? "保存済み" : keyStatus.source === "environment" ? "環境変数で設定済み" : "未設定"}</p>
      <p className={helpClass}>Jev の利用には API キーが必要です。キーはこの画面から保存でき、保存後は表示されません。すべての Slack インスタンスで共有します。</p>
      <label htmlFor={`${id}-key`} className="block text-[length:var(--text-footnote)] text-[var(--text-secondary)]">{keyStatus?.configured ? "新しい API キー" : "API キー"}</label>
      <input id={`${id}-key`} type="password" autoComplete="new-password" spellCheck={false}
        value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={busy !== null}
        placeholder={keyStatus?.configured ? "変更する場合だけ入力" : "TypeSafe の API キーを入力"} className={controlClass} />
      <div className="flex flex-wrap gap-[var(--space-2)]">
        <button type="button" onClick={() => void saveKey()} disabled={busy !== null || !apiKey.trim()} className={buttonClass}>{busy === "save" ? "保存中…" : "API キーを保存"}</button>
        <button type="button" onClick={() => void testKey()} disabled={busy !== null || !keyStatus?.configured || !!apiKey.trim()} className={buttonClass}>{busy === "test" ? "接続テスト中…" : "保存済みキーで接続テスト"}</button>
        {keyStatus?.source === "stored" && <button type="button" onClick={() => void deleteKey()} disabled={busy !== null} className={buttonClass}>保存したキーを削除</button>}
      </div>
      <p className={helpClass}>キーの保存・削除はすぐに反映されます。接続テストには固定のサンプル文を使います。</p>
      {feedback && <p role={feedback.error ? "alert" : "status"} className="text-[length:var(--text-footnote)]" style={{ color: feedback.error ? "var(--system-red)" : "var(--system-green)" }}>{feedback.text}</p>}
    </div> : <p className={helpClass}>TypeSafe API キーは上の Slack 設定で管理します。{keyStatus?.configured ? "設定済みです。" : "キーを保存すると Jev を選択できます。"}</p>}

    {native && keyStatus?.configured === false && <p role="alert" className="text-[length:var(--text-footnote)] text-[var(--system-red)]">Jev を使うには、先に API キーを保存してください。</p>}
    {native && <Field label="Jev タイムアウト (ms)" id={`${id}-jev-timeout`}>
      <input id={`${id}-jev-timeout`} type="number" min={1} max={10000} value={config.jev?.timeoutMs ?? ""} placeholder="3000"
        onChange={(event) => onChange({ ...config, jev: { ...config.jev, timeoutMs: event.target.value ? Number(event.target.value) : undefined } })} className={controlClass} />
    </Field>}
    {native && <>
      <Field label="スキル・担当領域を考慮" id={`${id}-capabilities`}>
        <button type="button" id={`${id}-capabilities`} role="switch" aria-checked={useCapabilities}
          aria-describedby={`${id}-capabilities-help`}
          onClick={() => onChange({ ...config, jev: { ...config.jev, useCapabilities: !useCapabilities } })}
          className="relative block ml-auto w-[44px] h-[24px] rounded-[12px] border-none cursor-pointer"
          style={{ background: useCapabilities ? "var(--system-green)" : "var(--fill-primary)" }}>
          <span className="absolute top-[2px] w-[20px] h-[20px] rounded-full bg-white" style={{ left: useCapabilities ? 22 : 2 }} />
        </button>
      </Field>
      <p id={`${id}-capabilities-help`} className={helpClass}>担当社員の役割と利用可能なスキルから、具体的に手伝える依頼かを判断します。人宛ての会話や雑談には割り込みません。</p>
    </>}

    {showCli && <div className="border-t border-[var(--separator)] pt-[var(--space-3)]">
      <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">{cliLabel}</p>
      <Field label="モデルのベンダー" id={`${id}-vendor`}>
        <select id={`${id}-vendor`} value={config.engine ?? "codex"} className={controlClass} onChange={(event) => {
          const engine = event.target.value as TriageModelEngine
          onChange({ ...config, engine, model: defaultTriageModelForEngine(engine) })
        }}>{TRIAGE_MODEL_VENDORS.map((vendor) => <option key={vendor.value} value={vendor.value}>{vendor.label}</option>)}</select>
      </Field>
      <Field label="モデル" id={`${id}-model`}>
        <ModelSelector id={`${id}-model`} engine={config.engine ?? "codex"} model={config.model ?? undefined} allowAutomatic onChange={(model) => onChange({ ...config, model: model ?? null })} />
      </Field>
      <Field label="CLI タイムアウト (ms)" id={`${id}-cli-timeout`}>
        <input id={`${id}-cli-timeout`} type="number" min={1} value={config.timeoutMs ?? ""} placeholder="30000" className={controlClass}
          onChange={(event) => onChange({ ...config, timeoutMs: event.target.value ? Number(event.target.value) : undefined })} />
      </Field>
      <Field label="CLI パス（任意）" id={`${id}-bin`}>
        <input id={`${id}-bin`} value={config.bin ?? ""} placeholder={config.engine ?? "codex"} className={controlClass}
          onChange={(event) => onChange({ ...config, bin: event.target.value.trim() || undefined })} />
      </Field>
    </div>}

    <Field label="スレッド文脈の取得件数" id={`${id}-context`}>
      <input id={`${id}-context`} type="number" min={1} max={10} value={config.threadContextLimit ?? ""} placeholder="10" className={controlClass}
        onChange={(event) => onChange({ ...config, threadContextLimit: event.target.value ? Number(event.target.value) : undefined })} />
    </Field>
    <Field label="ペルソナ（任意）" id={`${id}-persona`}>
      <input id={`${id}-persona`} value={config.persona ?? ""} placeholder="このボットの得意分野" className={controlClass}
        onChange={(event) => onChange({ ...config, persona: event.target.value || undefined })} />
    </Field>
  </div>
}

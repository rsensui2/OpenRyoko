"use client"

/**
 * "How should air-reading decide?" — the engine already in use (no key), a
 * decision model behind an API key (Jev at TypeSafe or OpenRouter, or the
 * OpenAI Decisions API), or one running on this machine. Keys are saved and
 * tested right here; they go to the gateway's private credential store, never
 * into config.yaml.
 */

import { useEffect, useState, type ReactNode } from "react"
import { Check, ExternalLink, Loader2 } from "lucide-react"
import { api, type TypeSafeKeyStatus, type TypeSafeTestResult } from "@/lib/api"
import {
  DEFAULT_LOCAL_ENDPOINT, DEFAULT_LOCAL_MODEL, PROVIDER_INFO, isLoopbackDecisionEndpoint,
  type AirReading, type CliEngine, type DecisionProvider,
} from "@/lib/air-reading"

const TEST_ERRORS: Record<NonNullable<TypeSafeTestResult["error"]>, string> = {
  missing_key: "キーがまだ保存されていません。",
  unauthorized: "キーが受け付けられませんでした。貼り間違いか、権限のないキーです。",
  rate_limited: "回数の上限に当たりました。少し待ってから試してください。",
  provider_error: "相手のサービスがエラーを返しました。",
  network_error: "つながりませんでした。ネットワークを確かめてください。",
  timeout: "時間内に返事がありませんでした。",
  invalid_response: "返事の形が想定と違いました。",
  busy: "別のテストが実行中です。",
}

const smallButton = "px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--separator)] bg-transparent cursor-pointer text-[length:var(--text-footnote)] text-[var(--text-primary)] disabled:opacity-50"

function Option({ on, onPick, title, hint, children }: { on: boolean; onPick: () => void; title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] border p-[var(--space-3)] flex flex-col gap-[var(--space-2)]"
      style={{ borderColor: on ? "var(--accent)" : "var(--separator)", background: on ? "var(--accent-fill)" : "transparent" }}>
      <label className="flex items-start gap-[var(--space-2)] cursor-pointer">
        <input type="radio" checked={on} onChange={onPick} className="mt-1" />
        <span className="flex flex-col">
          <span className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{title}</span>
          {hint ? <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)]">{hint}</span> : null}
        </span>
      </label>
      {on && children ? <div className="pl-6 flex flex-col gap-[var(--space-2)]">{children}</div> : null}
    </div>
  )
}

export function DecisionKeyPanel({ provider }: { provider: DecisionProvider }) {
  const info = PROVIDER_INFO[provider]
  const [status, setStatus] = useState<TypeSafeKeyStatus | null>(null)
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    setStatus(null)
    setMessage(null)
    api.getDecisionKeyStatus(provider).then(setStatus).catch(() => setStatus({ configured: false, source: "none" }))
  }, [provider])

  const run = async (kind: "save" | "test" | "delete") => {
    setBusy(kind)
    setMessage(null)
    try {
      if (kind === "save") {
        setStatus(await api.saveDecisionKey(provider, key))
        setKey("")
        setMessage({ ok: true, text: "保存しました。「接続テスト」で確かめられます。" })
      } else if (kind === "delete") {
        setStatus(await api.deleteDecisionKey(provider))
        setMessage({ ok: true, text: "保存したキーを消しました。" })
      } else {
        const result = await api.testDecisionKey(provider)
        setMessage(result.ok
          ? { ok: true, text: `つながりました（${result.latencyMs ?? "?"}ms）。` }
          : { ok: false, text: TEST_ERRORS[result.error ?? "provider_error"] })
      }
    } catch {
      setMessage({ ok: false, text: kind === "save" ? "保存できませんでした。キーの形を確かめてください。" : "実行できませんでした。" })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
        {status === null ? <><Loader2 size={12} className="animate-spin inline mr-1" />確認中…</>
          : status.configured
            ? <span className="text-[var(--system-green)] inline-flex items-center gap-1"><Check size={13} />{info.keyLabel}は{status.source === "environment" ? "環境変数で" : ""}設定済みです</span>
            : <>{info.keyLabel}がまだありません。<a href={info.keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5">キーを作る<ExternalLink size={11} /></a></>}
      </div>
      <div className="flex items-center gap-[var(--space-2)]">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value.trim())} autoComplete="off" spellCheck={false}
          placeholder={status?.configured ? "変えるときだけ貼る" : "ここに貼る"} aria-label={info.keyLabel}
          className="apple-input flex-1 bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-1.5 text-[length:var(--text-footnote)]" />
        <button type="button" className={smallButton} disabled={!key || busy !== null} onClick={() => run("save")}>{busy === "save" ? "保存中…" : "保存"}</button>
        <button type="button" className={smallButton} disabled={!status?.configured || busy !== null} onClick={() => run("test")}>{busy === "test" ? "確認中…" : "接続テスト"}</button>
        {status?.source === "stored" && (
          <button type="button" className={smallButton} disabled={busy !== null} onClick={() => run("delete")}>消す</button>
        )}
      </div>
      {message && <div className="text-[length:var(--text-caption1)]" style={{ color: message.ok ? "var(--system-green)" : "var(--system-red)" }}>{message.text}</div>}
    </div>
  )
}

export function AirReadingPicker({ value, onChange }: { value: AirReading; onChange: (next: AirReading) => void }) {
  const [provider, setProvider] = useState<DecisionProvider>(value.method === "jev" ? value.provider : "typesafe")
  const [engine, setEngine] = useState<CliEngine>(value.method === "cli" ? value.engine : "codex")
  const [local, setLocal] = useState(value.method === "local" ? { endpoint: value.endpoint, model: value.model } : { endpoint: DEFAULT_LOCAL_ENDPOINT, model: DEFAULT_LOCAL_MODEL })
  const localOk = isLoopbackDecisionEndpoint(local.endpoint) && /^[A-Za-z0-9][\w.:-]{0,63}$/.test(local.model)

  const pickLocal = (next: { endpoint: string; model: string }) => {
    setLocal(next)
    if (isLoopbackDecisionEndpoint(next.endpoint) && next.model) onChange({ method: "local", ...next })
  }

  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      {value.method === "shadow" && (
        <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          いまは試験運用中です（Codex／Claude が判断し、Jev は記録だけ）。下から選ぶと切り替わります。
        </div>
      )}
      <Option on={value.method === "cli"} onPick={() => onChange({ method: "cli", engine })}
        title="いま使っている AI で判断する（キー不要）"
        hint="Claude Code か Codex が、メッセージごとに返事するかを決めます。1通につき数秒かかり、サブスクの利用枠を少し使います。">
        <div className="flex gap-[var(--space-3)] text-[length:var(--text-footnote)]">
          {(["codex", "claude"] as CliEngine[]).map((name) => (
            <label key={name} className="inline-flex items-center gap-1 cursor-pointer">
              <input type="radio" checked={value.method === "cli" && value.engine === name} onChange={() => { setEngine(name); onChange({ method: "cli", engine: name }) }} />
              {name === "codex" ? "Codex" : "Claude"}
            </label>
          ))}
        </div>
      </Option>

      <Option on={value.method === "jev"} onPick={() => onChange({ method: "jev", provider })}
        title="判断専用モデルを使う（速い・安い）"
        hint="空気読み専用のモデルが、1通 0.数秒で判断します。API キーが要ります。Slack のメッセージ本文が選んだサービスに送られます。">
        <div className="flex flex-col gap-1.5">
          {(Object.keys(PROVIDER_INFO) as DecisionProvider[]).map((id) => (
            <label key={id} className="flex items-start gap-2 cursor-pointer">
              <input type="radio" className="mt-1" checked={value.method === "jev" && value.provider === id} onChange={() => { setProvider(id); onChange({ method: "jev", provider: id }) }} />
              <span className="flex flex-col">
                <span className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{PROVIDER_INFO[id].title}</span>
                <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">{PROVIDER_INFO[id].hint}</span>
              </span>
            </label>
          ))}
        </div>
        {value.method === "jev" && <DecisionKeyPanel provider={value.provider} />}
      </Option>

      <Option on={value.method === "local"} onPick={() => onChange({ method: "local", ...local })}
        title="この PC で動く判断モデルを使う"
        hint="Ollama などで判断モデルを動かしている場合です。メッセージは PC の外に出ません。1通に数秒かかることがあります。">
        <div className="grid gap-[var(--space-2)] sm:grid-cols-[2fr_1fr]">
          <input value={local.endpoint} onChange={(e) => pickLocal({ ...local, endpoint: e.target.value.trim() })} aria-label="判断モデルのアドレス"
            className="apple-input bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-1.5 text-[length:var(--text-footnote)]" />
          <input value={local.model} onChange={(e) => pickLocal({ ...local, model: e.target.value.trim() })} aria-label="モデル名"
            className="apple-input bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-1.5 text-[length:var(--text-footnote)]" />
        </div>
        {!localOk && <div className="text-[length:var(--text-caption1)] text-[var(--system-orange)]">アドレスは http://localhost:〜/v1/systemone の形にしてください（この PC の外は使えません）。</div>}
      </Option>
    </div>
  )
}

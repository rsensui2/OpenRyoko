"use client"

/**
 * First-run wizard. Five steps, each of which moves the install closer to
 * actually working — no cosmetics here (theme and accent live in Settings):
 *
 *   0 名前          who this portal is, and who you are
 *   1 エンジン確認   can Claude / Codex actually run (binary, version, login)
 *   2 Slack 接続    real tokens, real connect, real result
 *   3 最初の自動化   pick a template; the automation page finishes it
 *   4 完了          what is now available
 */

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  MessageSquare,
  Users,
  Columns3,
  Clock,
  DollarSign,
  Activity,
  Check,
  X,
  ArrowLeft,
  ArrowRight,
  Rocket,
  RefreshCw,
  Loader2,
} from "lucide-react"
import { useSettings } from "@/app/settings-provider"
import { api, type AutomationTemplateSpec, type EngineProbe } from "@/lib/api"

const FEATURES = [
  { icon: MessageSquare, name: "チャット", desc: "従業員との直接対話" },
  { icon: Users, name: "組織", desc: "AIチームの組織図をビジュアル表示" },
  { icon: Columns3, name: "カンバン", desc: "タスクボードで作業を管理" },
  { icon: Clock, name: "自動化", desc: "定期ジョブとワークフロー。テンプレートから作成" },
  { icon: DollarSign, name: "コスト", desc: "トークン使用量とコストの追跡" },
  { icon: Activity, name: "アクティビティ", desc: "リアルタイムログ・イベントストリーム" },
]

const TOTAL_STEPS = 5

const ENGINE_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" }

/* ------------------------------------------------------------------ */
/*  Step 1: engine check                                               */
/* ------------------------------------------------------------------ */

function engineHint(probe: EngineProbe): string | null {
  if (!probe.installed) {
    return probe.name === "claude"
      ? "npm install -g @anthropic-ai/claude-code でインストールし、claude と入力してログインしてください"
      : probe.name === "codex"
        ? "npm install -g @openai/codex でインストールし、codex login でログインしてください"
        : `${probe.name} をインストールして PATH を通してください`
  }
  if (!probe.runnable) return `起動できませんでした: ${probe.error ?? "不明なエラー"}`
  return null
}

/** ✓ means "installed and starts". Login is shown as observed information,
 *  never as a green light — a credential's validity only shows on first use. */
function engineState(probe: EngineProbe): "ok" | "warn" | "fail" {
  if (!probe.installed || !probe.runnable) return "fail"
  if (probe.auth && (probe.auth.method === "none" || probe.auth.expired)) return "warn"
  return "ok"
}

function EngineCheckStep({ active }: { active: boolean }) {
  const [probes, setProbes] = useState<EngineProbe[] | null>(null)
  const [defaultEngine, setDefaultEngine] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const check = useCallback(() => {
    setChecking(true)
    setAttempted(true)
    setError(null)
    api.getOnboardingEngines()
      .then((result) => { setProbes(result.engines); setDefaultEngine(result.default) })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setChecking(false))
  }, [])

  // One automatic probe when the step opens; after that only the button asks
  // again — a failing gateway must not be hammered in a retry loop.
  useEffect(() => { if (active && !attempted) check() }, [active, attempted, check])

  return (
    <div className="animate-fade-in">
      <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
        エンジンの確認
      </h2>
      <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
        AI エンジンがインストールされ、起動できるかを確認します（✓ = 起動できる）。ログインの有効性は最初の実行で判明します。ここが ✗ だと Ryoko は働けません。
      </p>
      {error && (
        <div className="text-[length:var(--text-footnote)] text-[var(--system-red)] mb-[var(--space-3)]">確認できませんでした: {error}</div>
      )}
      <div className="flex flex-col gap-[var(--space-2)]">
        {probes === null && !error ? (
          <div className="flex items-center gap-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            <Loader2 size={16} className="animate-spin" /> 確認中…
          </div>
        ) : (probes ?? []).map((probe) => {
          const state = engineState(probe)
          const hint = engineHint(probe)
          const color = state === "ok" ? "var(--system-green)" : state === "warn" ? "var(--system-orange)" : "var(--system-red)"
          return (
            <div key={probe.name} className="flex items-start gap-[var(--space-3)] p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)]">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
                {state === "fail" ? <X size={16} /> : <Check size={16} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                  {ENGINE_LABEL[probe.name] ?? probe.name}
                  {probe.name === defaultEngine && (
                    <span className="ml-2 text-[length:var(--text-caption2)] px-1.5 py-px rounded bg-[var(--accent-fill)] text-[var(--accent)]">既定</span>
                  )}
                </div>
                <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  {probe.version ?? (probe.installed ? "バージョン不明" : "未インストール")}
                </div>
                {probe.auth && (
                  <div className="text-[length:var(--text-caption1)] mt-0.5" style={{ color: state === "warn" ? color : "var(--text-secondary)" }}>
                    ログイン: {probe.auth.note}
                  </div>
                )}
                {hint && (
                  <div className="text-[length:var(--text-caption1)] mt-1 whitespace-pre-wrap" style={{ color }}>{hint}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <button
        onClick={check}
        disabled={checking}
        className="mt-[var(--space-3)] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-footnote)]"
      >
        <RefreshCw size={14} className={checking ? "animate-spin" : ""} /> 再確認
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Step 2: Slack                                                      */
/* ------------------------------------------------------------------ */

type ConnectorHealthMap = Record<string, { status: string; detail?: string } | undefined>

/** /api/status carries per-connector health under `connectors`; the shared
 *  client type does not declare it, so read it defensively here. */
function connectorHealth(status: unknown): ConnectorHealthMap {
  const connectors = (status as { connectors?: unknown })?.connectors
  return connectors && typeof connectors === "object" ? (connectors as ConnectorHealthMap) : {}
}

/** Slack's error codes and our normalized ones, in words a person can act on. */
function describeSlackError(code: string | undefined): string {
  switch (code) {
    case "invalid_auth": return "トークンが無効です"
    case "not_authed": return "トークンが送られていません"
    case "account_inactive": return "このトークンのアカウントは無効化されています"
    case "network_error": return "Slack に接続できませんでした（ネットワークを確認）"
    case undefined: return "確認に失敗しました"
    default: return code.startsWith("http_") ? `Slack が HTTP ${code.slice(5)} を返しました` : code
  }
}

/** A save that Slack accepted but the connector could not start — and what
 *  state the install was left in, stated honestly rather than optimistically. */
function describeReloadFailure(outcome: { error?: string; previous?: "config" | "none"; rolledBack?: boolean; restored?: { disk: boolean; running: boolean }; rollbackError?: string; rollbackSkipped?: string }): string {
  const head = `トークンは正しいのに接続の起動に失敗しました: ${outcome.error ?? "不明なエラー"}。`
  // "Rolled back" means two different things depending on what was there
  // before: an old connection is running again, or Slack is simply
  // unconfigured again. Say which.
  const wasUnconfigured = outcome.previous === "none"
  if (outcome.rolledBack) {
    return wasUnconfigured
      ? `${head}保存した設定は取り消し、接続前の状態（Slack 未接続）に戻しました。`
      : `${head}以前の Slack 設定に戻し、再接続しました。`
  }
  if (outcome.rollbackSkipped) return `${head}その間に設定が別の場所から変更されたため、元に戻す操作は行っていません。設定ページで現在の Slack 設定を確認してください。`
  if (outcome.restored?.disk && !outcome.restored.running) {
    return wasUnconfigured
      ? `${head}保存した設定はファイルから取り除きましたが、コネクタの再起動でエラーが出ています（${outcome.rollbackError ?? "原因不明"}）。設定ページで確認してください。`
      : `${head}以前の設定はファイルに戻しましたが、その接続も起動できていません（${outcome.rollbackError ?? "原因不明"}）。設定ページで確認してください。`
  }
  return `${head}以前の設定に戻せませんでした（${outcome.rollbackError ?? "原因不明"}）。設定ページで Slack 設定を確認してください。`
}

function SlackStep() {
  const [botToken, setBotToken] = useState("")
  const [appToken, setAppToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [already, setAlready] = useState(false)
  const [replaceExisting, setReplaceExisting] = useState(false)

  useEffect(() => {
    api.getStatus()
      .then((status) => {
        const slack = connectorHealth(status).slack
        if (slack && slack.status === "running") setAlready(true)
      })
      .catch(() => { /* status is optional here */ })
  }, [])

  const connect = async () => {
    if (!botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-")) {
      setResult({ ok: false, message: "Bot Token は xoxb-、App Token は xapp- で始まります" })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      // One server-side operation: verify both tokens → save → reload → if
      // the connector still fails, the server restores the previous Slack
      // config itself. Whatever comes back, nothing here has to guess.
      const outcome = await api.connectSlack(botToken, appToken)
      if (outcome.ok) {
        setResult({
          ok: true,
          message: `接続できました（ワークスペース: ${outcome.team ?? "?"} / Bot: ${outcome.user ?? "?"}）。Slack で Ryoko にメンションしてみてください`,
        })
        return
      }
      if (outcome.stage === "verify") {
        const parts = []
        if (outcome.bot && !outcome.bot.ok) parts.push(`Bot Token: ${describeSlackError(outcome.bot.error)}`)
        if (outcome.app && !outcome.app.ok) parts.push(`App Token: ${describeSlackError(outcome.app.error)}（アプリの Socket Mode が有効で、connections:write スコープがあるか確認）`)
        setResult({ ok: false, message: `保存していません。${parts.join(" / ") || "トークンを確認できませんでした"}` })
        return
      }
      setResult({ ok: false, message: describeReloadFailure(outcome) })
    } catch (err) {
      setResult({ ok: false, message: `接続処理でエラーが起きました: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(false)
    }
  }
  const canConnect = Boolean(botToken && appToken) && (!already || replaceExisting)

  const inputClass = "apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)]"

  return (
    <div className="animate-fade-in">
      <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
        Slack につなぐ
      </h2>
      <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
        Ryoko が働く場所です。Slack アプリ（Socket Mode）の2つのトークンを入れると、その場で接続を試します。あとで設定ページからでも構いません。
      </p>
      {already && (
        <div className="mb-[var(--space-3)]">
          <div className="text-[length:var(--text-footnote)] text-[var(--system-green)]">Slack は既に接続されています。「次へ」で構いません。</div>
          <label className="flex items-center gap-2 mt-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} />
            既存の接続を新しいトークンで差し替える
          </label>
        </div>
      )}
      <div className="flex flex-col gap-[var(--space-3)]">
        <div>
          <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]" htmlFor="ob-slack-bot">
            Bot User OAuth Token <span className="text-[var(--text-quaternary)]">xoxb-…</span>
          </label>
          <input id="ob-slack-bot" type="password" className={inputClass} value={botToken} onChange={(e) => setBotToken(e.target.value.trim())} placeholder="xoxb-" autoComplete="off" />
        </div>
        <div>
          <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]" htmlFor="ob-slack-app">
            App-Level Token <span className="text-[var(--text-quaternary)]">xapp-…（connections:write）</span>
          </label>
          <input id="ob-slack-app" type="password" className={inputClass} value={appToken} onChange={(e) => setAppToken(e.target.value.trim())} placeholder="xapp-" autoComplete="off" />
        </div>
        <div>
          <button
            onClick={connect}
            disabled={busy || !canConnect}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-md)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]"
            style={{
              background: busy || !canConnect ? "var(--fill-tertiary)" : "var(--accent)",
              color: busy || !canConnect ? "var(--text-tertiary)" : "var(--accent-contrast)",
            }}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {busy ? "確認して接続中…" : "確認して接続する"}
          </button>
        </div>
        {result && (
          <div className="text-[length:var(--text-footnote)] whitespace-pre-wrap" style={{ color: result.ok ? "var(--system-green)" : "var(--system-red)" }}>
            {result.message}
          </div>
        )}
      </div>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[var(--space-3)]">
        両方のトークンを Slack に照会してから保存します（正しくないトークンは保存されません）。保存後は画面に再表示されません。
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Step 3: first automation                                           */
/* ------------------------------------------------------------------ */

function FirstAutomationStep({ selected, onSelect }: {
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const [templates, setTemplates] = useState<AutomationTemplateSpec[] | null>(null)
  const [engineEnabled, setEngineEnabled] = useState(true)

  useEffect(() => {
    api.getAutomationTemplates()
      .then((result) => { setTemplates(result.templates); setEngineEnabled(result.workflowsEnabled) })
      .catch(() => setTemplates([]))
  }, [])

  return (
    <div className="animate-fade-in">
      <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
        最初の自動化
      </h2>
      <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
        Ryoko に任せる仕事の型を1つ選んでください。「はじめる」を押すと自動化ページで穴埋めするだけで動きます。あとで選んでも構いません。
      </p>
      {!engineEnabled ? (
        <div className="p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          ワークフロー（判定を挟んで必要な時だけ AI が動く自動化）は現在オフです。定期ジョブは自動化ページから、ワークフローは <code className="px-1 rounded bg-[var(--fill-tertiary)]">config.yaml</code> に <code className="px-1 rounded bg-[var(--fill-tertiary)]">workflows: {"{ enabled: true }"}</code> を追記して再起動すると使えます。
        </div>
      ) : templates === null ? (
        <div className="flex items-center gap-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          <Loader2 size={16} className="animate-spin" /> 読み込み中…
        </div>
      ) : (
        <div className="flex flex-col gap-[var(--space-2)]">
          {templates.map((template) => {
            const isActive = selected === template.id
            return (
              <button
                key={template.id}
                onClick={() => onSelect(isActive ? null : template.id)}
                className="text-left p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] cursor-pointer transition-all duration-150"
                style={{ border: isActive ? "2px solid var(--accent)" : "2px solid var(--separator)" }}
              >
                <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]" style={{ color: isActive ? "var(--accent)" : "var(--text-primary)" }}>
                  {template.name}
                </div>
                <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] mt-0.5">こういう時: {template.when}</div>
                <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mt-1">{template.flow}</div>
              </button>
            )
          })}
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-1">
            {selected ? "「はじめる」で自動化ページの作成フォームへ移動します" : "選ばずに「はじめる」を押すとチャットへ移動します"}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Wizard                                                             */
/* ------------------------------------------------------------------ */

interface OnboardingWizardProps {
  forceOpen?: boolean
  onClose?: () => void
}

export function OnboardingWizard({ forceOpen, onClose }: OnboardingWizardProps) {
  const { settings, setPortalName, setOperatorName, setLanguage } = useSettings()
  const router = useRouter()

  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState(0)

  const [localName, setLocalName] = useState("")
  const [localOperator, setLocalOperator] = useState("")
  const [localLanguage, setLocalLanguage] = useState(settings.language ?? "Japanese")
  const [firstTemplate, setFirstTemplate] = useState<string | null>(null)

  // First-run detection — server-side flag, not just localStorage
  useEffect(() => {
    if (forceOpen) {
      setLocalName(settings.portalName ?? "")
      setLocalOperator(settings.operatorName ?? "")
      setVisible(true)
      return
    }
    if (typeof window !== "undefined" && localStorage.getItem("jinn-onboarded")) return
    api.getOnboarding().then((data) => {
      if (data.onboarded) {
        localStorage.setItem("jinn-onboarded", "true")
      } else if (data.needed) {
        setVisible(true)
      }
    }).catch(() => {
      if (!localStorage.getItem("jinn-onboarded")) setVisible(true)
    })
  }, [forceOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNext = useCallback(() => {
    if (step === 0) {
      setPortalName(localName || null)
      setOperatorName(localOperator || null)
      setLanguage(localLanguage || "Japanese")
    }
    if (step < TOTAL_STEPS - 1) {
      setStep(step + 1)
      return
    }
    api.completeOnboarding({
      portalName: localName || undefined,
      operatorName: localOperator || undefined,
      language: localLanguage || undefined,
    }).catch(() => { /* best-effort: localStorage still has the values */ })
    if (!forceOpen) localStorage.setItem("jinn-onboarded", "true")
    setVisible(false)
    onClose?.()
    router.push(firstTemplate ? `/cron?create=${encodeURIComponent(firstTemplate)}` : "/chat")
  }, [step, localName, localOperator, localLanguage, firstTemplate, forceOpen, onClose, setPortalName, setOperatorName, setLanguage, router])

  const handleBack = useCallback(() => { if (step > 0) setStep(step - 1) }, [step])

  if (!visible) return null

  const inputClass = "apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)]"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" style={{ backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}>
      <div className="animate-fade-in w-full max-w-[520px] mx-[var(--space-4)] bg-[var(--material-regular)] rounded-[var(--radius-lg)] border border-[var(--separator)] overflow-hidden flex flex-col max-h-[90vh]" style={{ boxShadow: "0 24px 48px rgba(0,0,0,0.3)" }}>
        {/* Step indicator */}
        <div className="flex justify-center gap-2 pt-[var(--space-4)] px-[var(--space-4)]">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className="h-2 rounded-full transition-all duration-200"
              style={{ width: i === step ? 24 : 8, background: i <= step ? "var(--accent)" : "var(--fill-tertiary)", opacity: i < step ? 0.5 : 1 }}
            />
          ))}
        </div>

        <div className="px-[var(--space-5)] pt-[var(--space-5)] pb-[var(--space-4)] overflow-y-auto flex-1">
          {step === 0 && (
            <div key="step-0" className="animate-fade-in text-center">
              <div className="text-[56px] mb-[var(--space-3)] leading-none">{"🤖"}</div>
              <h2 className="text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-2)]">
                {localName || "Ryoko"} へようこそ
              </h2>
              <p className="text-[length:var(--text-body)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)] max-w-[400px] mx-auto mb-[var(--space-5)]">
                あなたの AI チーム管理ポータル。動くところまで、この場で仕上げます。
              </p>
              <div className="flex flex-col gap-[var(--space-3)] text-left">
                <div>
                  <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">ポータル名</label>
                  <input type="text" className={inputClass} placeholder="Ryoko" value={localName} onChange={(e) => setLocalName(e.target.value)} autoFocus />
                </div>
                <div>
                  <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">あなたの呼び名は？</label>
                  <input type="text" className={inputClass} placeholder="お名前" value={localOperator} onChange={(e) => setLocalOperator(e.target.value)} />
                </div>
                <div>
                  <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">使用言語</label>
                  <select value={localLanguage} onChange={(e) => setLocalLanguage(e.target.value)} className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)] cursor-pointer">
                    {["Japanese", "English", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch", "Russian", "Chinese", "Korean", "Arabic", "Hindi", "Bulgarian"].map((lang) => (
                      <option key={lang} value={lang}>{lang}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {step === 1 && <EngineCheckStep active={step === 1} />}
          {step === 2 && <SlackStep />}
          {step === 3 && <FirstAutomationStep selected={firstTemplate} onSelect={setFirstTemplate} />}

          {step === 4 && (
            <div key="step-4" className="animate-fade-in">
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
                準備ができました
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
                見た目（テーマ・アクセント色）は設定ページでいつでも変えられます。
              </p>
              <div className="flex flex-col gap-[var(--space-2)]">
                {FEATURES.map((f) => {
                  const Icon = f.icon
                  return (
                    <div key={f.name} className="flex items-center gap-[var(--space-3)] p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)]">
                      <div className="w-9 h-9 rounded-lg bg-[var(--accent-fill)] flex items-center justify-center shrink-0">
                        <Icon size={18} className="text-[var(--accent)]" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{f.name}</div>
                        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{f.desc}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex justify-between items-center px-[var(--space-5)] pb-[var(--space-5)] pt-[var(--space-3)] gap-[var(--space-3)]">
          {step > 0 ? (
            <button onClick={handleBack} className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-medium)] transition-all duration-150 inline-flex items-center gap-1.5">
              <ArrowLeft size={16} /> 戻る
            </button>
          ) : <div />}
          <button onClick={handleNext} className="px-[var(--space-6)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] transition-all duration-150 inline-flex items-center gap-1.5">
            {step === TOTAL_STEPS - 1 ? "はじめる" : step === 2 ? "次へ（スキップ可）" : "次へ"}
            {step === TOTAL_STEPS - 1 ? <Rocket size={16} /> : <ArrowRight size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}

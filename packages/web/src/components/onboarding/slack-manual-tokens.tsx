"use client"

/**
 * The original path: paste a bot token and an app token from a Slack app
 * the person made themselves. Kept for existing apps and for anyone who
 * cannot generate a configuration token.
 */

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { api } from "@/lib/api"
import { describeConnectOutcome } from "./slack-messages"

export function SlackManualTokens() {
  const [botToken, setBotToken] = useState("")
  const [appToken, setAppToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

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
      setResult(describeConnectOutcome(await api.connectSlack(botToken, appToken)))
    } catch (err) {
      setResult({ ok: false, message: `接続処理でエラーが起きました: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(false)
    }
  }
  const canConnect = Boolean(botToken && appToken)

  const inputClass = "apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)]"

  return (
    <div>
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

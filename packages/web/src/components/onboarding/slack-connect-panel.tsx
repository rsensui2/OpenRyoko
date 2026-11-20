"use client"

/**
 * The Slack connection, wherever it is offered (first-run wizard, the
 * /connect/slack page): guided setup by default, the two-token paste for an
 * app made by hand, and a guard when Slack is already running.
 */

import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { SlackAutoSetup } from "./slack-auto-setup"
import { SlackManualTokens } from "./slack-manual-tokens"

type ConnectorHealthMap = Record<string, { status?: string } | undefined>

/** /api/status carries per-connector health; the client type does not declare it. */
function connectorHealth(status: unknown): ConnectorHealthMap {
  const connectors = (status as { connectors?: unknown })?.connectors
  return connectors && typeof connectors === "object" ? (connectors as ConnectorHealthMap) : {}
}

export function SlackConnectPanel({ defaultName }: { defaultName: string }) {
  const [already, setAlready] = useState(false)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [manual, setManual] = useState(false)

  useEffect(() => {
    api.getStatus()
      .then((status) => { if (connectorHealth(status).slack?.status === "running") setAlready(true) })
      .catch(() => { /* status is optional here */ })
  }, [])
  const locked = already && !replaceExisting

  return (
    <div className="flex flex-col gap-[var(--space-3)]">
      {already && (
        <div>
          <div className="text-[length:var(--text-footnote)] text-[var(--system-green)]">Slack は既につながっています。</div>
          <label className="flex items-center gap-2 mt-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} />
            別の Slack アプリにつなぎ直す
          </label>
        </div>
      )}
      {!locked && (manual ? <SlackManualTokens /> : <SlackAutoSetup defaultName={defaultName} />)}
      {!locked && (
        <button
          type="button"
          onClick={() => setManual(!manual)}
          className="self-start bg-transparent border-none p-0 cursor-pointer text-[length:var(--text-caption1)] text-[var(--text-secondary)] underline"
        >
          {manual ? "画像つきの手順に戻る" : "Slack アプリを自分で作ってある場合は、トークンを直接入力する"}
        </button>
      )}
    </div>
  )
}

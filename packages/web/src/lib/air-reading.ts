/**
 * How air-reading (Slack triage) decides, as one choice, and the triage config
 * it stands for:
 *   cli    – the engine the person already uses (Claude / Codex), no key
 *   jev    – a decision model behind an API key: Jev at TypeSafe or through
 *            OpenRouter, or the OpenAI Decisions API
 *   local  – a decision model on this machine (an Ollama-style /v1/systemone)
 *   shadow – jev-shadow (CLI decides, Jev observes); shown, kept unless changed
 */

export type DecisionProvider = "typesafe" | "openrouter" | "openai"
export type CliEngine = "claude" | "codex"

export type AirReading =
  | { method: "cli"; engine: CliEngine }
  | { method: "jev"; provider: DecisionProvider }
  | { method: "local"; endpoint: string; model: string }
  | { method: "shadow" }

export interface TriageConfig {
  enabled?: boolean
  backend?: string
  engine?: string
  /** null only in a patch read back before saving (null deletes on the gateway). */
  jev?: { provider?: string | null; endpoint?: string | null; model?: string | null; timeoutMs?: number }
}

export const DEFAULT_LOCAL_ENDPOINT = "http://localhost:11434/v1/systemone"
export const DEFAULT_LOCAL_MODEL = "nimble"
/** Local decision models can take several seconds per message. */
const LOCAL_TIMEOUT_MS = 10_000

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

export function isLoopbackDecisionEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname)
      && url.pathname === "/v1/systemone" && !url.search && !url.hash && !url.username && !url.password
  } catch {
    return false
  }
}

function provider(raw: unknown): DecisionProvider {
  return raw === "openrouter" || raw === "openai" ? raw : "typesafe"
}

export function airReadingFromConfig(triage: TriageConfig | undefined): AirReading {
  const backend = triage?.backend
  if (backend === "jev-shadow") return { method: "shadow" }
  if (backend === "jev") {
    const endpoint = triage?.jev?.endpoint
    if (endpoint && isLoopbackDecisionEndpoint(endpoint)) {
      return { method: "local", endpoint, model: triage?.jev?.model ?? DEFAULT_LOCAL_MODEL }
    }
    return { method: "jev", provider: provider(triage?.jev?.provider) }
  }
  return { method: "cli", engine: triage?.engine === "claude" ? "claude" : "codex" }
}

export function sameAirReading(a: AirReading, b: AirReading): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The triage fields that select this method. Switching drops the previous
 * method's pins (null deletes under the gateway's deep merge), so a model id
 * from one provider is never sent to another.
 */
export function airReadingPatch(reading: AirReading): TriageConfigPatch | null {
  switch (reading.method) {
    case "cli":
      return { backend: "cli", engine: reading.engine }
    case "jev":
      return { backend: "jev", jev: { provider: reading.provider, endpoint: null, model: null } }
    case "local":
      return { backend: "jev", jev: { provider: null, endpoint: reading.endpoint, model: reading.model, timeoutMs: LOCAL_TIMEOUT_MS } }
    case "shadow":
      return null
  }
}

export interface TriageConfigPatch {
  backend: string
  engine?: string
  jev?: { provider: string | null; endpoint: string | null; model: string | null; timeoutMs?: number }
}

export const PROVIDER_INFO: Record<DecisionProvider, { title: string; hint: string; keyUrl: string; keyLabel: string }> = {
  typesafe: {
    title: "Jev（TypeSafe）",
    hint: "空気読みのために作られた判断モデルです。TypeSafe の API キーが要ります。",
    keyUrl: "https://typesafe.ai",
    keyLabel: "TypeSafe の API キー",
  },
  openrouter: {
    title: "Jev（OpenRouter 経由）",
    hint: "同じ Jev を OpenRouter のキーで使います。OpenRouter を使っているならこちらが手軽です。",
    keyUrl: "https://openrouter.ai/keys",
    keyLabel: "OpenRouter の API キー",
  },
  openai: {
    title: "OpenAI Decisions API",
    hint: "OpenAI の判断専用 API（gpt-6-luna）です。OpenAI Platform の API キーが要ります。ChatGPT や Codex にログインしているだけでは使えません。",
    keyUrl: "https://platform.openai.com/api-keys",
    keyLabel: "OpenAI の API キー",
  },
}

export function describeAirReading(reading: AirReading): string {
  switch (reading.method) {
    case "cli": return `${reading.engine === "claude" ? "Claude" : "Codex"} で判断します（キー不要・1通数秒）`
    case "jev": return `${PROVIDER_INFO[reading.provider].title} で判断します`
    case "local": return `この PC の判断モデル（${reading.model}）で判断します`
    case "shadow": return "いまは Codex／Claude が判断し、Jev は記録だけしています（試験運用）"
  }
}

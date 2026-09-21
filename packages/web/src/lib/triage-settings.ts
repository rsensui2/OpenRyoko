/** Public settings only. TypeSafe credentials are stored through a separate API. */
export interface SlackTriageSettings {
  enabled?: boolean
  backend?: "cli" | "jev" | "jev-shadow"
  engine?: "claude" | "codex"
  bin?: string
  model?: string | null
  timeoutMs?: number
  threadContextLimit?: number
  persona?: string
  conversationIdleTimeoutMs?: number
  conversationMaxEntries?: number
  jev?: {
    useCapabilities?: boolean
    model?: string
    apiKeyEnv?: string
    fallback?: "none" | "cli"
    timeoutMs?: number
    maxConcurrent?: number
    minProbability?: { reply?: number; react?: number; silent?: number }
  }
}

export type TriageMode = "cli" | "jev" | "jev-fallback" | "jev-shadow"

export function triageMode(config: SlackTriageSettings): TriageMode {
  if (config.backend === "jev-shadow") return "jev-shadow"
  if (config.backend === "jev") return config.jev?.fallback === "cli" ? "jev-fallback" : "jev"
  return "cli"
}

export function withTriageMode(config: SlackTriageSettings, mode: TriageMode): SlackTriageSettings {
  if (mode === "cli" || mode === "jev-shadow") return { ...config, backend: mode }
  return {
    ...config,
    backend: "jev",
    jev: { ...config.jev, fallback: mode === "jev-fallback" ? "cli" : "none" },
  }
}

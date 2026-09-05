/**
 * Context-meter helpers. `lastContextTokens` (from the gateway) is the most
 * recent turn's INPUT context size — i.e. how full the model's context window
 * currently is. These pure helpers format it and estimate window fullness so a
 * badge can warn the user before they hit the wall.
 */

/** Default usable context window (tokens) when the model is unknown. */
const DEFAULT_WINDOW = 200_000

/** Known usable context windows by model-name substring (longest match wins). */
const MODEL_WINDOWS: ReadonlyArray<readonly [pattern: string, window: number]> = [
  ['gpt-6-astra', 1_050_000],
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_000_000],
  ['o3', 200_000],
  ['opus', 200_000],
  ['sonnet', 1_000_000],
  ['haiku', 200_000],
  ['gemini', 1_000_000],
]

export function contextWindowFor(model?: string | null): number {
  if (!model) return DEFAULT_WINDOW
  const lower = model.toLowerCase()
  let best = DEFAULT_WINDOW
  let bestLen = -1
  for (const [pattern, window] of MODEL_WINDOWS) {
    if (lower.includes(pattern) && pattern.length > bestLen) {
      best = window
      bestLen = pattern.length
    }
  }
  return best
}

/** Compact token count, e.g. 152_340 -> "152K", 1_240_000 -> "1.2M". */
export function formatContextTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(Math.round(tokens))
}

/** Fraction (0..1) of the window currently used. */
export function contextFraction(tokens: number, model?: string | null): number {
  const window = contextWindowFor(model)
  if (window <= 0) return 0
  return Math.max(0, Math.min(1, tokens / window))
}

export type ContextLevel = 'ok' | 'warn' | 'critical'

export function contextLevel(fraction: number): ContextLevel {
  if (fraction >= 0.9) return 'critical'
  if (fraction >= 0.7) return 'warn'
  return 'ok'
}

import { describe, expect, it } from "vitest"
import { getModelPricing, toRunCosts } from "../costs"

describe("Opus pricing", () => {
  it.each(["claude-opus-5-5", "claude-opus-5-5-20260922"])("prices %s at the new rates", (model) => {
    expect(getModelPricing(model)).toEqual({
      inputPer1M: 4, outputPer1M: 20,
      cacheReadPer1M: 0.20, cacheWritePer1M: 5, cacheWrite1hPer1M: 8,
    })
    const [run] = toRunCosts([{
      ts: 0, jobId: "job", status: "ok", durationMs: 1, model,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_500_000 },
    }])
    // Cron logs combine cache reads and writes; retain the input/output lower bound.
    expect(run.minCost).toBe(24)
    expect(run.cacheTokens).toBe(500_000)
  })

  it.each(["claude-opus-5", "claude-opus-5-20260724", "claude-opus-4-8"])("preserves %s pricing", (model) => {
    expect(getModelPricing(model)).toEqual({ inputPer1M: 5, outputPer1M: 25 })
  })
})

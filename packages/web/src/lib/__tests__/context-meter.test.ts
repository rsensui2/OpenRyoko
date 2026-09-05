import { describe, expect, it } from "vitest"
import { contextFraction, contextLevel, contextWindowFor } from "../context-meter"

describe("GPT-6 Astra context meter", () => {
  it("measures context against Astra's published window instead of the unknown-model fallback", () => {
    expect(contextWindowFor("gpt-6-astra")).toBe(1_050_000)
    expect(contextFraction(525_000, "gpt-6-astra")).toBe(0.5)
    expect(contextLevel(contextFraction(525_000, "gpt-6-astra"))).toBe("ok")
    expect(contextLevel(contextFraction(945_000, "gpt-6-astra"))).toBe("critical")
  })
})

describe("Claude Fable 5.1 context meter", () => {
  it("uses Fable's 1M window so a half-full session does not trigger a false critical warning", () => {
    expect(contextWindowFor("claude-fable-5-1")).toBe(1_000_000)
    expect(contextFraction(500_000, "claude-fable-5-1")).toBe(0.5)
    expect(contextLevel(contextFraction(500_000, "claude-fable-5-1"))).toBe("ok")
    expect(contextLevel(contextFraction(900_000, "claude-fable-5-1"))).toBe("critical")
  })
})

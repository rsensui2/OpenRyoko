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

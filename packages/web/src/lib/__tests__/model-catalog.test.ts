import { describe, it, expect } from "vitest"
import {
  CLAUDE_MODELS,
  GEMINI_MODELS,
  OPENAI_MODELS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_TRIAGE_CODEX_MODEL,
  DEFAULT_TRIAGE_CLAUDE_MODEL,
  MODEL_VENDORS,
  TRIAGE_MODEL_VENDORS,
  defaultModelForEngine,
  claudeEffortOptionsForModel,
  codexEffortOptionsForModel,
  defaultTriageModelForEngine,
  isCatalogModel,
  modelsForEngine,
  withCurrentValue,
} from "@/lib/model-catalog"

describe("model-catalog", () => {
  it("defaults Codex to GPT-5.6 (Sol) and Claude to Opus 5 (explicit id)", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol")
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5")
    expect(OPENAI_MODELS.some((m) => m.value === DEFAULT_CODEX_MODEL)).toBe(true)
    expect(CLAUDE_MODELS[0].value).toBe("claude-opus-5")
    expect(CLAUDE_MODELS.some((m) => m.value === DEFAULT_CLAUDE_MODEL)).toBe(true)
  })

  it("offers GPT-6 Astra by its explicit id and limits max effort to Astra", () => {
    expect(OPENAI_MODELS[0].value).toBe("gpt-6-astra")
    expect(isCatalogModel("codex", "gpt-6-astra")).toBe(true)
    expect(isCatalogModel("codex", "gpt-6")).toBe(false)
    expect(codexEffortOptionsForModel("gpt-6-astra").map((option) => option.value))
      .toEqual(["default", "low", "medium", "high", "xhigh", "max"])
    for (const model of ["gpt-5.6-sol", undefined, "gpt-private-preview"]) {
      expect(codexEffortOptionsForModel(model).map((option) => option.value)).not.toContain("max")
    }
  })

  it("keeps Opus 4.8 pin and the bare opus alias selectable", () => {
    const ids = CLAUDE_MODELS.map((m) => m.value)
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-4-8", "opus"]))
  })

  it("offers Fable 5.1 by its explicit id with max effort without changing the Claude default", () => {
    expect(isCatalogModel("claude", "claude-fable-5-1")).toBe(true)
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5")
    expect(claudeEffortOptionsForModel("claude-fable-5-1").map((option) => option.value))
      .toEqual(["default", "low", "medium", "high", "xhigh", "max"])
    for (const model of ["claude-opus-5", "claude-haiku-4-5", undefined, "claude-private-preview"]) {
      expect(claudeEffortOptionsForModel(model).map((option) => option.value)).not.toContain("max")
    }
  })

  it("exposes the GPT-5.6 松竹梅 tiers (Sol / Terra / Luna)", () => {
    const ids = OPENAI_MODELS.map((m) => m.value)
    expect(ids).toEqual(expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]))
  })

  it("modelsForEngine returns the catalog for each vendor", () => {
    expect(modelsForEngine("claude")).toBe(CLAUDE_MODELS)
    expect(modelsForEngine("codex")).toBe(OPENAI_MODELS)
    expect(modelsForEngine("gemini")).toBe(GEMINI_MODELS)
    expect(modelsForEngine(undefined)).toBe(OPENAI_MODELS)
  })

  it("maps vendor choices and defaults to config-compatible engine values", () => {
    expect(MODEL_VENDORS.map((vendor) => vendor.value)).toEqual([
      "claude",
      "codex",
      "gemini",
    ])
    expect(defaultModelForEngine("claude")).toBe(DEFAULT_CLAUDE_MODEL)
    expect(defaultModelForEngine("codex")).toBe(DEFAULT_CODEX_MODEL)
    expect(defaultModelForEngine("gemini")).toBe(DEFAULT_GEMINI_MODEL)
    expect(defaultTriageModelForEngine("claude")).toBe(DEFAULT_TRIAGE_CLAUDE_MODEL)
    expect(defaultTriageModelForEngine("codex")).toBe(DEFAULT_TRIAGE_CODEX_MODEL)
    expect(TRIAGE_MODEL_VENDORS.map((vendor) => vendor.value)).toEqual([
      "claude",
      "codex",
    ])
  })

  it("keeps every default model in its corresponding catalog", () => {
    expect(isCatalogModel("claude", DEFAULT_CLAUDE_MODEL)).toBe(true)
    expect(isCatalogModel("codex", DEFAULT_CODEX_MODEL)).toBe(true)
    expect(isCatalogModel("gemini", DEFAULT_GEMINI_MODEL)).toBe(true)
    expect(isCatalogModel("claude", DEFAULT_TRIAGE_CLAUDE_MODEL)).toBe(true)
    expect(isCatalogModel("codex", DEFAULT_TRIAGE_CODEX_MODEL)).toBe(true)
  })

  it("distinguishes curated ids from custom model ids", () => {
    expect(isCatalogModel("codex", "gpt-5.6-sol")).toBe(true)
    expect(isCatalogModel("codex", "gpt-private-preview")).toBe(false)
    expect(isCatalogModel("claude", undefined)).toBe(false)
  })

  it("withCurrentValue keeps an unknown hand-typed value selectable", () => {
    const opts = withCurrentValue(OPENAI_MODELS, "gpt-legacy-custom")
    expect(opts.at(-1)).toEqual({
      value: "gpt-legacy-custom",
      label: "gpt-legacy-custom（現在の設定）",
    })
  })

  it("withCurrentValue is a no-op for a known or empty value", () => {
    expect(withCurrentValue(OPENAI_MODELS, "gpt-5.6-sol")).toBe(OPENAI_MODELS)
    expect(withCurrentValue(OPENAI_MODELS, "")).toBe(OPENAI_MODELS)
    expect(withCurrentValue(OPENAI_MODELS, undefined)).toBe(OPENAI_MODELS)
  })
})

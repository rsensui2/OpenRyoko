import { describe, expect, it } from "vitest"
import { airReadingFromConfig, airReadingPatch, isLoopbackDecisionEndpoint } from "../air-reading"
import { behaviorFromConfig, behaviorToConfigPatch } from "../slack-behavior"

/* The air-reading choice must read back what config.yaml holds and switch
 * methods without leaving one provider's pins behind for another. */

describe("airReadingFromConfig", () => {
  it.each([
    [undefined, { method: "cli", engine: "codex" }],
    [{ backend: "cli", engine: "claude" }, { method: "cli", engine: "claude" }],
    [{ backend: "jev" }, { method: "jev", provider: "typesafe" }],
    [{ backend: "jev", jev: { provider: "openai" } }, { method: "jev", provider: "openai" }],
    [{ backend: "jev", jev: { provider: "openrouter", endpoint: "http://localhost:11434/v1/systemone", model: "tev1:0.8b" } },
      { method: "local", endpoint: "http://localhost:11434/v1/systemone", model: "tev1:0.8b" }],
    [{ backend: "jev-shadow" }, { method: "shadow" }],
    [{ backend: "jev", jev: { provider: "made-up" } }, { method: "jev", provider: "typesafe" }],
  ])("reads %j", (triage, expected) => {
    expect(airReadingFromConfig(triage)).toEqual(expected)
  })
})

describe("airReadingPatch", () => {
  it("clears the other method's pins when switching", () => {
    expect(airReadingPatch({ method: "jev", provider: "openrouter" })).toEqual({ backend: "jev", jev: { provider: "openrouter", endpoint: null, model: null } })
    expect(airReadingPatch({ method: "local", endpoint: "http://127.0.0.1:11434/v1/systemone", model: "nimble" }))
      .toEqual({ backend: "jev", jev: { provider: null, endpoint: "http://127.0.0.1:11434/v1/systemone", model: "nimble", timeoutMs: 10000 } })
    expect(airReadingPatch({ method: "shadow" })).toBeNull()
  })

  it("accepts only loopback /v1/systemone as a local endpoint", () => {
    expect(isLoopbackDecisionEndpoint("http://localhost:11434/v1/systemone")).toBe(true)
    expect(isLoopbackDecisionEndpoint("http://192.168.1.5:11434/v1/systemone")).toBe(false)
    expect(isLoopbackDecisionEndpoint("http://localhost:11434/v1/other")).toBe(false)
  })
})

describe("saving the behavior with an air-reading method", () => {
  it("writes the method only when it changed, together with the on/off switch", () => {
    const loaded = behaviorFromConfig({ respondTo: { channel: "always" }, triage: { enabled: true, backend: "cli", engine: "codex" } })
    expect(behaviorToConfigPatch(loaded, loaded).triage).toEqual({ enabled: true })
    const changed = behaviorToConfigPatch({ ...loaded, airReading: { method: "jev", provider: "openai" } }, loaded)
    expect(changed.triage).toEqual({ enabled: true, backend: "jev", jev: { provider: "openai", endpoint: null, model: null } })
  })

  it("can change the method while channels stay mention-only, without touching the switch", () => {
    const loaded = behaviorFromConfig({ respondTo: { channel: "mention" } })
    const patch = behaviorToConfigPatch({ ...loaded, airReading: { method: "cli", engine: "claude" } }, loaded)
    expect(patch.triage).toEqual({ backend: "cli", engine: "claude" })
  })
})

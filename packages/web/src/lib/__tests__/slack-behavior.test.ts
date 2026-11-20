import { describe, expect, it } from "vitest"
import { behaviorFromConfig, behaviorToConfigPatch, describeBehavior, usesMentions, type SlackBehavior } from "../slack-behavior"

/* The answers on the behavior page must read back exactly what config.yaml
 * holds, and saving must write only what the answers decide. */

describe("behaviorFromConfig", () => {
  it("reads an empty config as the legacy answer-everything behavior", () => {
    expect(behaviorFromConfig(undefined)).toEqual({ dm: "always", channel: "always", groupDm: "same", engagedThreads: true, exceptions: {}, airReading: { method: "cli", engine: "codex" } })
  })

  it("reads always + air-reading as the auto choice", () => {
    expect(behaviorFromConfig({ respondTo: { channel: "always", mpim: "always" }, triage: { enabled: true } }).channel).toBe("auto")
  })

  it("keeps a group DM mode that differs from the channel", () => {
    const behavior = behaviorFromConfig({ respondTo: { channel: "mention", mpim: "always", im: "never", engagedThreads: false } })
    expect(behavior).toMatchObject({ dm: "never", channel: "mention", groupDm: "always", engagedThreads: false })
  })

  it("drops exception values the gateway would ignore", () => {
    expect(behaviorFromConfig({ respondTo: { channels: { C1: "always", C2: "sometimes" } } }).exceptions).toEqual({ C1: "always" })
  })
})

describe("behaviorToConfigPatch", () => {
  const base: SlackBehavior = { dm: "always", channel: "mention", groupDm: "same", engagedThreads: true, exceptions: { C_OLD: "always" }, airReading: { method: "cli", engine: "codex" } }

  it("writes the gate for each place and follows the channel for group DMs", () => {
    const patch = behaviorToConfigPatch({ ...base, exceptions: {} }, base)
    expect(patch.respondTo).toMatchObject({ im: "always", mpim: "mention", channel: "mention", engagedThreads: true })
  })

  it("sends removed exceptions as null so the merge deletes them", () => {
    const patch = behaviorToConfigPatch({ ...base, exceptions: { C_NEW: "never" } }, base)
    expect(patch.respondTo.channels).toEqual({ C_OLD: null, C_NEW: "never" })
  })

  it("switches air-reading only for the choices that decide it", () => {
    expect(behaviorToConfigPatch({ ...base, channel: "auto" }, base)).toMatchObject({ respondTo: { channel: "always" }, triage: { enabled: true } })
    expect(behaviorToConfigPatch({ ...base, channel: "always" }, base).triage).toEqual({ enabled: false })
    expect(behaviorToConfigPatch(base, base).triage).toBeUndefined()
  })

  it("round-trips through the config it writes", () => {
    const answers: SlackBehavior = { dm: "never", channel: "auto", groupDm: "mention", engagedThreads: false, exceptions: { C1: "always" }, airReading: { method: "jev", provider: "openai" } }
    const patch = behaviorToConfigPatch(answers, { ...answers, airReading: { method: "cli", engine: "codex" } })
    expect(behaviorFromConfig(patch)).toEqual(answers)
  })
})

describe("describeBehavior", () => {
  it("mentions the thread rule only when a mention matters, and names exception channels", () => {
    const quiet: SlackBehavior = { dm: "always", channel: "auto", groupDm: "same", engagedThreads: true, exceptions: {}, airReading: { method: "cli", engine: "codex" } }
    expect(usesMentions(quiet)).toBe(false)
    expect(describeBehavior(quiet).some((line) => line.includes("スレッド"))).toBe(false)
    const lines = describeBehavior({ ...quiet, channel: "mention", exceptions: { C1: "always" } }, () => "random")
    expect(lines).toContain("一度返事したスレッドでは、メンションがなくても続けて返事します")
    expect(lines).toContain("#random だけは: すべてのメッセージに返事します")
  })
})

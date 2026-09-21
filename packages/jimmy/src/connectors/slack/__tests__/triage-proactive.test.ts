import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildJevTriageRequest, evaluateJevTriage, resolveJevUncertaintyDecision } from "../triage-jev.js";
import { runTriage } from "../triage.js";
import type { TriagePromptInput } from "../triage-prompt.js";

const input: TriagePromptInput = {
  botName: "Sora", channelType: "channel", channelDescription: "#work", speakerName: "Person",
  wasMentioned: false, speakerIsOperator: false, recentThread: [], participationKey: "bot:channel:123.456",
  messageText: "毎月この表を手で集計するのに3時間かかっている。まだ自動化できていない。",
  capabilities: { skills: [{ name: "spreadsheets", description: "表の集計と自動化を行う" }] },
};

function response(message = input, proactive = true, overrides: Record<string, string | number> = {}) {
  const selected: Record<string, string | number> = {
    recipient: "unknown", intent: "statement", relation: "unrelated", acknowledgment: "none",
    response_value: 0, contribution: "not_needed", proactive: "useful_now", ...overrides,
  };
  return {
    model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 50 },
    answers: Object.fromEntries(Object.entries(buildJevTriageRequest(message, undefined, proactive).questions).map(([name, question]) => [name,
      question.type === "noul" ? { type: "noul", noul: selected[name] } : {
        type: "choice", choice: selected[name], confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected[name] ? 1 : 0])),
      },
    ])),
  };
}
const options = (body = response(), percent = 100) => ({
  proactiveParticipationPercent: percent, apiKeyEnv: "JEV_TEST_KEY",
  fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body)),
});
beforeEach(() => vi.stubEnv("JEV_TEST_KEY", "test-not-real"));
afterEach(() => vi.unstubAllEnvs());

describe("unsolicited useful participation", () => {
  it("joins a concrete unmet need at 100% even when no answer was requested", async () => {
    const opts = options();
    expect(await evaluateJevTriage(input, opts)).toMatchObject({ status: "accepted",
      decision: { action: "reply", reason: "jev_proactive_contribution" },
      metadata: { proactive: { participationPercent: 100, selected: true } },
    });
    const sent = JSON.parse(opts.fetchImpl.mock.calls[0][1]!.body as string);
    expect(sent.questions.proactive.instructions).toContain('"Sora"');
    expect(JSON.stringify(sent)).not.toContain(input.participationKey);
  });

  it("defaults to off and omits the optional axis at 0% or without capabilities", async () => {
    for (const percent of [0, undefined]) {
      const opts = { ...options(response(input, false)), proactiveParticipationPercent: percent };
      const result = await evaluateJevTriage(input, opts);
      expect(resolveJevUncertaintyDecision(input, result, "silent").action).toBe("silent");
      expect(JSON.parse(opts.fetchImpl.mock.calls[0][1]!.body as string).questions.proactive).toBeUndefined();
    }
    const withoutCapabilities = { ...input, capabilities: undefined };
    const opts = { ...options(response(withoutCapabilities, false)), useCapabilities: false };
    const result = await evaluateJevTriage(input, opts);
    expect(resolveJevUncertaintyDecision(input, result, "silent").action).toBe("silent");
    expect(JSON.parse(opts.fetchImpl.mock.calls[0][1]!.body as string).questions.proactive).toBeUndefined();
  });

  it.each([
    { recipient: "other_human", intent: "request" },
    { intent: "social", acknowledgment: "celebration" },
    { intent: "acknowledgment", acknowledgment: "thanks" },
    { intent: "stop" }, { relation: "closing" }, { relation: "bot_followup" },
    { proactive: "not_needed" }, { proactive: "cannot_help" }, { proactive: "unknown" },
  ])("does not invent participation from incompatible factors: %j", async (overrides) => {
    const result = await evaluateJevTriage(input, options(response(input, true, overrides)));
    expect(resolveJevUncertaintyDecision(input, result, "silent").action).toBe("silent");
  });

  it("requires confident capability fit and complete context; reactions stay excluded", async () => {
    const body = response();
    body.answers.proactive = { type: "choice", choice: "useful_now", confidence: .79,
      probabilities: { useful_now: .79, not_needed: .21, cannot_help: 0, unknown: 0 } };
    const weak = await evaluateJevTriage(input, options(body));
    expect(resolveJevUncertaintyDecision(input, weak, "silent").action).toBe("silent");
    for (const extra of [
      { contextIncomplete: true }, { isReaction: true },
    ]) {
      const message = { ...input, ...extra };
      const result = await evaluateJevTriage(message, options());
      expect(resolveJevUncertaintyDecision(message, result, "silent").action).toBe("silent");
    }
  });

  it("allows a separate unmet need despite uncertain audience or an unrelated other-bot notification", async () => {
    const body = response();
    body.answers.recipient = { type: "choice", choice: "unknown", confidence: .5,
      probabilities: { bot: .07, group: .10, other_human: .34, unknown: .49 } };
    expect(await evaluateJevTriage(input, options(body))).toMatchObject({ status: "accepted", decision: { action: "reply", reason: "jev_proactive_contribution" } });
    const afterOtherBot = { ...input, recentThread: [{ speaker: "WeatherBot", text: "明日は晴れです", isBot: true, isSelf: false }] };
    expect(await evaluateJevTriage(afterOtherBot, options())).toMatchObject({ status: "accepted", decision: { action: "reply", reason: "jev_proactive_contribution" } });
    const followup = { ...afterOtherBot, messageText: "はい、続けて" };
    const result = await evaluateJevTriage(followup, options(response(followup, true, { recipient: "bot", intent: "continuation", relation: "bot_followup", response_value: 1 })));
    expect(resolveJevUncertaintyDecision(followup, result, "silent").action).toBe("silent");
    body.answers.recipient = { type: "choice", choice: "other_human", confidence: .5,
      probabilities: { bot: .07, group: .10, other_human: .49, unknown: .34 } };
    expect(resolveJevUncertaintyDecision(input, await evaluateJevTriage(input, options(body)), "silent").action).toBe("silent");
  });

  it("never samples away direct calls, open requests, or own-task continuation", async () => {
    for (const percent of [0, 1, 100]) {
      for (const overrides of [
        { recipient: "bot", intent: "request", response_value: 1 },
        { recipient: "group", intent: "request", response_value: 1, contribution: "useful_now" },
        { recipient: "bot", intent: "continuation", relation: "bot_followup", response_value: 1 },
      ]) {
        const result = await evaluateJevTriage(input, options(response(input, percent > 0, overrides), percent));
        expect(result).toMatchObject({ status: "accepted", decision: { action: "reply" } });
        expect(result.metadata.proactive?.selected).toBeUndefined();
      }
    }
  });

  it("samples stably across events, preserves nested thresholds, and never falls back to a CLI after skipping", async () => {
    let selected = 0;
    let skippedInput: TriagePromptInput | undefined;
    for (let i = 0; i < 200; i++) {
      const message = { ...input, participationKey: `bot:channel:${i}` };
      const first = await evaluateJevTriage(message, options(response(), 50));
      const repeated = await evaluateJevTriage({ ...message, recentThread: [{ speaker: "Person", text: "追加の文脈" }] }, options(response(), 50));
      expect(first.status).toBe("accepted");
      expect(repeated.metadata.proactive?.selected).toBe(first.metadata.proactive?.selected);
      if (first.metadata.proactive?.selected) {
        selected++;
        expect((await evaluateJevTriage(message, options(response(), 75))).metadata.proactive?.selected).toBe(true);
      } else skippedInput = message;
    }
    expect(selected).toBeGreaterThan(60);
    expect(selected).toBeLessThan(140);
    const spawnImpl = vi.fn();
    expect(await runTriage(skippedInput!, { backend: "jev", jev: { ...options(response(), 50), fallback: "cli" }, spawnImpl }))
      .toMatchObject({ action: "silent", reason: "jev_proactive_skipped" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.each([-1, 101, 1.5, NaN, Infinity, "100"])("rejects invalid percent %s before sending content", async (percent) => {
    const opts = options(response(), percent as number);
    expect(await evaluateJevTriage(input, opts)).toMatchObject({ status: "fallback", reason: "invalid_config" });
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  });
});

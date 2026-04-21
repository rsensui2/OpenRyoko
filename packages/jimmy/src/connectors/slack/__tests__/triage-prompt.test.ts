import { describe, it, expect } from "vitest";
import {
  buildTriagePrompt,
  parseTriageDecision,
  type TriagePromptInput,
} from "../triage-prompt.js";

function baseInput(overrides: Partial<TriagePromptInput> = {}): TriagePromptInput {
  return {
    botName: "Ryoko",
    persona: "Ryoko is Ryosuke's AI assistant, strong in coding and product.",
    operatorName: "亮介",
    channelType: "channel",
    channelDescription: "#general",
    speakerName: "Taro",
    speakerIsOperator: false,
    wasMentioned: false,
    recentThread: [],
    messageText: "hello world",
    ...overrides,
  };
}

describe("buildTriagePrompt", () => {
  it("embeds the bot name, persona, and operator", () => {
    const prompt = buildTriagePrompt(baseInput());
    expect(prompt).toContain("TRIAGE classifier for Ryoko");
    expect(prompt).toContain("亮介");
    expect(prompt).toContain("strong in coding and product");
  });

  it("marks the speaker as NOT the operator when different", () => {
    const prompt = buildTriagePrompt(baseInput({ speakerIsOperator: false, speakerName: "Alice" }));
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("NOT the operator");
  });

  it("marks the speaker as the operator when they match", () => {
    const prompt = buildTriagePrompt(baseInput({ speakerIsOperator: true, speakerName: "亮介" }));
    expect(prompt).toContain("亮介");
    expect(prompt).toContain("the operator of this Jinn instance");
  });

  it("clearly states mention status", () => {
    const mentioned = buildTriagePrompt(baseInput({ wasMentioned: true }));
    const notMentioned = buildTriagePrompt(baseInput({ wasMentioned: false }));
    expect(mentioned).toContain("@-mentioned in this message? YES");
    expect(notMentioned).toContain("@-mentioned in this message? no");
  });

  it("includes recent thread entries and caps them", () => {
    const thread = Array.from({ length: 15 }, (_, i) => ({
      speaker: `user${i}`,
      text: `message ${i}`,
    }));
    const prompt = buildTriagePrompt(baseInput({ recentThread: thread }));
    // should include at most 10 (MAX_THREAD_ITEMS)
    expect(prompt).toContain("[user14] message 14");
    expect(prompt).toContain("[user5] message 5");
    expect(prompt).not.toContain("[user4] message 4");
  });

  it("truncates extremely long message text", () => {
    const huge = "x".repeat(5000);
    const prompt = buildTriagePrompt(baseInput({ messageText: huge }));
    expect(prompt).toContain("…(truncated)");
    expect(prompt.length).toBeLessThan(huge.length + 2000);
  });

  it("falls back gracefully when persona is missing", () => {
    const prompt = buildTriagePrompt(baseInput({ persona: undefined }));
    expect(prompt).toContain("Ryoko is a helpful AI assistant");
  });

  it("biases strongly toward silence in the principles block", () => {
    const prompt = buildTriagePrompt(baseInput());
    expect(prompt).toContain("Err on the side of SILENCE");
    expect(prompt).toContain("below ~60%");
  });
});

describe("parseTriageDecision", () => {
  it("parses a plain JSON object", () => {
    const d = parseTriageDecision('{"action":"reply","reason":"direct question"}');
    expect(d).toEqual({ action: "reply", emoji: undefined, reason: "direct question" });
  });

  it("parses inside a ```json fenced block", () => {
    const raw = '```json\n{"action":"react","emoji":"thumbsup","reason":"ack"}\n```';
    const d = parseTriageDecision(raw);
    expect(d).toEqual({ action: "react", emoji: "thumbsup", reason: "ack" });
  });

  it("strips colons from emoji written as :eyes:", () => {
    const d = parseTriageDecision('{"action":"react","emoji":":eyes:","reason":"ack"}');
    expect(d?.emoji).toBe("eyes");
  });

  it("defaults emoji to eyes when react has no emoji", () => {
    const d = parseTriageDecision('{"action":"react"}');
    expect(d).toEqual({ action: "react", emoji: "eyes", reason: undefined });
  });

  it("accepts JSON embedded in surrounding prose", () => {
    const raw = `Sure, here is my decision:\n\n{"action":"silent","reason":"casual chat"}\n\nThanks!`;
    const d = parseTriageDecision(raw);
    expect(d?.action).toBe("silent");
  });

  it("returns null for malformed JSON", () => {
    expect(parseTriageDecision("not json at all")).toBeNull();
    expect(parseTriageDecision("")).toBeNull();
    expect(parseTriageDecision('{"action":"something_invalid"}')).toBeNull();
  });

  it("truncates overly long reason strings", () => {
    const longReason = "x".repeat(500);
    const d = parseTriageDecision(`{"action":"silent","reason":"${longReason}"}`);
    expect(d?.reason?.length).toBeLessThanOrEqual(120);
  });
});

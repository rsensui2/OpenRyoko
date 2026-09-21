import { describe, it, expect } from "vitest";
import {
  shouldExtractGoal,
  hasGoalIntent,
  buildGoalExtractionPrompt,
  parseGoalExtractionResult,
  extractGoalCondition,
} from "../goal-extractor.js";
import { EventEmitter } from "node:events";

describe("shouldExtractGoal — accepts substantive messages", () => {
  it.each([
    // Substantive task requests (Haiku will decide if they need /goal)
    "OpenRyokoのGithub調査して紹介資料作成まで「最後までやって」",
    "5社のSaaSを比較した表をスレッドに投げて",
    "数字1から3までを別々のターンで出して完了と書いたら止まる",
    "ブログ記事のドラフトを書いて",
    "Just tell me about Tailscale",
  ])("accepts %s", (text) => {
    expect(shouldExtractGoal(text)).toBe(true);
  });
});

describe("shouldExtractGoal — skips trivial / pre-prefixed messages", () => {
  it("skips empty", () => {
    expect(shouldExtractGoal("")).toBe(false);
  });
  it("skips whitespace-only", () => {
    expect(shouldExtractGoal("   \n\t  ")).toBe(false);
  });
  it("skips very short acknowledgements", () => {
    expect(shouldExtractGoal("ok")).toBe(false);
    expect(shouldExtractGoal("thanks")).toBe(false);
    expect(shouldExtractGoal("はい")).toBe(false);
    expect(shouldExtractGoal("👍")).toBe(false);
  });
  it("skips messages already prefixed with /goal", () => {
    expect(shouldExtractGoal("/goal Posted the comparison\n\nfollow up")).toBe(false);
  });
});

describe("hasGoalIntent (deprecated alias)", () => {
  it("forwards to shouldExtractGoal", () => {
    expect(hasGoalIntent("a substantive request")).toBe(true);
    expect(hasGoalIntent("ok")).toBe(false);
    expect(hasGoalIntent("")).toBe(false);
  });
});

describe("extractGoalCondition", () => {
  it("is disabled by default", async () => {
    const spawnImpl = (() => {
      throw new Error("should not spawn");
    }) as any;
    await expect(extractGoalCondition("最後までやって", { spawnImpl })).resolves.toBeNull();
  });

  it("can use Codex for extraction while still returning a /goal condition", async () => {
    let spawnedArgs: string[] = [];
    const spawnImpl = ((_bin: string, args: string[]) => {
      spawnedArgs = args;
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from(JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: '{"condition":"All requested work is complete"}',
          },
        })));
        proc.emit("close", 0);
      });
      return proc;
    }) as any;

    await expect(extractGoalCondition("OpenRyokoのGithub調査して紹介資料作成まで最後までやって", {
      enabled: true,
      engine: "codex",
      model: "gpt-5-nano",
      spawnImpl,
    })).resolves.toBe("All requested work is complete");
    expect(spawnedArgs).toContain("exec");
    expect(spawnedArgs).toContain("--json");
    expect(spawnedArgs).toContain("gpt-5-nano");
  });
});

describe("buildGoalExtractionPrompt", () => {
  it("embeds the user message verbatim", () => {
    const p = buildGoalExtractionPrompt("テスト最後までやってね");
    expect(p).toContain("テスト最後までやってね");
  });

  it("instructs JSON output with condition key", () => {
    const p = buildGoalExtractionPrompt("anything");
    expect(p).toContain('"condition"');
    expect(p).toContain("JSON only");
  });

  it("biases the LLM toward null on ambiguity", () => {
    const p = buildGoalExtractionPrompt("anything");
    expect(p).toContain('{"condition": null}');
    expect(p).toContain("be conservative");
    expect(p).toMatch(/when in doubt[, ]+null/i);
  });

  it("documents the four trigger families (keep-going, notify, embedded stop, pipeline)", () => {
    const p = buildGoalExtractionPrompt("anything");
    expect(p).toContain("完成するまで止まらないで");
    expect(p).toContain("終わったらSlackで教えて");
    expect(p).toContain("完了と書いたら止まる");
    expect(p).toContain("AUTONOMOUSLY ACROSS MANY TURNS");
  });

  it("truncates very long messages", () => {
    const huge = "x".repeat(20000);
    const p = buildGoalExtractionPrompt(huge);
    expect(p).toContain("…(truncated)");
    expect(p.length).toBeLessThan(huge.length + 4000);
  });
});

describe("parseGoalExtractionResult — happy path", () => {
  it("parses a plain JSON object", () => {
    const out = parseGoalExtractionResult(
      '{"condition":"Posted a comparison table to the thread"}',
    );
    expect(out).toBe("Posted a comparison table to the thread");
  });

  it("parses inside a fenced ```json``` block", () => {
    const out = parseGoalExtractionResult(
      '```json\n{"condition":"Closed every open Linear issue under project A"}\n```',
    );
    expect(out).toBe("Closed every open Linear issue under project A");
  });

  it("accepts JSON wrapped in surrounding prose", () => {
    const out = parseGoalExtractionResult(
      'Sure, here it is:\n\n{"condition":"All five SaaS rows added"}\n\nDone.',
    );
    expect(out).toBe("All five SaaS rows added");
  });

  it("flattens whitespace and trims", () => {
    const out = parseGoalExtractionResult(
      '{"condition":"  Posted   the\\n    table\\nto the thread.  "}',
    );
    expect(out).toBe("Posted the table to the thread.");
  });

  it("strips control characters", () => {
    const out = parseGoalExtractionResult(
      JSON.stringify({ condition: "Done with task X" }),
    );
    expect(out).toBe("Done with task X");
  });

  it("hard caps at 400 chars", () => {
    const long = "x".repeat(800);
    const out = parseGoalExtractionResult(JSON.stringify({ condition: long }));
    expect(out!.length).toBeLessThanOrEqual(400);
  });
});

describe("parseGoalExtractionResult — null / refusals", () => {
  it("returns null for explicit null condition", () => {
    expect(parseGoalExtractionResult('{"condition":null}')).toBeNull();
  });

  it("returns null for empty string condition", () => {
    expect(parseGoalExtractionResult('{"condition":""}')).toBeNull();
  });

  it("returns null for whitespace-only condition", () => {
    expect(parseGoalExtractionResult('{"condition":"   \\n\\t  "}')).toBeNull();
  });

  it("returns null for unparseable output", () => {
    expect(parseGoalExtractionResult("not json")).toBeNull();
    expect(parseGoalExtractionResult("")).toBeNull();
    expect(parseGoalExtractionResult("{}")).toBeNull();
  });

  it("returns null for sentinel placeholders", () => {
    for (const v of ["none", "N/A", "null", "unknown", "tbd"]) {
      expect(parseGoalExtractionResult(JSON.stringify({ condition: v }))).toBeNull();
    }
  });

  it("returns null for human-judgement conditions starting with 'The user is'", () => {
    const out = parseGoalExtractionResult(
      JSON.stringify({ condition: "The user is satisfied with the result." }),
    );
    expect(out).toBeNull();
  });
});

describe("parseGoalExtractionResult — security", () => {
  it("rejects conditions starting with '/' to prevent slash command injection", () => {
    expect(
      parseGoalExtractionResult('{"condition":"/permission grant write"}'),
    ).toBeNull();
  });

  it("does not allow a forged '/goal' nested inside another /goal", () => {
    expect(
      parseGoalExtractionResult('{"condition":"/goal something else"}'),
    ).toBeNull();
  });
});

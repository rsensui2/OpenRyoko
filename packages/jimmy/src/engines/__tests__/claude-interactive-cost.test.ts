import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));
import { computeInteractiveCost, sumTranscriptUsage } from "../claude-interactive.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function message(id: string, model?: string, usage: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "assistant", timestamp: "2026-09-23T00:00:00Z",
    message: { id, model, usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, ...usage } } });
}

describe("interactive Opus 5.5 cost", () => {
  it.each(["claude-opus-5-5", "claude-opus-5-5-20260922"])("prices %s with cache reads and both write durations", (model) => {
    const line = message("new", model, {
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
    });
    // Duplicate thinking/text records count only once; earlier turns are excluded.
    const old = message("old", "claude-opus-5").replace("2026-09-23", "2026-09-22");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-opus-cost-"));
    dirs.push(dir);
    const transcript = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(transcript, [old, line, line].join("\n"));
    const result = computeInteractiveCost(transcript, "claude-opus-5", Date.parse("2026-09-23T00:00:00Z"));
    expect(result?.cost).toBeCloseTo(4 + 20 + 0.20 + 5 + 8);
    expect(result?.turns).toBe(1);
  });

  it("prices each model independently when a transcript switches generations", () => {
    const usage = sumTranscriptUsage([
      message("old", "claude-opus-5"), message("new", "claude-opus-5-5"),
    ].join("\n"));
    expect(usage.cost).toBe(30 + 24);
  });

  it("uses the configured alias only when a concrete model is absent", () => {
    expect(sumTranscriptUsage(message("alias"), undefined, "opus").cost).toBe(24);
    expect(sumTranscriptUsage(message("old", "claude-opus-5"), undefined, "opus").cost).toBe(30);
  });

  it("prices undifferentiated cache creation as five-minute writes", () => {
    expect(sumTranscriptUsage(message("new", "claude-opus-5-5", {
      cache_creation_input_tokens: 1_000_000,
    })).cost).toBe(29);
  });
});

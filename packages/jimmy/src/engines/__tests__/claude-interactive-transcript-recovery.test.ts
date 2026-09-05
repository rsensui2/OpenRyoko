import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { findTranscriptForSession, lastAssistantTextFromTranscript, stripReasoningBlocks } from "../claude-interactive.js";

// Lost-Stop recovery reads the turn's final assistant message straight from
// Claude Code's on-disk transcript (~/.claude/projects/<cwd-slug>/<sid>.jsonl).

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-recovery-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeTranscript(projectsDir: string, slugDir: string, sid: string, lines: unknown[]): string {
  const dir = path.join(projectsDir, slugDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

const assistantLine = (text: string, ts?: string) => ({
  type: "assistant",
  ...(ts ? { timestamp: ts } : {}),
  message: { content: [{ type: "text", text }] },
});

describe("findTranscriptForSession", () => {
  it("resolves the direct cwd-slug path", () => {
    const projects = path.join(tmp, "projects");
    const home = "/home/user/.ryoko";
    const expected = writeTranscript(projects, "-home-user--ryoko", "sid-1", [assistantLine("hi")]);
    expect(findTranscriptForSession("sid-1", home, projects)).toBe(expected);
  });

  it("falls back to scanning project dirs when the slug misses", () => {
    const projects = path.join(tmp, "projects");
    const expected = writeTranscript(projects, "-some-other-dir", "sid-2", [assistantLine("hi")]);
    expect(findTranscriptForSession("sid-2", "/home/user/.ryoko", projects)).toBe(expected);
  });

  it("returns undefined for a missing session or projects dir", () => {
    expect(findTranscriptForSession("nope", "/home/user/.ryoko", path.join(tmp, "absent"))).toBeUndefined();
    expect(findTranscriptForSession("", "/home/user/.ryoko", tmp)).toBeUndefined();
  });
});

describe("lastAssistantTextFromTranscript", () => {
  it("returns the LAST assistant text block", () => {
    const p = writeTranscript(path.join(tmp, "projects"), "-x", "sid-3", [
      { type: "user", message: { content: "question" } },
      assistantLine("first"),
      { type: "system", subtype: "turn_duration" },
      assistantLine("final answer"),
    ]);
    expect(lastAssistantTextFromTranscript(p)).toBe("final answer");
  });

  it("honors the afterMs filter — pre-turn history is not 'recovered'", () => {
    const p = writeTranscript(path.join(tmp, "projects"), "-x", "sid-4", [
      assistantLine("stale previous turn", "2026-07-01T00:00:00Z"),
      assistantLine("this turn's answer", "2026-07-02T12:00:00Z"),
    ]);
    const afterMs = Date.parse("2026-07-02T00:00:00Z");
    expect(lastAssistantTextFromTranscript(p, afterMs)).toBe("this turn's answer");
    const tooLate = Date.parse("2026-07-03T00:00:00Z");
    expect(lastAssistantTextFromTranscript(p, tooLate)).toBeUndefined();
  });

  it("skips unparseable lines and non-text content", () => {
    const dir = path.join(tmp, "projects", "-x");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "sid-5.jsonl");
    fs.writeFileSync(p, [
      "not json at all",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
      JSON.stringify(assistantLine("real text")),
    ].join("\n"));
    expect(lastAssistantTextFromTranscript(p)).toBe("real text");
  });
});

describe("stripReasoningBlocks", () => {
  it("removes thinking/reasoning tags and fenced thinking blocks", () => {
    expect(stripReasoningBlocks("<thinking>secret</thinking>\n\nanswer")).toBe("answer");
    expect(stripReasoningBlocks("```thinking\nsecret\n```\nanswer")).toBe("answer");
    expect(stripReasoningBlocks("plain answer")).toBe("plain answer");
  });
});

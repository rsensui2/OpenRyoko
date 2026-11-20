import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JINN_HOME } from "../../shared/paths.js";
import { peerKnowledgeDir, peerMemoryPath } from "../../shared/peer-ryoko.js";
import type { Employee, JinnConfig } from "../../shared/types.js";
import { buildContext } from "../context.js";

/* A peer Ryoko's prompt. Properties under test: memory "own" never carries
 * the main MEMORY.md and does carry its own; "shared" carries the main one;
 * both stay behind the same privacy gate as the main Ryoko; and a peer is
 * framed as an assistant of its own, not an employee. */

const config = {
  gateway: { host: "127.0.0.1", port: 7777 },
  engines: { default: "claude", claude: { bin: "claude", model: "" }, codex: { bin: "codex", model: "" } },
  connectors: {},
  logging: { level: "info", stdout: false, file: false },
  portal: { portalName: "Ryoko", trustedSpeakers: ["U0TRUSTED"] },
} as unknown as JinnConfig;

const MAIN_SECRET = "MAIN-MEMORY-FACT-7731";
const OWN_SECRET = "OWN-MEMORY-FACT-4410";

function peer(memory: "shared" | "own"): Employee {
  return {
    name: "hana", displayName: "Hana", department: "ryokos", rank: "executive", engine: "codex",
    persona: "Calm research partner.", peer: { memory },
  };
}

function prompt(employee: Employee | undefined, where: { source: string; channel: string; speakerSlackId?: string }, parentSessionId?: string): string {
  return buildContext({ ...where, user: "someone", employee, config, parentSessionId });
}

const trustedDm = { source: "slack", channel: "D0123", speakerSlackId: "U0TRUSTED" };
const untrustedDm = { source: "slack", channel: "D0123", speakerSlackId: "U0STRANGER" };
const sharedChannel = { source: "slack", channel: "C0123", speakerSlackId: "U0TRUSTED" };

beforeEach(() => {
  fs.mkdirSync(JINN_HOME, { recursive: true });
  fs.writeFileSync(path.join(JINN_HOME, "MEMORY.md"), `- ${MAIN_SECRET}\n`);
  fs.mkdirSync(peerKnowledgeDir("hana"), { recursive: true });
  fs.writeFileSync(peerMemoryPath("hana"), `- ${OWN_SECRET}\n`);
  fs.mkdirSync(path.join(JINN_HOME, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(JINN_HOME, "knowledge", "main-topic.md"), "main");
  fs.writeFileSync(path.join(peerKnowledgeDir("hana"), "own-topic.md"), "own");
});

afterEach(() => {
  fs.rmSync(path.join(JINN_HOME, "MEMORY.md"), { force: true });
  fs.rmSync(path.join(JINN_HOME, "ryokos"), { recursive: true, force: true });
  fs.rmSync(path.join(JINN_HOME, "knowledge"), { recursive: true, force: true });
});

describe("peer Ryoko with its own memory", () => {
  it("injects its own MEMORY.md, never the main one, in web sessions and trusted DMs", () => {
    for (const where of [{ source: "web", channel: "web" }, trustedDm]) {
      const text = prompt(peer("own"), where);
      expect(text).toContain(OWN_SECRET);
      expect(text).not.toContain(MAIN_SECRET);
    }
  });

  it("injects nothing in an untrusted DM or a shared channel", () => {
    for (const where of [untrustedDm, sharedChannel]) {
      const text = prompt(peer("own"), where);
      expect(text).not.toContain(OWN_SECRET);
      expect(text).not.toContain(MAIN_SECRET);
    }
  });

  it("points self-evolution and the knowledge listing at its own folder", () => {
    const text = prompt(peer("own"), { source: "web", channel: "web" });
    expect(text).toContain(`→ \`${peerMemoryPath("hana")}\``);
    expect(text).toContain(`quote or write \`${JINN_HOME}/MEMORY.md\``);
    expect(text).toContain("own-topic.md");
    expect(text).not.toContain("main-topic.md");
  });
});

describe("peer Ryoko sharing the main memory", () => {
  it("injects the main MEMORY.md under the same gate", () => {
    expect(prompt(peer("shared"), { source: "web", channel: "web" })).toContain(MAIN_SECRET);
    expect(prompt(peer("shared"), trustedDm)).toContain(MAIN_SECRET);
    expect(prompt(peer("shared"), untrustedDm)).not.toContain(MAIN_SECRET);
    expect(prompt(peer("shared"), sharedChannel)).not.toContain(MAIN_SECRET);
  });

  it("never reads the peer's own files", () => {
    const text = prompt(peer("shared"), { source: "web", channel: "web" });
    expect(text).not.toContain(OWN_SECRET);
    expect(text).toContain(`→ \`${JINN_HOME}/MEMORY.md\` (shared with Ryoko`);
  });
});

describe("peer identity", () => {
  it("is an assistant of its own with its persona and engine, not an AI employee", () => {
    const text = prompt(peer("own"), { source: "web", channel: "web" });
    expect(text).toContain("# You are Hana");
    expect(text).toContain("Calm research partner.");
    expect(text).toContain("- **Engine**: codex");
    expect(text).not.toContain("You are an AI employee");
    expect(text).not.toContain("## Employee Delegation");
  });

  it("leaves a plain employee without memory or self-evolution", () => {
    const employee: Employee = { name: "dev", displayName: "Dev", department: "eng", rank: "employee", engine: "claude", persona: "Builds." };
    const text = prompt(employee, { source: "web", channel: "web" });
    expect(text).toContain("You are an AI employee");
    expect(text).not.toContain(MAIN_SECRET);
    expect(text).not.toContain("## Self-evolution");
  });
});

describe("own memory boundary (AGENTS.md tells every engine to use MEMORY.md and knowledge/)", () => {
  it("forbids reading or searching the main memory and other Ryokos, overriding AGENTS.md", () => {
    const text = prompt(peer("own"), sharedChannel);
    expect(text).toContain("this overrides AGENTS.md");
    expect(text).toContain(`Never read, open, search (grep/find/rg/ls), quote or write \`${JINN_HOME}/MEMORY.md\` or anything under \`${JINN_HOME}/knowledge/\``);
    expect(text).toContain(`Never read or search other Ryokos' folders under \`${path.join(JINN_HOME, "ryokos")}/\``);
    expect(text).toContain(`search \`${peerKnowledgeDir("hana")}/\` — nowhere else`);
  });

  it("keeps the boundary even when the prompt is trimmed to its essentials", () => {
    const tight = { ...config, context: { maxChars: 1 } } as unknown as JinnConfig;
    const text = buildContext({ source: "web", channel: "web", user: "someone", employee: peer("own"), config: tight });
    expect(text).toContain("this overrides AGENTS.md");
  });

  it("says nothing of the kind to a shared-memory peer", () => {
    expect(prompt(peer("shared"), { source: "web", channel: "web" })).not.toContain("overrides AGENTS.md");
  });
});

describe("delegated children", () => {
  it("never carry a peer's memory, in either mode", () => {
    for (const memory of ["own", "shared"] as const) {
      const text = prompt(peer(memory), { source: "web", channel: "web" }, "parent-session-1");
      expect(text).not.toContain(OWN_SECRET);
      expect(text).not.toContain(MAIN_SECRET);
    }
  });

  it("leave the main Ryoko's behavior unchanged", () => {
    expect(prompt(undefined, { source: "web", channel: "web" }, "parent-session-1")).toContain(MAIN_SECRET);
  });
});

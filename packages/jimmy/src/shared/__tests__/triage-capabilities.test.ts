import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTriageCapabilities,
  invalidateTriageCapabilities,
  TRIAGE_CAPABILITY_LIMITS as limits,
} from "../triage-capabilities.js";

let root: string;
let skillsDir: string;
function writeSkill(name: string, content: string): void {
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), content);
}
function skill(name: string, description: string): void {
  writeSkill(name, `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nPRIVATE_BODY_SENTINEL`);
}
function snapshot(options: Parameters<typeof getTriageCapabilities>[0] = {}) {
  return getTriageCapabilities({ skillsDir, now: 1000, ...options });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "triage-capabilities-"));
  skillsDir = path.join(root, "skills");
  fs.mkdirSync(skillsDir);
  invalidateTriageCapabilities();
});
afterEach(() => {
  vi.restoreAllMocks();
  invalidateTriageCapabilities();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded triage capability snapshot", () => {
  it("exports only frontmatter descriptions and this employee's declared role/services", () => {
    writeSkill("slides", `---\nname: slide-maker\ndescription: >-\n  日本語のスライドを\n  作成する\napiKey: hidden-frontmatter-key\nmcp: hidden-mcp-config\n---\nPRIVATE_BODY_SENTINEL\n## Trigger\nNever send this paragraph`);
    const result = snapshot({ employee: { persona: "資料作成を担当", provides: [{ name: "slides", description: "営業資料の制作" }] } });
    expect(result).toEqual({ role: "資料作成を担当", skills: [{ name: "slide-maker", description: "日本語のスライドを 作成する" }], services: [{ name: "slides", description: "営業資料の制作" }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY|hidden-|Trigger/);
  });

  it("prefers an explicit role override and does not retain employees between requests", () => {
    const first = snapshot({ personaOverride: "画像生成担当", employee: { persona: "営業担当", provides: [{ name: "sales", description: "商談準備" }] } });
    expect(first.role).toBe("画像生成担当");
    expect(snapshot()).toEqual({ skills: [] });
  });

  it("never falls back to skill body text when frontmatter is absent, malformed, or oversized", () => {
    writeSkill("body-only", "# Read me\n## Trigger\nPRIVATE_BODY_SENTINEL");
    writeSkill("malformed", "---\ndescription: [bad\n---\nPRIVATE_BODY_SENTINEL");
    writeSkill("large-header", `---\ndescription: ${"x".repeat(limits.headerBytes)}\n---\nPRIVATE_BODY_SENTINEL`);
    const read = vi.spyOn(fs, "readSync");
    expect(snapshot()).toEqual({ skills: [], truncated: true });
    expect(read.mock.calls).toHaveLength(3);
    for (const args of read.mock.calls) expect((args as unknown[])[3]).toBe(limits.headerBytes);
  });

  it("allows shared skill-directory symlinks but rejects a SKILL.md link outside that skill", () => {
    const shared = path.join(root, "shared-skill");
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "SKILL.md"), "---\nname: shared\ndescription: Shared slide generation\n---\nPRIVATE_BODY_SENTINEL");
    fs.symlinkSync(shared, path.join(skillsDir, "shared"), "dir");
    fs.mkdirSync(path.join(skillsDir, "escape"));
    const unrelated = path.join(root, "unrelated-private.md");
    fs.writeFileSync(unrelated, "---\nname: stolen\ndescription: PRIVATE_BODY_SENTINEL\n---");
    fs.symlinkSync(unrelated, path.join(skillsDir, "escape", "SKILL.md"));
    fs.symlinkSync(path.join(root, "missing"), path.join(skillsDir, "broken"), "dir");
    expect(snapshot()).toEqual({ skills: [{ name: "shared", description: "Shared slide generation" }], truncated: true });
  });

  it("returns no credential values, private URL, or email from descriptive metadata", () => {
    const credential = "apikey_0123456789abcdef_0123456789abcdef";
    skill("safe-name", `資料作成 ${credential} https://private.example/customer alice@example.test`);
    const result = snapshot({ employee: { persona: "API_KEY=role-secret\n担当", provides: [{ name: "service", description: "xoxb-123456789-secret-value" }] } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/0123456789abcdef|private\.example|alice@|role-secret|123456789-secret/);
    expect(result.skills[0].description).toContain("資料作成");
  });

  it("caches only the catalog for 30 seconds and refreshes after expiry or explicit invalidation", () => {
    skill("slides", "original");
    expect(snapshot().skills[0].description).toBe("original");
    skill("slides", "updated");
    const read = vi.spyOn(fs, "readSync");
    expect(snapshot({ now: 1001 }).skills[0].description).toBe("original");
    expect(read).not.toHaveBeenCalled();
    expect(snapshot({ now: 1000 + limits.cacheTtlMs }).skills[0].description).toBe("updated");
    skill("slides", "invalidated");
    invalidateTriageCapabilities(skillsDir);
    expect(snapshot({ now: 1001 }).skills[0].description).toBe("invalidated");
  });

  it("selects different English/Japanese skills for each message without caching message text", () => {
    for (let i = 0; i < 30; i++) skill(`generic-${String(i).padStart(2, "0")}`, "General capability");
    skill("zz-slides", "営業スライドの作成");
    skill("zz-pdf", "PDF export and extraction");
    const japanese = snapshot({ messageText: "営業スライドの作成をお願い。SECRET_MESSAGE_NOT_METADATA" });
    expect(japanese.skills[0].name).toBe("zz-slides");
    expect(japanese.skills).toHaveLength(limits.snapshotSkills);
    expect(japanese.truncated).toBe(true);
    const english = snapshot({ messageText: "Can someone extract this PDF?" });
    expect(english.skills[0].name).toBe("zz-pdf");
    expect(JSON.stringify(english)).not.toContain("SECRET_MESSAGE_NOT_METADATA");
  });

  it("bounds catalog reads, selected skill count, individual fields, and total descriptive characters", () => {
    for (let i = 0; i < limits.candidateCount + 5; i++) {
      writeSkill(`skill-${i}`, `---\nname: ${JSON.stringify(`skill-${i} ${"safe name ".repeat(15)}`)}\ndescription: ${JSON.stringify("役立つ説明の文章です。 ".repeat(80))}\n---`);
    }
    const read = vi.spyOn(fs, "readSync");
    const result = snapshot({ employee: {
      persona: "role ".repeat(1000),
      provides: Array.from({ length: 12 }, (_, i) => ({ name: `service-${i}`, description: "service ".repeat(100) })),
    } });
    expect(read.mock.calls.length).toBeLessThanOrEqual(limits.candidateCount);
    expect(result.skills.length).toBeLessThan(limits.snapshotSkills);
    expect(result.services).toHaveLength(limits.snapshotServices);
    expect(result.role!.length).toBe(limits.roleChars);
    const total = result.role!.length + [...result.skills, ...result.services!].reduce((sum, item) => sum + item.name.length + item.description.length, 0);
    expect(total).toBeLessThanOrEqual(limits.snapshotChars);
    expect(total).toBeGreaterThan(limits.snapshotChars - limits.nameChars - limits.descriptionChars);
    expect(result.truncated).toBe(true);
    expect(result.skills.every((item) => item.name.length === limits.nameChars && item.description.length === limits.descriptionChars)).toBe(true);
  });

  it("never reads more than 128 skill files even when the catalog has many short descriptions", () => {
    for (let i = 0; i < limits.candidateCount + 5; i++) skill(`skill-${i}`, "A short description");
    const read = vi.spyOn(fs, "readSync");
    expect(snapshot().truncated).toBe(true);
    expect(read.mock.calls).toHaveLength(limits.candidateCount);
  });

  it("handles an unavailable catalog and cannot be corrupted by mutating a returned snapshot", () => {
    skill("slides", "Original description");
    const first = snapshot();
    first.skills[0].description = "corrupted";
    first.skills.length = 0;
    expect(snapshot().skills[0].description).toBe("Original description");
    expect(snapshot({ skillsDir: path.join(root, "missing") })).toEqual({ skills: [], truncated: true });
  });
});

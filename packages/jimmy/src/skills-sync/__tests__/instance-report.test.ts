import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// What the start-up hook says about a run. The run itself is the engine's business.
vi.mock("../sync.js", () => ({
  syncBundledSkills: vi.fn(),
}));

import { logger } from "../../shared/logger.js";
import { syncBundledSkillsOnBoot } from "../instance.js";
import { syncBundledSkills } from "../sync.js";
import type { BundledSkillSync } from "../types.js";

function ran(overrides: Partial<BundledSkillSync> = {}): void {
  vi.mocked(syncBundledSkills).mockReturnValue({
    added: [], updated: [], adopted: [], retired: [], kept: [], notices: [], inSync: [], failed: [], backupDir: null,
    ...overrides,
  });
}

let log: Record<"debug" | "info" | "warn" | "error", MockInstance<(message: string) => void>>;
const said = (level: keyof typeof log): string[] => log[level].mock.calls.map((call) => call[0]);

beforeEach(() => {
  log = {
    debug: vi.spyOn(logger, "debug").mockImplementation(() => {}),
    info: vi.spyOn(logger, "info").mockImplementation(() => {}),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => {}),
    error: vi.spyOn(logger, "error").mockImplementation(() => {}),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what gateway start logs about the bundled skill sync", () => {
  it("is silent when the run changed nothing and has nothing new to announce", () => {
    ran({ kept: [{ name: "migrate", reason: "modified" }, { name: "status", reason: "symlink" }], inSync: ["sync"] });

    syncBundledSkillsOnBoot({});

    for (const level of ["debug", "info", "warn", "error"] as const) expect(said(level), level).toEqual([]);
  });

  it("names every skill it added, replaced or retired, and where the previous copies went", () => {
    const backupDir = "/home/.migration-backups/2026.10.11-2026-10-12T03-04-05-678Z";
    ran({ added: ["brand-new"], updated: ["migrate", "status"], retired: ["old-skill"], adopted: ["sync"], backupDir });

    syncBundledSkillsOnBoot({});

    expect(said("info")).toHaveLength(1);
    const [line] = said("info");
    expect(line).toContain("added brand-new");
    expect(line).toContain("updated migrate, status");
    expect(line).toContain("retired old-skill");
    expect(line).toContain("now tracking 1 unmodified (sync)");
    expect(line).toContain(backupDir);
    expect(said("warn")).toEqual([]);
  });

  it("does not mention a backup directory when nothing was moved", () => {
    ran({ added: ["brand-new"] });

    syncBundledSkillsOnBoot({});

    expect(said("info")).toEqual([expect.not.stringContaining("Previous copies")]);
  });

  it("says an edited skill is missing a newer shipped version, and how to take it", () => {
    ran({ kept: [{ name: "onboarding", reason: "modified" }], notices: [{ name: "onboarding", reason: "modified" }] });

    syncBundledSkillsOnBoot({});

    expect(said("warn")).toHaveLength(1);
    expect(said("warn")[0]).toMatch(/edited locally: onboarding\./);
    // Moving a recorded skill aside only records a deletion, whatever runs next:
    // a restart and a plain ryoko migrate both leave it out. The option brings it
    // back — by name, so that other skills the operator deleted stay deleted.
    expect(said("warn")[0]).toContain('"ryoko migrate --restore-deleted-skills <name>"');
    expect(said("warn")[0]).not.toContain("restart");
    expect(said("warn")[0]).toContain("docs/skills.md");
  });

  it("does not call an unrecorded skill edited: it may just be an older shipped copy", () => {
    ran({ kept: [{ name: "migrate", reason: "unmanaged" }], notices: [{ name: "migrate", reason: "unmanaged" }] });

    syncBundledSkillsOnBoot({});

    expect(said("warn")).toHaveLength(1);
    expect(said("warn")[0]).toMatch(/: migrate\./);
    expect(said("warn")[0]).toContain("older shipped copy");
    expect(said("warn")[0]).not.toContain("edited locally");
    // Nothing recorded means nothing to mistake for a deletion: a restart reinstalls it.
    expect(said("warn")[0]).toMatch(/move the skill's directory aside and restart/);
    expect(said("warn")[0]).not.toContain("--restore-deleted-skills");
    expect(said("warn")[0]).toContain("docs/skills.md");
  });

  it("says a skill the operator removed was left out, and how to put it back", () => {
    ran({ kept: [{ name: "status", reason: "deleted" }], notices: [{ name: "status", reason: "deleted" }] });

    syncBundledSkillsOnBoot({});

    // The operator's own choice: worth a line, not a warning.
    expect(said("info")).toEqual([expect.stringMatching(/removed from this home: status\./)]);
    expect(said("info")[0]).toContain('"ryoko migrate --restore-deleted-skills <name>"');
    expect(said("warn")).toEqual([]);
  });

  it("keeps the kinds of untouched skill apart", () => {
    ran({ notices: [
      { name: "onboarding", reason: "modified" },
      { name: "migrate", reason: "unmanaged" },
      { name: "new", reason: "deleted" },
      { name: "status", reason: "unmanaged" },
    ] });

    syncBundledSkillsOnBoot({});

    expect(said("warn")).toEqual([
      expect.stringMatching(/edited locally: onboarding\./),
      expect.stringMatching(/older shipped copy.*: migrate, status\./),
    ]);
    expect(said("info")).toEqual([expect.stringMatching(/removed from this home: new\./)]);
  });

  it("warns once for each skill that could not be synced", () => {
    ran({ added: ["sync"], failed: [{ name: "migrate", error: "disk full" }, { name: "status", error: "EACCES" }] });

    syncBundledSkillsOnBoot({});

    expect(said("warn")).toEqual([
      'Bundled skill "migrate" was not synced: disk full',
      'Bundled skill "status" was not synced: EACCES',
    ]);
  });

  it.each(["skills-root-symlink", "newer-receipt"] as const)("only mentions a %s skip at debug level", (skipped) => {
    ran({ skipped });

    syncBundledSkillsOnBoot({});

    expect(said("debug")).toHaveLength(1);
    for (const level of ["info", "warn", "error"] as const) expect(said(level), level).toEqual([]);
  });
});

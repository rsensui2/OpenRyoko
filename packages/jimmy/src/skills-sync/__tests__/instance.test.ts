import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { stageMissingBundledSkills } from "../../cli/bundled-skills.js";
import { logger } from "../../shared/logger.js";
import { CONFIG_PATH, JINN_HOME, SKILLS_DIR, TEMPLATE_DIR } from "../../shared/paths.js";
import { buildTemplateReplacements } from "../../shared/templateReplacements.js";
import { getInstanceVersion, getPackageVersion, getPendingMigrations } from "../../shared/version.js";
import { syncBundledSkillsOnBoot, syncInstanceBundledSkills } from "../instance.js";
import { RECEIPT_FILE } from "../receipt.js";
import { snapshot } from "./fixture.js";

// JINN_HOME is the throwaway per-worker home from vitest.setup.ts; the package template is the real one.
const BACKUPS = path.join(JINN_HOME, ".migration-backups");
const ELSEWHERE = path.join(JINN_HOME, "user-skill-store");
const CONFIG = [
  "# hand-written comment the sync must not disturb",
  "jinn:",
  '  version: "2026.9.1"',
  "portal:",
  "  portalName: Momo",
  "",
].join("\n");

const shipped = fs.readdirSync(path.join(TEMPLATE_DIR, "skills"))
  .filter((name) => fs.existsSync(path.join(TEMPLATE_DIR, "skills", name, "SKILL.md")))
  .sort();
const receipt = () => JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, RECEIPT_FILE), "utf8"));
const readSkill = (name: string) => fs.readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");

function resetHome(): void {
  for (const target of [SKILLS_DIR, BACKUPS, ELSEWHERE, CONFIG_PATH]) fs.rmSync(target, { recursive: true, force: true });
}

/** The home as the previous release left it: every shipped skill installed for "Momo", no receipt. */
function installAsPreviousRelease(): void {
  stageMissingBundledSkills(TEMPLATE_DIR, JINN_HOME, buildTemplateReplacements("Momo"));
}

let log: Record<"debug" | "info" | "warn" | "error", MockInstance<(message: string) => void>>;

beforeEach(() => {
  resetHome();
  fs.writeFileSync(CONFIG_PATH, CONFIG);
  log = {
    debug: vi.spyOn(logger, "debug").mockImplementation(() => {}),
    info: vi.spyOn(logger, "info").mockImplementation(() => {}),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => {}),
    error: vi.spyOn(logger, "error").mockImplementation(() => {}),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  resetHome();
});

describe("the skills this package ships", () => {
  it("all sync into an empty home, rendered for the instance", () => {
    expect(shipped.length).toBeGreaterThan(5);

    const result = syncInstanceBundledSkills();

    expect(result).toMatchObject({ added: shipped, kept: [], failed: [], notices: [] });
    expect(Object.keys(receipt().skills)).toEqual(shipped);
    expect(receipt().packageVersion).toBe(getPackageVersion());
    expect(readSkill("migrate")).toContain("Momo");
    for (const name of shipped) expect(readSkill(name), name).not.toMatch(/\{\{portal(Name|Slug)\}\}/);
  });
});

describe("bundled skill sync at gateway start", () => {
  it("on the first start after an upgrade, adds what is missing, records what matches, and leaves the rest", () => {
    installAsPreviousRelease();
    // One skill the release added, one the user edited, one the user keeps elsewhere.
    fs.rmSync(path.join(SKILLS_DIR, "sync"), { recursive: true });
    const edited = `${readSkill("migrate")}\n## Our own rule\nAsk before every migration.\n`;
    fs.writeFileSync(path.join(SKILLS_DIR, "migrate", "SKILL.md"), edited);
    fs.renameSync(path.join(SKILLS_DIR, "status"), ELSEWHERE);
    fs.symlinkSync(ELSEWHERE, path.join(SKILLS_DIR, "status"));
    const untouched = shipped.filter((name) => !["sync", "migrate", "status"].includes(name));
    const before = Object.fromEntries(untouched.map((name) => [name, snapshot(path.join(SKILLS_DIR, name))]));

    syncBundledSkillsOnBoot({});

    expect(readSkill("sync")).toBe(fs.readFileSync(path.join(TEMPLATE_DIR, "skills", "sync", "SKILL.md"), "utf8"));
    expect(readSkill("migrate")).toBe(edited);
    expect(fs.readlinkSync(path.join(SKILLS_DIR, "status"))).toBe(ELSEWHERE);
    for (const name of untouched) expect(snapshot(path.join(SKILLS_DIR, name)), name).toEqual(before[name]);
    expect(Object.keys(receipt().skills)).toEqual(shipped.filter((name) => name !== "migrate" && name !== "status"));
    expect(fs.existsSync(BACKUPS)).toBe(false);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toMatch(/added sync/);
    expect(log.info.mock.calls[0][0]).toMatch(new RegExp(`${untouched.length} unmodified`));
    // No receipt yet, so the edit cannot be told from an older shipped copy — and is not called one.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/left untouched.*: migrate\./);
    expect(log.warn.mock.calls[0][0]).not.toContain("edited locally");
    expect(log.warn.mock.calls[0][0]).not.toContain("status");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("says nothing and writes nothing on the next start", () => {
    installAsPreviousRelease();
    fs.writeFileSync(path.join(SKILLS_DIR, "migrate", "SKILL.md"), "the user's own migrate skill");
    syncBundledSkillsOnBoot({});
    for (const spy of Object.values(log)) spy.mockClear();
    const before = snapshot(SKILLS_DIR);

    syncBundledSkillsOnBoot({});

    expect(snapshot(SKILLS_DIR)).toEqual(before);
    for (const level of ["info", "warn", "error"] as const) expect(log[level], level).not.toHaveBeenCalled();
  });

  it("does not put back a skill the operator deleted, and says so once", () => {
    syncBundledSkillsOnBoot({});
    fs.rmSync(path.join(SKILLS_DIR, "status"), { recursive: true });
    for (const spy of Object.values(log)) spy.mockClear();

    syncBundledSkillsOnBoot({});

    expect(fs.existsSync(path.join(SKILLS_DIR, "status"))).toBe(false);
    expect(receipt().skills.status.deleted).toBe(true);
    expect(log.info.mock.calls.map((call) => call[0])).toEqual([expect.stringMatching(/removed from this home: status\./)]);
    expect(log.info.mock.calls[0][0]).toContain("ryoko migrate --restore-deleted-skills <name>");
    expect(log.warn).not.toHaveBeenCalled();

    for (const spy of Object.values(log)) spy.mockClear();
    syncBundledSkillsOnBoot({});
    expect(fs.existsSync(path.join(SKILLS_DIR, "status"))).toBe(false);
    for (const level of ["info", "warn", "error"] as const) expect(log[level], level).not.toHaveBeenCalled();
  });

  it("keeps a deleted skill out for a plain ryoko migrate too, and puts it back only on request", () => {
    syncBundledSkillsOnBoot({});
    fs.rmSync(path.join(SKILLS_DIR, "status"), { recursive: true });
    syncBundledSkillsOnBoot({});

    expect(syncInstanceBundledSkills()).toMatchObject({ added: [], kept: [{ name: "status", reason: "deleted" }] });
    expect(fs.existsSync(path.join(SKILLS_DIR, "status"))).toBe(false);

    // By name: the other deleted skill stays out.
    fs.rmSync(path.join(SKILLS_DIR, "sync"), { recursive: true });
    expect(syncInstanceBundledSkills({ restoreDeleted: ["sync"] }).added).toEqual(["sync"]);
    expect(fs.existsSync(path.join(SKILLS_DIR, "status"))).toBe(false);

    const result = syncInstanceBundledSkills({ restoreDeleted: true });

    expect(result.added).toEqual(["status"]);
    expect(readSkill("status")).toBe(fs.readFileSync(path.join(TEMPLATE_DIR, "skills", "status", "SKILL.md"), "utf8"));
    expect(receipt().skills.status).not.toHaveProperty("deleted");
  });

  it("does nothing when skills.autoSync is false", () => {
    syncBundledSkillsOnBoot({ skills: { autoSync: false } });

    expect(fs.existsSync(SKILLS_DIR)).toBe(false);
    for (const spy of Object.values(log)) expect(spy).not.toHaveBeenCalled();
  });

  it("syncs unless skills.autoSync is exactly false", () => {
    syncBundledSkillsOnBoot({ skills: {} });

    expect(fs.readdirSync(SKILLS_DIR).filter((name) => !name.startsWith("."))).toEqual(shipped);
  });

  it("logs a sync that cannot run and lets startup continue", () => {
    fs.writeFileSync(SKILLS_DIR, "not a directory");

    expect(() => syncBundledSkillsOnBoot({})).not.toThrow();

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatch(/startup continues/);
    expect(log.error.mock.calls[0][0]).toContain(`${path.join(fs.realpathSync(JINN_HOME), "skills")} is not a directory`);
    // The error repeats on every start until fixed, so it names the way to silence it.
    expect(log.error.mock.calls[0][0]).toContain("skills.autoSync: false");
    expect(fs.readFileSync(SKILLS_DIR, "utf8")).toBe("not a directory");
  });

  it("warns about a skill it could not sync without failing the others", () => {
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
      if (String(file).endsWith(path.join("migrate", "SKILL.md"))) throw new Error("disk full");
      return (write as (...args: unknown[]) => void)(file, ...rest);
    });

    expect(() => syncBundledSkillsOnBoot({})).not.toThrow();

    expect(fs.existsSync(path.join(SKILLS_DIR, "migrate"))).toBe(false);
    expect(fs.existsSync(path.join(SKILLS_DIR, "status", "SKILL.md"))).toBe(true);
    expect(log.warn.mock.calls.map((call) => call[0])).toEqual([expect.stringMatching(/"migrate" was not synced: disk full/)]);
  });

  it("never touches config.yaml, so jinn.version and the pending migrations stay as they are", () => {
    installAsPreviousRelease();
    const stat = fs.statSync(CONFIG_PATH);
    const pending = getPendingMigrations(getInstanceVersion(), getPackageVersion());
    expect(pending.length).toBeGreaterThan(0);

    syncBundledSkillsOnBoot({});

    expect(Object.keys(receipt().skills)).toEqual(shipped);
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toBe(CONFIG);
    expect(fs.statSync(CONFIG_PATH).mtimeMs).toBe(stat.mtimeMs);
    expect(getInstanceVersion()).toBe("2026.9.1");
    expect(getPendingMigrations(getInstanceVersion(), getPackageVersion())).toEqual(pending);
  });

  it("leaves a skills directory that is the user's own symlink alone, and says so without writing anything", () => {
    fs.mkdirSync(ELSEWHERE);
    fs.symlinkSync(ELSEWHERE, SKILLS_DIR);
    const before = fs.readdirSync(JINN_HOME).sort();

    syncBundledSkillsOnBoot({});
    syncBundledSkillsOnBoot({});

    expect(fs.readdirSync(ELSEWHERE)).toEqual([]);
    expect(fs.readdirSync(JINN_HOME).sort()).toEqual(before);
    // Said where it is read, at each start; the user's own arrangement, so not a warning.
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info.mock.calls[0][0]).toMatch(/skills\/ is a symlink/);
    for (const level of ["debug", "warn", "error"] as const) expect(log[level], level).not.toHaveBeenCalled();
  });
});

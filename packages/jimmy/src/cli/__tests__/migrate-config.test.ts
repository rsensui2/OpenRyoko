import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH, MIGRATIONS_DIR } from "../../shared/paths.js";
import { applyConfigPatches, stampVersion } from "../migrate.js";

/* `ryoko migrate` (run by every `ryoko update`) writes config.yaml twice: it
 * applies the config patches shipped with the pending migrations, and it
 * stamps the new version. Both go through the shared config writer, so an
 * update can neither tear the file nor rewrite one it could not read. */

const CONFIG = [
  "# my instance",
  "jinn:",
  '  version: "2026.9.1"',
  "",
  "engines:",
  "  default: claude",
  "  claude:",
  "    bin: claude",
  "    model: opus   # the old alias",
  "    effortLevel: medium",
  "",
].join("\n");

const onDisk = () => fs.readFileSync(CONFIG_PATH, "utf-8");
const parsed = () => yaml.load(onDisk()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const homeFiles = () => fs.readdirSync(path.dirname(CONFIG_PATH)).filter((name) => name.includes("config.yaml"));

function shipPatch(version: string, ops: unknown): void {
  fs.mkdirSync(path.join(MIGRATIONS_DIR, version), { recursive: true });
  fs.writeFileSync(path.join(MIGRATIONS_DIR, version, "config-patch.json"), JSON.stringify(ops));
}

/** The disk fills up after the new contents were staged, before they could replace config.yaml. */
function failTheSwap() {
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  });
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, CONFIG);
  fs.rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
});

describe("stampVersion", () => {
  it("records the version and leaves the rest of the config as it was", () => {
    stampVersion("2026.10.9");
    expect(parsed()).toEqual({
      jinn: { version: "2026.10.9" },
      engines: { default: "claude", claude: { bin: "claude", model: "opus", effortLevel: "medium" } },
    });
  });

  it("adds the jinn block to a config that has none", () => {
    fs.writeFileSync(CONFIG_PATH, "engines:\n  default: claude\n");
    stampVersion("2026.10.9");
    expect(parsed()).toEqual({ engines: { default: "claude" }, jinn: { version: "2026.10.9" } });
  });

  it("refuses a config.yaml that is not a mapping instead of rewriting it without a version", () => {
    fs.writeFileSync(CONFIG_PATH, "- a\n- list\n");
    expect(() => stampVersion("2026.10.9")).toThrow(/config\.yaml/);
    expect(onDisk()).toBe("- a\n- list\n");
  });

  it("leaves the previous file whole when the write fails part-way", () => {
    failTheSwap();
    expect(() => stampVersion("2026.10.9")).toThrow(/ENOSPC/);
    expect(onDisk()).toBe(CONFIG);
    expect(homeFiles()).toEqual(["config.yaml"]);
  });

  it("fails when there is no config.yaml to stamp", () => {
    fs.rmSync(CONFIG_PATH);
    expect(() => stampVersion("2026.10.9")).toThrow();
    expect(fs.existsSync(CONFIG_PATH)).toBe(false);
  });
});

describe("applyConfigPatches", () => {
  it("moves a value still on the old default, leaves a customized one, and reports what changed", () => {
    shipPatch("2026.10.9", [
      { path: "engines.claude.model", from: "opus", to: "claude-opus-5-5" },
      { path: "engines.claude.effortLevel", from: "low", to: "xhigh" }, // the operator chose medium
      { path: "engines.claude.autoMemory", to: false },
    ]);
    expect(applyConfigPatches(["2026.10.9"])).toBe(2);
    expect(parsed().engines.claude).toEqual({ bin: "claude", model: "claude-opus-5-5", effortLevel: "medium", autoMemory: false });
    expect(parsed().jinn.version).toBe("2026.9.1");
  });

  it("does not rewrite the file when no patch applies", () => {
    shipPatch("2026.10.9", [{ path: "engines.claude.effortLevel", from: "low", to: "xhigh" }]);
    expect(applyConfigPatches(["2026.10.9"])).toBe(0);
    expect(onDisk()).toBe(CONFIG);
  });

  it("skips, without writing, a config.yaml it cannot read", () => {
    const broken = "engines:\n  claude:\n    model: opus\n   effortLevel: medium\n";
    fs.writeFileSync(CONFIG_PATH, broken);
    shipPatch("2026.10.9", [{ path: "engines.claude.model", from: "opus", to: "claude-opus-5-5" }]);
    expect(applyConfigPatches(["2026.10.9"])).toBe(0);
    expect(onDisk()).toBe(broken);
  });

  it("skips a config.yaml that is not a mapping", () => {
    fs.writeFileSync(CONFIG_PATH, "- a\n- list\n");
    shipPatch("2026.10.9", [{ path: "engines.claude.model", to: "claude-opus-5-5" }]);
    expect(applyConfigPatches(["2026.10.9"])).toBe(0);
    expect(onDisk()).toBe("- a\n- list\n");
  });

  it("leaves the previous file whole when the write fails part-way", () => {
    shipPatch("2026.10.9", [{ path: "engines.claude.model", from: "opus", to: "claude-opus-5-5" }]);
    failTheSwap();
    expect(() => applyConfigPatches(["2026.10.9"])).toThrow(/ENOSPC/);
    expect(onDisk()).toBe(CONFIG);
    expect(homeFiles()).toEqual(["config.yaml"]);
  });
});

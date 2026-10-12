import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// setInteractiveSetting edits the file at CONFIG_PATH. Point that constant at a
// per-test temp file by mocking the paths module before importing the unit.
// (Everything else the paths module exports stays as it is: the config writer
// the unit saves through, and the logger behind it, read their own paths.)
let TEST_CONFIG = "";
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  get CONFIG_PATH() { return TEST_CONFIG; },
}));
// loadConfig reads CONFIG_PATH + yaml.load; the real impl is fine here.
vi.mock("../../shared/config.js", async () => {
  const yaml = (await import("js-yaml")).default;
  return {
    loadConfig: () => yaml.load(fs.readFileSync(TEST_CONFIG, "utf-8")),
  };
});

import { getInteractiveSetting, setInteractiveSetting } from "../interactive-config.js";

function writeConfig(body: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icfg-"));
  TEST_CONFIG = path.join(dir, "config.yaml");
  fs.writeFileSync(TEST_CONFIG, body, "utf-8");
}

const BASE = `engines:
  default: claude
  claude:
    bin: claude
    model: opus
    effortLevel: medium
  codex:
    bin: codex
    model: gpt-5.5
    effortLevel: high
`;

describe("interactive-config", () => {
  beforeEach(() => { TEST_CONFIG = ""; });

  it("inserts interactive under claude when absent, and reads it back", () => {
    writeConfig(BASE);
    expect(getInteractiveSetting()).toBeUndefined();
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toMatch(/^ {2}claude:\n {4}interactive: true$/m);
    // codex block untouched
    expect(out).toContain("model: gpt-5.5");
    expect(getInteractiveSetting()).toBe(true);
  });

  it("flips an existing live value in place", () => {
    writeConfig(BASE.replace("    model: opus\n", "    model: opus\n    interactive: true\n"));
    expect(getInteractiveSetting()).toBe(true);
    expect(setInteractiveSetting(false)).toBe(true);
    expect(getInteractiveSetting()).toBe(false);
    // no duplicate key introduced
    const occurrences = fs.readFileSync(TEST_CONFIG, "utf-8").match(/interactive:/g) || [];
    expect(occurrences.length).toBe(1);
  });

  it("uncomments + sets a commented template hint, preserving indent", () => {
    writeConfig(BASE.replace("    effortLevel: medium\n", "    effortLevel: medium\n    # interactive: false\n"));
    expect(getInteractiveSetting()).toBeUndefined();
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toMatch(/^ {4}interactive: true$/m);
    expect(out).not.toMatch(/#\s*interactive/);
    expect(getInteractiveSetting()).toBe(true);
  });

  it("returns false when the value is already the desired one", () => {
    writeConfig(BASE.replace("    model: opus\n", "    model: opus\n    interactive: true\n"));
    expect(setInteractiveSetting(true)).toBe(false);
  });

  it("preserves surrounding comments on a flip", () => {
    const withComments = `engines:
  default: claude
  # Claude engine
  claude:
    bin: claude
    interactive: false   # toggle me
  codex:
    bin: codex
`;
    writeConfig(withComments);
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toContain("# Claude engine");
    expect(out).toContain("# toggle me"); // trailing comment preserved
    expect(out).toMatch(/interactive: true/);
    // a live line with a trailing comment must be flipped in place, not duplicated
    const occurrences = out.match(/^\s*interactive:/gm) || [];
    expect(occurrences.length).toBe(1);
    expect(getInteractiveSetting()).toBe(true);
  });

  it("scopes to engines.claude — a stray interactive: elsewhere is untouched", () => {
    const stray = `engines:
  default: claude
  claude:
    bin: claude
    model: opus
  codex:
    bin: codex
    interactive: true
`;
    writeConfig(stray);
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    // claude got its own key inserted; the codex stray line is left as-is.
    expect(out).toMatch(/^ {2}claude:\n {4}interactive: true$/m);
    const codexBlock = out.slice(out.indexOf("  codex:"));
    expect(codexBlock).toContain("interactive: true"); // unchanged
    expect((out.match(/^\s*interactive:/gm) || []).length).toBe(2);
  });

  it("handles a claude: line with a trailing comment for insertion", () => {
    writeConfig(BASE.replace("  claude:\n", "  claude: # the main engine\n"));
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toMatch(/^ {2}claude: # the main engine\n {4}interactive: true$/m);
  });

  it("flips a non-true/false YAML boolean value form", () => {
    writeConfig(BASE.replace("    model: opus\n", "    model: opus\n    interactive: off\n"));
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toMatch(/^ {4}interactive: true$/m);
    expect((out.match(/^\s*interactive:/gm) || []).length).toBe(1);
  });
});

describe("interactive-config: how the file is written", () => {
  /* `ryoko config interactive on|off` and the setup prompt edit config.yaml —
   * the file every connection and token is in. The edit is by line, to keep the
   * comments, and used to be written straight over the file: a full disk or a
   * crash part-way left it cut short, and a file that did not even parse was
   * edited all the same. It now goes through the gateway's own config writer. */
  const WITH_VALUE = BASE.replace("    model: opus\n", "    model: opus\n    interactive: false   # toggle me\n");
  const files = () => fs.readdirSync(path.dirname(TEST_CONFIG)).sort();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a config.yaml that does not parse instead of editing it, and names no line of it", () => {
    // The engines block is fine — the line edit would go through — but further down the file is broken.
    const broken = `${WITH_VALUE}connectors:\n  slack:\n    botToken: xoxb-SECRET-TOKEN\n   appToken: xapp-SECRET-TOKEN\n`;
    writeConfig(broken);

    let failure: Error | undefined;
    try {
      setInteractiveSetting(true);
    } catch (err) {
      failure = err as Error;
    }

    expect(failure?.message).toMatch(/not valid YAML/);
    expect(failure?.message).not.toContain("SECRET");
    expect(fs.readFileSync(TEST_CONFIG, "utf-8")).toBe(broken);
  });

  it("refuses a config.yaml whose top level is not a mapping", () => {
    writeConfig("- engines:\n    claude:\n      interactive: false\n");
    expect(() => setInteractiveSetting(true)).toThrow(/not a mapping/);
  });

  it("says so when there is no config.yaml", () => {
    writeConfig(BASE);
    fs.rmSync(TEST_CONFIG);
    expect(() => setInteractiveSetting(true)).toThrow(/config\.yaml not found/);
    expect(files()).toEqual([]);
  });

  it("leaves the previous file whole, and nothing staged behind, when the write fails part-way", () => {
    writeConfig(WITH_VALUE);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });

    expect(() => setInteractiveSetting(true)).toThrow(/ENOSPC/);

    expect(fs.readFileSync(TEST_CONFIG, "utf-8")).toBe(WITH_VALUE);
    expect(files()).toEqual(["config.yaml"]);
  });

  it("replaces the file in one step, and keeps its permission bits", () => {
    writeConfig(WITH_VALUE);
    fs.chmodSync(TEST_CONFIG, 0o640);
    const renamed = vi.spyOn(fs, "renameSync");

    expect(setInteractiveSetting(true)).toBe(true);

    expect(renamed).toHaveBeenCalledTimes(1);
    expect(path.basename(String(renamed.mock.calls[0][1]))).toBe("config.yaml");
    expect(fs.readFileSync(TEST_CONFIG, "utf-8")).toBe(WITH_VALUE.replace("interactive: false   # toggle me", "interactive: true   # toggle me"));
    if (process.platform !== "win32") expect(fs.statSync(TEST_CONFIG).mode & 0o777).toBe(0o640);
    expect(files()).toEqual(["config.yaml"]);
  });

  it("writes nothing at all when the value is already the one asked for", () => {
    writeConfig(WITH_VALUE);
    const renamed = vi.spyOn(fs, "renameSync");
    const written = vi.spyOn(fs, "writeFileSync");
    expect(setInteractiveSetting(false)).toBe(false);
    expect(renamed).not.toHaveBeenCalled();
    expect(written).not.toHaveBeenCalled();
  });
});

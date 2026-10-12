import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../shared/config.js";
import { readConfigSnapshot } from "../../shared/config-file.js";
import { CONFIG_PATH } from "../../shared/paths.js";
import { configFailureLines, exitOnConfigFailure } from "../config-failure.js";

/* A config.yaml that will not load is the operator's file to fix, not a fault
 * in the program. `ryoko start` used to end on it with the error and a stack
 * trace through the CLI's own source — a dozen lines of noise around the one
 * that mattered. The CLI now says what is wrong and where, and what to do,
 * in two lines, and exits 1. */

const BROKEN = "gateway:\n  port: 7777\nconnectors:\n  slack:\n    botToken: xoxb-SECRET-TOKEN\n   appToken: xapp-SECRET-TOKEN\n";

function thrownBy(act: () => unknown): unknown {
  try {
    act();
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("configFailureLines", () => {
  it("says what is wrong with a config.yaml that does not parse, where, and what to do — in two lines", () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);

    const lines = configFailureLines(thrownBy(loadConfig));

    expect(lines).toHaveLength(2);
    expect(lines![0]).toMatch(/config\.yaml is not valid YAML \(line 6, column 4\)/);
    expect(lines![1]).toContain(CONFIG_PATH);
    expect(lines![1]).toMatch(/ryoko backup/); // the way back when the file cannot be fixed by hand
    expect(lines!.join("\n")).not.toContain("SECRET");
    expect(lines!.join("\n")).not.toMatch(/^\s+at /m);
  });

  it("does the same when a command that writes the config refuses the file", () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);

    const lines = configFailureLines(thrownBy(() => readConfigSnapshot()));

    expect(lines).toHaveLength(2);
    expect(lines![0]).toMatch(/not valid YAML/);
    expect(lines![1]).toContain(CONFIG_PATH);
    expect(lines!.join("\n")).not.toContain("SECRET");
  });

  it("points at `ryoko setup` when there is no config.yaml at all", () => {
    const lines = configFailureLines(thrownBy(loadConfig));
    expect(lines).not.toBeNull();
    expect(lines!.length).toBeLessThanOrEqual(2);
    expect(lines!.join("\n")).toContain(CONFIG_PATH);
    expect(lines!.join("\n")).toMatch(/ryoko setup/);
  });

  it("has nothing to say about any other error", () => {
    expect(configFailureLines(new Error("connect ECONNREFUSED 127.0.0.1:7777"))).toBeNull();
    expect(configFailureLines(new TypeError("x is not a function"))).toBeNull();
    expect(configFailureLines("a string")).toBeNull();
    expect(configFailureLines(undefined)).toBeNull();
    // js-yaml's own error, should one ever get this far unconverted: its message quotes the file.
    expect(configFailureLines(thrownBy(() => yaml.load(BROKEN)))).toBeNull();
  });
});

describe("exitOnConfigFailure", () => {
  const exited = new Error("process.exit");
  let printed: string[];

  beforeEach(() => {
    printed = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw Object.assign(exited, { code });
    }) as never);
  });

  it("prints the two lines and exits 1, with no stack trace", () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);
    const failure = thrownBy(loadConfig);

    expect(() => exitOnConfigFailure(failure)).toThrow(exited);

    expect((exited as { code?: number }).code).toBe(1);
    expect(printed).toHaveLength(2);
    expect(printed.join("\n")).toMatch(/not valid YAML \(line 6, column 4\)/);
    expect(printed.join("\n")).not.toMatch(/\bat \S+ \(|ConfigSyntaxError|node:internal/);
  });

  it("hands any other error back untouched, to fail the way it always has", () => {
    const other = new Error("something else broke");
    expect(() => exitOnConfigFailure(other)).toThrow(other);
    expect(printed).toEqual([]);
    expect(process.exit).not.toHaveBeenCalled();
  });
});

describe("the CLI entry point", () => {
  it("runs every command through exitOnConfigFailure", () => {
    // Wiring, pinned in the source: the entry point parses arguments at module load.
    const entry = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "bin", "jimmy.ts"), "utf-8");
    expect(entry).toMatch(/program\.parseAsync\(\)\.catch\(/);
    expect(entry).toContain("exitOnConfigFailure");
    expect(entry).not.toMatch(/^program\.parse\(\);$/m);
  });
});

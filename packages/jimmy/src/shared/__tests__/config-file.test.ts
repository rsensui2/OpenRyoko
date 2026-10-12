import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../test-support/posix-mode.js";
import { ConfigFileUnreadableError, configErrorForLog, readConfigSnapshot, writeConfigDocument } from "../config-file.js";

/* config.yaml is the one file every job and connection is defined in. The
 * property under test: a writer that cannot read it never replaces it, and a
 * write either lands whole or leaves the previous file exactly as it was. */

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-config-file-"));
  configPath = path.join(dir, "config.yaml");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readConfigSnapshot", () => {
  it("treats a missing file as an empty document a first write may create", () => {
    const snapshot = readConfigSnapshot(configPath);
    expect(snapshot.raw).toBeNull();
    expect(snapshot.document).toEqual({});
  });

  it("returns the parsed mapping together with the exact text it came from", () => {
    const raw = "# keep me\nengines:\n  default: claude\n";
    fs.writeFileSync(configPath, raw);
    const snapshot = readConfigSnapshot(configPath);
    expect(snapshot.raw).toBe(raw);
    expect(snapshot.document).toEqual({ engines: { default: "claude" } });
  });

  it("identifies the bytes it read: the same bytes the same revision, other bytes another, a missing file the empty one", () => {
    expect(readConfigSnapshot(configPath).revision).toBe("");
    const raw = "engines:\n  default: claude\n";
    fs.writeFileSync(configPath, raw);
    const first = readConfigSnapshot(configPath).revision;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readConfigSnapshot(configPath).revision).toBe(first);
    fs.writeFileSync(configPath, `${raw}# a note\n`);
    expect(readConfigSnapshot(configPath).revision).not.toBe(first);
    fs.writeFileSync(configPath, raw);
    expect(readConfigSnapshot(configPath).revision).toBe(first);
  });

  /* The revision goes to every client of the API, and config.yaml holds
   * tokens. A plain digest of the file would let whoever sees it check guesses
   * about the contents offline, and tell two instances with the same file
   * apart from two that differ. So it is keyed with a secret that exists only
   * in this process's memory. */
  it("is not a digest anyone could recompute from the file", () => {
    const raw = "connectors:\n  slack:\n    botToken: xoxb-SECRET\n";
    fs.writeFileSync(configPath, raw);
    const revision = readConfigSnapshot(configPath).revision;
    for (const algorithm of ["sha256", "sha512", "sha1", "md5", "sha3-256"]) {
      expect(createHash(algorithm).update(raw).digest("hex")).not.toContain(revision.slice(0, 32));
    }
  });

  it("is keyed per process: another process gives the same file another revision", async () => {
    fs.writeFileSync(configPath, "engines:\n  default: claude\n");
    const here = readConfigSnapshot(configPath).revision;
    vi.resetModules(); // the module as a freshly started gateway loads it
    const elsewhere = await import("../config-file.js");
    const there = elsewhere.readConfigSnapshot(configPath).revision;
    expect(there).toMatch(/^[0-9a-f]{64}$/);
    expect(there).not.toBe(here);
    expect(elsewhere.readConfigSnapshot(configPath).revision).toBe(there); // and is as stable there as here
  });

  it("reads an empty or comment-only file as an empty document", () => {
    fs.writeFileSync(configPath, "# nothing configured yet\n");
    expect(readConfigSnapshot(configPath).document).toEqual({});
    fs.writeFileSync(configPath, "");
    expect(readConfigSnapshot(configPath).document).toEqual({});
  });

  it("refuses a file that exists but is not valid YAML", () => {
    fs.writeFileSync(configPath, "gateway: {\nengines: [oops\n");
    expect(() => readConfigSnapshot(configPath)).toThrow(ConfigFileUnreadableError);
  });

  it("refuses a file whose top level is not a mapping", () => {
    fs.writeFileSync(configPath, "- just\n- a list\n");
    expect(() => readConfigSnapshot(configPath)).toThrow(ConfigFileUnreadableError);
    fs.writeFileSync(configPath, "just a string\n");
    expect(() => readConfigSnapshot(configPath)).toThrow(ConfigFileUnreadableError);
  });

  it("refuses a path that exists but cannot be read as a file", () => {
    fs.mkdirSync(configPath); // EISDIR — anything but ENOENT is not "start fresh"
    expect(() => readConfigSnapshot(configPath)).toThrow(ConfigFileUnreadableError);
  });

  it.skipIf(!POSIX_MODES_SUPPORTED || process.getuid?.() === 0)(
    "refuses a file the process is not allowed to read",
    () => {
      fs.writeFileSync(configPath, "engines:\n  default: claude\n");
      fs.chmodSync(configPath, 0o000);
      try {
        expect(() => readConfigSnapshot(configPath)).toThrow(ConfigFileUnreadableError);
      } finally {
        fs.chmodSync(configPath, 0o600);
      }
    },
  );

  it("never quotes the file's contents in the error (a token may sit on the broken line)", () => {
    fs.writeFileSync(configPath, "connectors:\n  slack:\n    botToken: xoxb-SECRET-VALUE\n   appToken: *xapp-SECRET-ALIAS\n");
    let message = "";
    try { readConfigSnapshot(configPath); } catch (err) { message = (err as Error).message; }
    expect(message).not.toBe("");
    expect(message).not.toContain("SECRET");
    expect(message).toMatch(/line \d+/);
  });
});

describe("writeConfigDocument", () => {
  it("creates a missing config.yaml readable by the owner only", () => {
    const snapshot = readConfigSnapshot(configPath);
    writeConfigDocument(snapshot, { engines: { default: "codex" } }, configPath);
    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual({ engines: { default: "codex" } });
    expectPosixMode(configPath, 0o600);
  });

  it("keeps the permission bits the existing file already had", () => {
    fs.writeFileSync(configPath, "engines:\n  default: claude\n");
    fs.chmodSync(configPath, 0o640);
    writeConfigDocument(readConfigSnapshot(configPath), { engines: { default: "codex" } }, configPath);
    expectPosixMode(configPath, 0o640);
    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual({ engines: { default: "codex" } });
  });

  it("returns the revision of the file it wrote", () => {
    fs.writeFileSync(configPath, "engines:\n  default: claude\n");
    const written = writeConfigDocument(readConfigSnapshot(configPath), { engines: { default: "codex" } }, configPath);
    expect(written).toBe(readConfigSnapshot(configPath).revision);
    expect(written).not.toBe("");
  });

  it("leaves no temporary file behind", () => {
    fs.writeFileSync(configPath, "engines:\n  default: claude\n");
    writeConfigDocument(readConfigSnapshot(configPath), { engines: { default: "codex" } }, configPath);
    expect(fs.readdirSync(dir)).toEqual(["config.yaml"]);
  });

  it("replaces the file in one step: a failed write leaves the previous contents untouched", () => {
    const before = "# comment\nengines:\n  default: claude\n";
    fs.writeFileSync(configPath, before);
    const snapshot = readConfigSnapshot(configPath);
    // The disk fills up after the new contents were staged but before they
    // could replace config.yaml. An in-place write would have truncated it.
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    expect(() => writeConfigDocument(snapshot, { engines: { default: "codex" } }, configPath)).toThrow(/ENOSPC/);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(["config.yaml"]);
  });

  it("writes through a symlinked config.yaml instead of replacing the link", () => {
    const real = path.join(dir, "dotfiles-config.yaml");
    fs.writeFileSync(real, "engines:\n  default: claude\n");
    fs.symlinkSync(real, configPath);
    writeConfigDocument(readConfigSnapshot(configPath), { engines: { default: "codex" } }, configPath);
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(yaml.load(fs.readFileSync(real, "utf-8"))).toEqual({ engines: { default: "codex" } });
  });

  it("still saves where the file cannot be swapped (a single bind-mounted config.yaml)", () => {
    fs.writeFileSync(configPath, "engines:\n  default: claude\n");
    const snapshot = readConfigSnapshot(configPath);
    // rename(2) onto a bind-mounted file answers EBUSY. Saving used to work
    // there, so it falls back to writing the file in place.
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });
    writeConfigDocument(snapshot, { engines: { default: "codex" } }, configPath);
    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual({ engines: { default: "codex" } });
    expect(fs.readdirSync(dir)).toEqual(["config.yaml"]);
  });
});

describe("configErrorForLog", () => {
  /* The gateway reloads config.yaml whenever the file changes, and logs why a
   * reload failed. js-yaml's message for a file it cannot parse quotes the
   * lines around the error — in a file that holds the bot tokens — and the log
   * is kept, rotated, and pasted into bug reports. */
  function parseError(raw: string): Error {
    try {
      yaml.load(raw);
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected the YAML to be invalid");
  }

  it("says where a parse error is, and repeats nothing of the file", () => {
    const err = parseError("connectors:\n  slack:\n    botToken: xoxb-SECRET-TOKEN\n   appToken: xapp-SECRET-TOKEN\n");
    expect(err.message).toContain("xoxb-SECRET-TOKEN"); // what used to be logged

    const logged = configErrorForLog(err);

    expect(logged).toMatch(/^config\.yaml is not valid YAML \(line \d+, column \d+\)$/);
    expect(logged).not.toContain("SECRET");
    expect(logged).not.toContain("slack");
  });

  it("leaves out js-yaml's reason too, which can name something taken from the file", () => {
    const err = parseError("portal:\n  password: *hunter2-SECRET\n");
    expect(err.message).toContain("hunter2-SECRET"); // "unidentified alias ..."
    expect(configErrorForLog(err)).not.toContain("hunter2");
  });

  it("recognises a parse error by what it is, not by which copy of js-yaml threw it", () => {
    const foreign = Object.assign(new Error("bad indentation (2:1)\n\n 1 | botToken: xoxb-SECRET\n"), { name: "YAMLException", mark: { line: 1, column: 0 } });
    expect(configErrorForLog(foreign)).toBe("config.yaml is not valid YAML (line 2, column 1)");
    const unplaced = Object.assign(new Error("botToken: xoxb-SECRET"), { name: "YAMLException" });
    expect(configErrorForLog(unplaced)).toBe("config.yaml is not valid YAML");
  });

  it("passes any other failure on as it is", () => {
    expect(configErrorForLog(new Error("Ryoko config not found at /tmp/x/config.yaml"))).toBe("Ryoko config not found at /tmp/x/config.yaml");
    expect(configErrorForLog(new ConfigFileUnreadableError("exists but could not be read (EACCES)"))).toContain("EACCES");
    expect(configErrorForLog("plain string")).toBe("plain string");
    expect(configErrorForLog(undefined)).toBe("undefined");
  });

  it("is what the gateway logs when a reload of config.yaml fails", () => {
    // Wiring, checked in the source: the reload handler lives in the gateway's
    // boot function, which no test can run in isolation. This is the line a
    // merge is most likely to put back the way it was.
    const server = fs.readFileSync(new URL("../../gateway/server.ts", import.meta.url), "utf-8");
    const logged = server.split("\n").filter((line) => line.includes("Failed to reload config"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("${configErrorForLog(err)}");
    expect(logged[0]).not.toContain("err.message");
  });
});

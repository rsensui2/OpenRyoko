import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RECEIPT_FILE } from "../receipt.js";
import { fixture, removeFixtures, sha } from "./fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

type Moment = "before the previous copy is moved away" | "between the two moves" | "before the receipt is brought up to date";

/**
 * Run an update and copy the home as it stands at one instant of it, then make that
 * copy the home: what the next start finds if the process died right there.
 */
function crashDuringUpdate(moment: Moment) {
  const f = fixture();
  f.ship("example", { "SKILL.md": "v1" });
  f.ship("other", { "SKILL.md": "v1" });
  f.sync("2026.10.10");
  f.ship("example", { "SKILL.md": "v2" });
  const frozen = path.join(f.root, "home-at-the-crash");
  const freeze = () => { if (!fs.existsSync(frozen)) fs.cpSync(f.home, frozen, { recursive: true }); };
  const rename = fs.renameSync;
  let receiptWrites = 0;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    const intoBackup = String(to).startsWith(f.backups);
    const fromStaging = String(from).includes(".bundled-skill-");
    const receipt = String(to) === path.join(f.skills, RECEIPT_FILE);
    if (moment === "before the previous copy is moved away" && intoBackup) freeze();
    if (moment === "between the two moves" && fromStaging) freeze();
    // The first receipt write of the run announces the replacement; the second closes it.
    if (moment === "before the receipt is brought up to date" && receipt && ++receiptWrites === 2) freeze();
    return rename(from, to);
  });
  expect(f.sync("2026.10.11").updated).toEqual(["example"]);
  vi.restoreAllMocks();
  expect(fs.existsSync(frozen), "the instant was reached").toBe(true);
  fs.rmSync(f.home, { recursive: true });
  fs.renameSync(frozen, f.home);
  return f;
}

describe("bundled skill sync: a process that dies part-way through replacing a skill", () => {
  it("does not take the skill for one the operator deleted when it died between the two moves", () => {
    const f = crashDuringUpdate("between the two moves");
    // The previous copy is in the backup directory and the new one never landed.
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);

    const result = f.sync("2026.10.11");

    expect(result.kept).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.added).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v2");
    expect(f.receipt().skills.example).toEqual({ version: "2026.10.11", sha256: expect.any(String), files: { "SKILL.md": sha("v2") } });
    // And it stays repaired: nothing left to do, nothing marked.
    expect(f.sync("2026.10.11")).toMatchObject({ added: [], updated: [], kept: [], inSync: ["example", "other"] });
  });

  it("recovers the same way at the next start of a later release", () => {
    const f = crashDuringUpdate("between the two moves");
    f.ship("example", { "SKILL.md": "v3" });

    const result = f.sync("2026.10.12");

    expect(result).toMatchObject({ added: ["example"], kept: [] });
    expect(f.read("example", "SKILL.md")).toBe("v3");
  });

  it("simply replaces the skill when it died before anything was moved", () => {
    const f = crashDuringUpdate("before the previous copy is moved away");
    expect(f.read("example", "SKILL.md")).toBe("v1");

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ updated: ["example"], kept: [], failed: [] });
    expect(f.read("example", "SKILL.md")).toBe("v2");
    expect(f.receipt().skills.example).not.toHaveProperty("replacing");
  });

  it("records the new copy when it died after the skill landed but before the receipt said so", () => {
    const f = crashDuringUpdate("before the receipt is brought up to date");
    expect(f.read("example", "SKILL.md")).toBe("v2");

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ adopted: ["example"], updated: [], kept: [] });
    expect(f.receipt().skills.example).toEqual({ version: "2026.10.11", sha256: expect.any(String), files: { "SKILL.md": sha("v2") } });
  });

  it("still honours a deletion the operator makes after such a crash was repaired", () => {
    const f = crashDuringUpdate("between the two moves");
    f.sync("2026.10.11");
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });

    expect(f.sync("2026.10.11").kept).toEqual([{ name: "example", reason: "deleted" }]);
  });
});

describe("bundled skill sync: announcing a replacement before starting it", () => {
  it("marks the skill in the receipt before moving its previous copy, and clears the mark after", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const rename = fs.renameSync;
    let markedWhenMoved: unknown = "never moved";
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).startsWith(f.backups)) markedWhenMoved = f.receipt().skills.example.replacing;
      return rename(from, to);
    });

    f.sync("2026.10.11");

    expect(markedWhenMoved).toBe(true);
    expect(f.receipt().skills.example).not.toHaveProperty("replacing");
  });

  it("does not start a replacement it cannot announce", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.ship("fresh", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    f.ship("brand-new", { "SKILL.md": "new" });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(f.skills, RECEIPT_FILE)) throw new Error("read-only file system");
      return rename(from, to);
    });

    const result = f.sync("2026.10.11");

    // Without the mark, a crash mid-way would look like a deletion; so the skill is not touched.
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("read-only file system") }]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
    expect(fs.existsSync(f.backups)).toBe(false);
    // A skill that is only being added needs no announcement.
    expect(result.added).toEqual(["brand-new"]);
  });

  it.each(["2026.10.10", "2026.10.11"])("clears the mark from a skill whose replacement then failed (package %s)", (version) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".bundled-skill-")) throw new Error("rename refused");
      return rename(from, to);
    });

    // Under the same package version nothing else in the receipt changes: it has to be
    // written anyway, or the mark put there before the attempt would stay on disk.
    const result = f.sync(version);

    expect(result.failed.map((failure) => failure.name)).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
    expect(f.receipt().skills.example).not.toHaveProperty("replacing");
  });

  it("clears a mark left by a crash once the skill is found edited instead", () => {
    const f = crashDuringUpdate("before the previous copy is moved away");
    expect(f.receipt().skills.example.replacing).toBe(true);
    // After the crash, before the next start, the operator edits the skill.
    fs.writeFileSync(path.join(f.skills, "example", "SKILL.md"), "edited after the crash");

    const result = f.sync("2026.10.11");

    expect(result.kept).toEqual([{ name: "example", reason: "modified" }]);
    expect(f.read("example", "SKILL.md")).toBe("edited after the crash");
    expect(f.receipt().skills.example).not.toHaveProperty("replacing");
    // No stale mark means a later deletion is honoured, not "repaired".
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });
    expect(f.sync("2026.10.11").kept).toEqual([{ name: "example", reason: "deleted" }]);
  });

  it.each(["yes", false, 1, null])("refuses a receipt whose replacing mark is %j rather than true", (mark) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const receipt = f.receipt();
    receipt.skills.example.replacing = mark;
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));

    expect(() => f.sync("2026.10.10")).toThrow(RECEIPT_FILE);
  });
});

describe("bundled skill sync: text taken from the home never reaches a log line raw", () => {
  const FORGED = "a\n2026-10-12T00:00:00.000Z [ERROR] gateway compromised\u001b[2K";

  it("quotes a file path from the receipt in its error", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const receipt = f.receipt();
    receipt.skills.example.files[FORGED] = "not a hash";
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));

    let message = "";
    try { f.sync("2026.10.10"); } catch (error) { message = (error as Error).message; }

    expect(message).toContain(RECEIPT_FILE);
    expect(message).toContain("gateway compromised");
    // One line, no escape sequences: it cannot pass for a log line of its own.
    expect(message).not.toMatch(/[\n\r\u001b]/);
  });
});

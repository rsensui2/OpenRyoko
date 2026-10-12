import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MAX_RECEIPT_BYTES, MAX_SKILL_BYTES, MAX_SKILL_ENTRIES, MAX_SKILL_FILE_BYTES } from "../bounded-read.js";
import { RECEIPT_FILE } from "../receipt.js";
import { fixture, removeFixtures, snapshot } from "./fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

/** A file of this size without writing its bytes: a hole, as far as the disk is concerned. */
function sparse(file: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, "w"));
  fs.truncateSync(file, bytes);
}

describe("bundled skill sync: nothing in the home can make it read without bound", () => {
  it("refuses a receipt larger than a receipt can be, without parsing it", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    // What a large array in the receipt amounts to: parsing it is what exhausts the heap,
    // and a process that runs out of heap aborts — no try/catch sees that.
    sparse(path.join(f.skills, RECEIPT_FILE), MAX_RECEIPT_BYTES + 1);
    f.ship("example", { "SKILL.md": "v2" });
    const before = snapshot(f.home);
    const parse = vi.spyOn(JSON, "parse");

    expect(() => f.sync("2026.10.11")).toThrow(/too large|larger than/);
    expect(() => f.sync("2026.10.11")).toThrow(RECEIPT_FILE);

    expect(parse).not.toHaveBeenCalled();
    expect(snapshot(f.home)).toEqual(before);
  });

  it("still reads a receipt just under the limit", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const file = path.join(f.skills, RECEIPT_FILE);
    const receipt = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, receipt + " ".repeat(MAX_RECEIPT_BYTES - Buffer.byteLength(receipt)));
    f.ship("example", { "SKILL.md": "v2" });

    expect(f.sync("2026.10.11").updated).toEqual(["example"]);
  });

  it("leaves a skill alone when one of its files is larger than any skill file", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    f.sync("2026.10.10");
    // Same file names as the copy the sync placed, so only reading the content could tell them apart.
    sparse(path.join(f.skills, "example", "references", "a.md"), MAX_SKILL_FILE_BYTES + 1);
    f.ship("example", { "SKILL.md": "v2", "references/a.md": "a1" });
    const before = snapshot(path.join(f.skills, "example"));

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ updated: [], failed: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "example", reason: "too-large" }]);
    expect(snapshot(path.join(f.skills, "example"))).toEqual(before);
  });

  it("leaves an unrecorded skill with an oversized file alone, whatever earlier releases shipped", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "old" });
    f.release("v2026.7.1");
    f.ship("example", { "SKILL.md": "new" });
    sparse(path.join(f.skills, "example", "SKILL.md"), MAX_SKILL_FILE_BYTES + 1);

    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], kept: [{ name: "example", reason: "too-large" }] });
  });

  it("leaves a skill alone when it holds more entries than any skill does", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    for (let index = 0; index < MAX_SKILL_ENTRIES; index++) fs.writeFileSync(path.join(f.skills, "example", `note-${index}.md`), "");
    f.ship("example", { "SKILL.md": "v2" });

    const result = f.sync("2026.10.11");

    expect(result.kept).toEqual([{ name: "example", reason: "too-large" }]);
    expect(result.updated).toEqual([]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
  });

  /** Bytes the sync read from open files while `spy` was watching. */
  const bytesRead = (spy: { mock: { results: { value: unknown }[] } }) => spy.mock.results.reduce((sum, result) => sum + (result.value as number), 0);

  it("leaves a skill alone when its files, each small enough, add up to more than any skill holds", () => {
    const f = fixture();
    const files = { "SKILL.md": "v1", "references/a.md": "a1", "references/b.md": "b1" };
    f.ship("example", files);
    f.sync("2026.10.10");
    // The same file names as the copy the sync placed, so only reading could tell them apart.
    for (const relative of Object.keys(files)) sparse(path.join(f.skills, "example", relative), MAX_SKILL_FILE_BYTES);
    expect(3 * MAX_SKILL_FILE_BYTES).toBeGreaterThan(MAX_SKILL_BYTES);
    f.ship("example", { ...files, "SKILL.md": "v2" });
    const before = snapshot(path.join(f.skills, "example"));
    const read = vi.spyOn(fs, "readSync");

    const result = f.sync("2026.10.11");
    // Taken now: comparing snapshots below reads the files too.
    const readBySync = bytesRead(read);

    expect(result.kept).toEqual([{ name: "example", reason: "too-large" }]);
    expect(result).toMatchObject({ updated: [], failed: [], backupDir: null });
    expect(snapshot(path.join(f.skills, "example"))).toEqual(before);
    // It gave up at the budget for one skill instead of reading every file to its end.
    expect(readBySync).toBeGreaterThan(MAX_SKILL_FILE_BYTES);
    expect(readBySync).toBeLessThanOrEqual(MAX_SKILL_BYTES + 64 * 1024);
  });

  it("holds no more than one skill's worth of an unrecorded skill while matching it against earlier releases", () => {
    const f = fixture();
    const files = { "SKILL.md": "old", "references/a.md": "a", "references/b.md": "b" };
    f.ship("example", files);
    f.release("v2026.7.1");
    // The current version dropped a file, so the home copy can only be an earlier one.
    f.ship("example", { "SKILL.md": "new", "references/a.md": "a" });
    for (const relative of Object.keys(files)) sparse(path.join(f.skills, "example", relative), MAX_SKILL_FILE_BYTES);
    const read = vi.spyOn(fs, "readSync");

    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], kept: [{ name: "example", reason: "too-large" }] });

    expect(bytesRead(read)).toBeGreaterThan(MAX_SKILL_FILE_BYTES);
    expect(bytesRead(read)).toBeLessThanOrEqual(MAX_SKILL_BYTES + 64 * 1024);
  });

  it("stops listing a skill's directory one entry past the limit, and never lists one whole", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    for (let index = 0; index < MAX_SKILL_ENTRIES + 200; index++) fs.writeFileSync(path.join(f.skills, "example", `note-${index}.md`), "");
    f.ship("example", { "SKILL.md": "v2" });
    const listedWhole = vi.spyOn(fs, "readdirSync");
    const open = fs.opendirSync;
    let entriesRead = 0;
    vi.spyOn(fs, "opendirSync").mockImplementation(((...args: Parameters<typeof fs.opendirSync>) => {
      const handle = open(...args);
      if (String(args[0]).startsWith(path.join(f.skills, "example"))) {
        const readSync = handle.readSync.bind(handle);
        handle.readSync = () => { entriesRead += 1; return readSync(); };
      }
      return handle;
    }) as typeof fs.opendirSync);

    const result = f.sync("2026.10.11");

    expect(result.kept).toEqual([{ name: "example", reason: "too-large" }]);
    expect(entriesRead).toBe(MAX_SKILL_ENTRIES + 1);
    expect(listedWhole.mock.calls.map((call) => String(call[0])).filter((dir) => dir.startsWith(f.skills))).toEqual([]);
  });

  it("counts the entries of nested directories towards the same limit", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    for (const directory of ["a", "b"]) {
      fs.mkdirSync(path.join(f.skills, "example", directory));
      for (let index = 0; index < MAX_SKILL_ENTRIES / 2; index++) fs.writeFileSync(path.join(f.skills, "example", directory, `note-${index}.md`), "");
    }

    expect(f.sync("2026.10.10").kept).toEqual([{ name: "example", reason: "too-large" }]);
  });

  it("never reads a file in the home whole", () => {
    const f = fixture();
    f.ship("pristine", { "SKILL.md": "v1", "references/a.md": "a1" });
    f.ship("edited", { "SKILL.md": "v1" });
    f.ship("legacy", { "SKILL.md": "Hello {{portalName}}\nold\n" });
    f.release("v2026.7.1");
    f.sync("2026.10.10");
    fs.writeFileSync(path.join(f.skills, "edited", "SKILL.md"), "edited");
    const receipt = f.receipt();
    delete receipt.skills.legacy;
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));
    for (const name of ["pristine", "edited"]) f.ship(name, { "SKILL.md": "v2", "references/a.md": "a1" });
    f.ship("legacy", { "SKILL.md": "Hello {{portalName}}\nnew\n" });
    const whole = vi.spyOn(fs, "readFileSync");

    const result = f.sync("2026.10.11");

    expect(result.updated).toEqual(["legacy", "pristine"]);
    const inHome = whole.mock.calls.map((call) => String(call[0])).filter((file) => file.startsWith(f.home));
    expect(inHome).toEqual([]);
  });

  it("refuses a package whose own skill breaks the limits, rather than calling every home copy too large", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    sparse(path.join(f.template, "skills", "example", "big.bin"), MAX_SKILL_FILE_BYTES + 1);

    expect(() => f.sync()).toThrow(/"example".*big\.bin/);
    expect(fs.readdirSync(f.home)).toEqual([]);
  });

  it("refuses a package whose own skill is too large in total, though no file of it is", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    for (const name of ["a.bin", "b.bin", "c.bin"]) sparse(path.join(f.template, "skills", "example", name), MAX_SKILL_FILE_BYTES);

    expect(() => f.sync()).toThrow(/"example".*larger than a skill may be/);
    expect(fs.readdirSync(f.home)).toEqual([]);
  });
});

describe("bundled skill sync: a skill it could not look at is not passed over in silence", () => {
  it("tells the user once per release about a skill too large to be a bundled one", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    sparse(path.join(f.skills, "example", "SKILL.md"), MAX_SKILL_FILE_BYTES + 1);

    expect(f.sync("2026.10.10").notices).toEqual([{ name: "example", reason: "too-large" }]);
    expect(f.sync("2026.10.10").notices).toEqual([]);
    expect(f.sync("2026.10.11").notices).toEqual([{ name: "example", reason: "too-large" }]);
    expect(f.sync("2026.10.11").notices).toEqual([]);
  });

  it("tells the user once per release about a skill it could not read", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file).startsWith(path.join(f.skills, "example"))) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return (open as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync);

    expect(f.sync("2026.10.10").notices).toEqual([{ name: "example", reason: "unreadable" }]);
    expect(f.sync("2026.10.10").notices).toEqual([]);
    expect(f.sync("2026.10.11").notices).toEqual([{ name: "example", reason: "unreadable" }]);
  });

  it("stops saying so once the skill can be read again", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const file = path.join(f.skills, "example", "SKILL.md");
    sparse(file, MAX_SKILL_FILE_BYTES + 1);
    f.sync("2026.10.10");
    fs.writeFileSync(file, "v1");

    expect(f.sync("2026.10.10")).toMatchObject({ kept: [], notices: [], inSync: ["example"] });
    expect(f.receipt().notices).toEqual({});
  });
});

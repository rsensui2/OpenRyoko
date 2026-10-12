import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HISTORY_FILE } from "../history.js";
import { fixture, removeFixtures, sha, snapshot, STAMP } from "./fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

const OLD = { "SKILL.md": "---\ndescription: Help {{portalName}} migrate\n---\n\n# Migrate\n\nRun `{{portalSlug}} migrate`.\nStep one.\n" };
const NEW = { "SKILL.md": "---\ndescription: Help {{portalName}} migrate\n---\n\n# Migrate\n\nRun `{{portalSlug}} migrate`.\nStep one, revised.\n" };
const rendered = (text: string, name: string) => text.replaceAll("{{portalName}}", name).replaceAll("{{portalSlug}}", name.toLowerCase());

/** A home that an earlier release installed and nobody has synced since: no receipt. */
function upgraded(homeCopy: string | Buffer) {
  const f = fixture();
  f.ship("example", OLD);
  f.release("v2026.7.1");
  f.ship("example", NEW);
  f.place("example", { "SKILL.md": homeCopy });
  return f;
}

describe("bundled skill sync: copies an earlier release installed, with no receipt", () => {
  it("replaces an untouched copy of an earlier shipped version, keeping the previous copy", () => {
    const f = upgraded(rendered(OLD["SKILL.md"], "Momo"));

    const result = f.sync("2026.10.10");

    const backup = path.join(f.backups, `2026.10.10-${STAMP}`);
    expect(result).toMatchObject({ added: [], updated: ["example"], adopted: [], kept: [], notices: [], failed: [], backupDir: backup });
    expect(f.read("example", "SKILL.md")).toBe(rendered(NEW["SKILL.md"], "Momo"));
    expect(fs.readFileSync(path.join(backup, "skills", "example", "SKILL.md"), "utf8")).toBe(rendered(OLD["SKILL.md"], "Momo"));
    expect(f.receipt().skills.example.files).toEqual({ "SKILL.md": sha(rendered(NEW["SKILL.md"], "Momo")) });
    // From here on the receipt carries it: the next run has nothing to do.
    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], kept: [], inSync: ["example"] });
  });

  it("recognises a copy installed under the default name before the portal was renamed", () => {
    const f = upgraded(rendered(OLD["SKILL.md"], "Ryoko"));

    expect(f.sync("2026.10.10", "Momo").updated).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe(rendered(NEW["SKILL.md"], "Momo"));
  });

  it("recognises a copy whose placeholders were never filled in", () => {
    const f = upgraded(OLD["SKILL.md"]);

    expect(f.sync("2026.10.10").updated).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe(rendered(NEW["SKILL.md"], "Momo"));
  });

  it("recognises any of several earlier versions", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "first" });
    f.release("v2026.4.26");
    f.ship("example", { "SKILL.md": "second" });
    f.release("v2026.7.1");
    f.ship("example", { "SKILL.md": "third" });
    f.place("example", { "SKILL.md": "first" });

    expect(f.sync().updated).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("third");
  });

  it("matches a version with several files only when every file is that version's", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1", "references/b.md": "b1" });
    f.release("v2026.7.1");
    f.ship("example", { "SKILL.md": "v2", "references/a.md": "a2" });
    f.release("v2026.9.8");
    f.ship("example", { "SKILL.md": "v3", "references/a.md": "a3" });

    f.place("example", { "SKILL.md": "v1", "references/a.md": "a1", "references/b.md": "b1" });
    expect(f.sync("2026.10.10").updated).toEqual(["example"]);
    expect(fs.existsSync(path.join(f.skills, "example", "references", "b.md"))).toBe(false);

    // A mix of two releases is not something any release installed.
    const mixed = fixture();
    mixed.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    mixed.release("v2026.7.1");
    mixed.ship("example", { "SKILL.md": "v2", "references/a.md": "a2" });
    mixed.release("v2026.9.8");
    mixed.ship("example", { "SKILL.md": "v3", "references/a.md": "a3" });
    mixed.place("example", { "SKILL.md": "v2", "references/a.md": "a1" });
    expect(mixed.sync("2026.10.10")).toMatchObject({ updated: [], kept: [{ name: "example", reason: "unmanaged" }] });
    expect(mixed.read("example", "SKILL.md")).toBe("v2");
  });
});

describe("bundled skill sync: what is not mistaken for an untouched earlier copy", () => {
  const kept = (homeCopy: string | Buffer, portalName = "Momo") => {
    const f = upgraded(homeCopy);
    const before = snapshot(path.join(f.skills, "example"));
    const result = f.sync("2026.10.10", portalName);
    expect(result).toMatchObject({ updated: [], adopted: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "example", reason: "unmanaged" }]);
    expect(snapshot(path.join(f.skills, "example"))).toEqual(before);
    expect(fs.existsSync(f.backups)).toBe(false);
  };

  it("an edit to an ordinary line", () => {
    kept(rendered(OLD["SKILL.md"], "Momo").replace("Step one.", "Step one, and ask first."));
  });

  it("an added line", () => {
    kept(`${rendered(OLD["SKILL.md"], "Momo")}One more rule.\n`);
  });

  it("a missing final newline", () => {
    kept(rendered(OLD["SKILL.md"], "Momo").trimEnd());
  });

  it("one word changed exactly where the name goes", () => {
    // Not a rename: the installer would never have written "our" here.
    kept(OLD["SKILL.md"].replace("{{portalName}}", "our").replace("{{portalSlug}}", "momo"));
  });

  it("a name the installer could not have chosen, even used consistently", () => {
    kept(rendered(OLD["SKILL.md"], "Kiki"));
  });

  it("two different names in one copy", () => {
    kept(OLD["SKILL.md"].replace("{{portalName}}", "Momo").replace("{{portalSlug}}", "ryoko"));
  });

  it("a name filled in on one placeholder and left unfilled on another", () => {
    kept(OLD["SKILL.md"].replace("{{portalName}}", "Momo"));
  });

  it("text around the name changed on the same line", () => {
    kept(rendered(OLD["SKILL.md"], "Momo").replace("Help Momo migrate", "Help Momo migrate safely"));
  });

  it("bytes that are not valid UTF-8", () => {
    kept(Buffer.concat([Buffer.from(rendered(OLD["SKILL.md"], "Momo")), Buffer.from([0xff, 0xfe])]));
  });

  it("a byte that only decodes to the same text as the shipped file", () => {
    // The shipped line holds U+FFFD itself; 0xFF is not that character, though a lossy decode shows it as one.
    const f = fixture();
    f.ship("example", { "SKILL.md": "Hello {{portalName}}\nreplacement char: \uFFFD\n" });
    f.release("v2026.7.1");
    f.ship("example", { "SKILL.md": "Hello {{portalName}}, again\n" });
    f.place("example", { "SKILL.md": Buffer.concat([Buffer.from("Hello Momo\nreplacement char: "), Buffer.from([0xff]), Buffer.from("\n")]) });

    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], kept: [{ name: "example", reason: "unmanaged" }] });
  });

  it("files of one skill filled in under different names", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "Hello {{portalName}}\n", "references/a.md": "About {{portalName}}\n" });
    f.release("v2026.7.1");
    f.ship("example", { "SKILL.md": "Hello {{portalName}}, again\n", "references/a.md": "About {{portalName}}\n" });
    // Each file alone is a valid rendering (the current name, the default name); together no install wrote this.
    f.place("example", { "SKILL.md": "Hello Momo\n", "references/a.md": "About Ryoko\n" });

    expect(f.sync("2026.10.10", "Momo")).toMatchObject({ updated: [], kept: [{ name: "example", reason: "unmanaged" }] });
    expect(f.read("example", "references", "a.md")).toBe("About Ryoko\n");
  });

  it("a file the earlier version did not have", () => {
    const f = upgraded(rendered(OLD["SKILL.md"], "Momo"));
    fs.writeFileSync(path.join(f.skills, "example", "notes.md"), "mine");

    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], kept: [{ name: "example", reason: "unmanaged" }] });
    expect(f.read("example", "notes.md")).toBe("mine");
  });

  it("a copy with one of the earlier version's files removed", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1", "references/b.md": "b1" });
    f.release("v2026.7.1");
    f.ship("example", { "SKILL.md": "v2", "references/a.md": "a2", "references/b.md": "b2" });
    // Every file still there is that release's, byte for byte. The one taken out was the operator's doing.
    f.place("example", { "SKILL.md": "v1", "references/b.md": "b1" });
    const before = snapshot(path.join(f.skills, "example"));

    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], adopted: [], kept: [{ name: "example", reason: "unmanaged" }], backupDir: null });
    expect(snapshot(path.join(f.skills, "example"))).toEqual(before);
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it("a symlink that resolves to an untouched earlier copy", () => {
    const f = upgraded(rendered(OLD["SKILL.md"], "Momo"));
    const elsewhere = path.join(f.root, "elsewhere");
    fs.renameSync(path.join(f.skills, "example"), elsewhere);
    fs.symlinkSync(elsewhere, path.join(f.skills, "example"));

    expect(f.sync("2026.10.10").kept).toEqual([{ name: "example", reason: "symlink" }]);
    expect(fs.readFileSync(path.join(elsewhere, "SKILL.md"), "utf8")).toBe(rendered(OLD["SKILL.md"], "Momo"));
  });

  it("a copy the receipt says was edited, even if it equals an earlier version", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "first" });
    f.release("v2026.7.1");
    f.ship("example", { "SKILL.md": "second" });
    f.sync("2026.10.10");
    // The operator deliberately went back to the older text after the sync placed the newer one.
    fs.writeFileSync(path.join(f.skills, "example", "SKILL.md"), "first");
    f.ship("example", { "SKILL.md": "third" });

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ updated: [], kept: [{ name: "example", reason: "modified" }] });
    expect(f.read("example", "SKILL.md")).toBe("first");
  });

  it("anything at all when the package carries no history", () => {
    const f = upgraded(rendered(OLD["SKILL.md"], "Momo"));
    fs.rmSync(path.join(f.template, HISTORY_FILE));

    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], kept: [{ name: "example", reason: "unmanaged" }] });
  });
});

describe("bundled skill sync: a history file it cannot trust", () => {
  it.each([
    ["not JSON", "{ nope"],
    ["an unknown format", JSON.stringify({ schemaVersion: 2, names: [], skills: {} })],
    ["a skill name that is a path", JSON.stringify({ schemaVersion: 1, names: ["../x"], skills: {} })],
    ["a version without SKILL.md", JSON.stringify({ schemaVersion: 1, names: ["example"], skills: { example: [{ since: "v1", files: { "a.md": { sha256: "0".repeat(64) } } }] } })],
    ["a file path that climbs out", JSON.stringify({ schemaVersion: 1, names: ["example"], skills: { example: [{ since: "v1", files: { "SKILL.md": { sha256: "0".repeat(64) }, "../x": { sha256: "0".repeat(64) } } }] } })],
    ["a fingerprint that is neither kind", JSON.stringify({ schemaVersion: 1, names: ["example"], skills: { example: [{ since: "v1", files: { "SKILL.md": { lines: 2 } } }] } })],
    ["a slot outside the file", JSON.stringify({ schemaVersion: 1, names: ["example"], skills: { example: [{ since: "v1", files: { "SKILL.md": { lines: 2, masked: "0".repeat(64), slots: { "5": "x {{portalName}}" } } } }] } })],
    ["a slot with no placeholder", JSON.stringify({ schemaVersion: 1, names: ["example"], skills: { example: [{ since: "v1", files: { "SKILL.md": { lines: 2, masked: "0".repeat(64), slots: { "0": "plain text" } } } }] } })],
  ])("refuses the whole run when the history is %s", (_label, content) => {
    const f = upgraded(rendered(OLD["SKILL.md"], "Momo"));
    fs.writeFileSync(path.join(f.template, HISTORY_FILE), content);
    const before = snapshot(f.home);

    expect(() => f.sync("2026.10.10")).toThrow(HISTORY_FILE);
    expect(snapshot(f.home)).toEqual(before);
  });
});

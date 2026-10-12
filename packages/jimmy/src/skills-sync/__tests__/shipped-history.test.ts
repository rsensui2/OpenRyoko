import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { applyTemplateReplacements, buildTemplateReplacements, isTemplateFile } from "../../shared/templateReplacements.js";
import { getPackageVersion } from "../../shared/version.js";
import { HISTORY_FILE, loadShippedHistory } from "../history.js";
import { installerDefaultNames } from "../instance.js";
import { syncBundledSkills } from "../sync.js";

// Skills exactly as earlier releases shipped them, copied from the release tags, so
// these tests exercise the committed history without needing git.
const RELEASES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "releases");
const EARLIER: [tag: string, skill: string][] = [
  ["v0.1.0", "sync"],
  ["v2026.5.7", "onboarding"],
  ["v2026.5.22", "migrate"],
  ["v2026.8.27", "cron-manager"],
  ["v2026.9.22", "openryoko-config"],
];

const shippedNow = fs.readdirSync(path.join(TEMPLATE_DIR, "skills"))
  .filter((name) => fs.existsSync(path.join(TEMPLATE_DIR, "skills", name, "SKILL.md")))
  .sort();

const homes: string[] = [];
function home(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openryoko-shipped-history-")));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function files(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(path.join(dir, entry.name), relative) : [relative];
  }).sort();
}

/** Put an earlier release's skill in a home the way that release's installer did.
 *  `name: null` leaves the placeholders unfilled, as an AI-applied migration does. */
function install(target: string, tag: string, skill: string, name: string | null): void {
  const source = path.join(RELEASES, tag, skill);
  for (const relative of files(source)) {
    const destination = path.join(target, "skills", skill, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const raw = fs.readFileSync(path.join(source, relative));
    const fill = name !== null && isTemplateFile(relative);
    fs.writeFileSync(destination, fill ? applyTemplateReplacements(raw.toString("utf8"), buildTemplateReplacements(name)) : raw);
  }
}

const sync = (target: string, portalName: string) => syncBundledSkills({
  templateDir: TEMPLATE_DIR,
  home: target,
  replacements: buildTemplateReplacements(portalName),
  legacyPortalNames: installerDefaultNames({}),
  packageVersion: getPackageVersion(),
});

const tree = (target: string, skill: string) => Object.fromEntries(
  files(path.join(target, "skills", skill)).map((relative) => [relative, fs.readFileSync(path.join(target, "skills", skill, relative), "utf8")]),
);

describe("the history of bundled skills this package ships", () => {
  it("loads, and holds a version of every skill it lists", () => {
    const history = loadShippedHistory(TEMPLATE_DIR);
    const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, HISTORY_FILE), "utf8"));

    expect(Object.keys(raw).sort()).toEqual(["names", "schemaVersion", "skills", "source"]);
    expect(raw.names).toEqual([...raw.names].sort());
    expect([...history.names].sort()).toEqual(raw.names);
    for (const [name, versions] of Object.entries(history.versions)) {
      expect(versions.length, name).toBeGreaterThan(0);
      for (const version of versions) expect(version.since, name).toMatch(/^v\d/);
    }
  });

  it("knows every skill the package ships now — a retired skill can only be retired if it is listed", () => {
    const history = loadShippedHistory(TEMPLATE_DIR);
    const unknown = shippedNow.filter((name) => !history.names.has(name));
    expect(unknown, "regenerate: node scripts/generate-bundled-skill-history.mjs").toEqual([]);
  });

  it("keeps placeholder lines and hashes, not the text of old skills", () => {
    const text = fs.readFileSync(path.join(TEMPLATE_DIR, HISTORY_FILE), "utf8");
    const history = loadShippedHistory(TEMPLATE_DIR);
    const kept = Object.values(history.versions).flat().flatMap((version) => Object.values(version.files))
      .flatMap((fingerprint) => ("slots" in fingerprint ? Object.values(fingerprint.slots) : []));

    expect(kept.length).toBeGreaterThan(10);
    for (const line of kept) expect(line).toMatch(/\{\{portal(Name|Slug)\}\}/);
    // Every fixture skill's ordinary lines are absent: only its placeholder lines may appear.
    for (const [tag, skill] of EARLIER) {
      const ordinary = fs.readFileSync(path.join(RELEASES, tag, skill, "SKILL.md"), "utf8").split("\n")
        .filter((line) => line.trim().length > 25 && !/\{\{portal(Name|Slug)\}\}/.test(line));
      expect(ordinary.length, `${skill}@${tag}`).toBeGreaterThan(5);
      for (const line of ordinary) expect(text.includes(JSON.stringify(line).slice(1, -1)), line).toBe(false);
    }
  });
});

describe("a home an earlier release installed, synced with the real package", () => {
  it.each(EARLIER)("%s: brings an untouched %s up to date, whatever name it was installed under", (tag, skill) => {
    const fresh = home();
    sync(fresh, "Momo");
    const expected = tree(fresh, skill);

    for (const installedAs of ["Momo", "Ryoko", "Jinn", null]) {
      const target = home();
      install(target, tag, skill, installedAs);
      expect(tree(target, skill), `${installedAs}: the fixture must differ from the current skill`).not.toEqual(expected);

      const result = sync(target, "Momo");

      expect(result.updated, String(installedAs)).toEqual([skill]);
      expect(result.kept, String(installedAs)).toEqual([]);
      expect(result.added).toEqual(shippedNow.filter((name) => name !== skill));
      expect(tree(target, skill), String(installedAs)).toEqual(expected);
      expect(files(path.join(result.backupDir!, "skills", skill))).toEqual(files(path.join(RELEASES, tag, skill)));
    }
  });

  it.each(EARLIER)("%s: leaves %s alone once a single line of it has been edited", (tag, skill) => {
    const target = home();
    install(target, tag, skill, "Momo");
    const edited = path.join(target, "skills", skill, "SKILL.md");
    fs.appendFileSync(edited, "\nOur own rule: ask first.\n");
    const before = tree(target, skill);

    const result = sync(target, "Momo");

    expect(result.updated).toEqual([]);
    expect(result.kept).toEqual([{ name: skill, reason: "unmanaged" }]);
    expect(tree(target, skill)).toEqual(before);
    expect(result.backupDir).toBeNull();
  });

  it("leaves a copy installed under a name the installer would not have picked", () => {
    const target = home();
    install(target, "v2026.5.22", "migrate", "Kiki");

    expect(sync(target, "Momo")).toMatchObject({ updated: [], kept: [{ name: "migrate", reason: "unmanaged" }] });
  });
});

describe("the names the installer falls back to", () => {
  it("are Ryoko and Jinn, plus the capitalised instance name when there is one", () => {
    expect(installerDefaultNames({})).toEqual(["Ryoko", "Jinn"]);
    expect(installerDefaultNames({ RYOKO_INSTANCE: "momo" })).toEqual(["Ryoko", "Jinn", "Momo"]);
    expect(installerDefaultNames({ JINN_INSTANCE: "kiki" })).toEqual(["Ryoko", "Jinn", "Kiki"]);
    expect(installerDefaultNames({ RYOKO_INSTANCE: "momo", JINN_INSTANCE: "kiki" })).toEqual(["Ryoko", "Jinn", "Momo"]);
    expect(installerDefaultNames({ RYOKO_INSTANCE: "ryoko" })).toEqual(["Ryoko", "Jinn"]);
  });
});

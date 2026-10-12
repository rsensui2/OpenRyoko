#!/usr/bin/env node
// Regenerates packages/jimmy/template/bundled-skill-history.json: a fingerprint of
// every version of every bundled skill that a release tag in this repository shipped.
//
// The bundled skill sync uses it for homes installed before it kept a receipt. A skill
// there has no record of what was placed, so the only proof that it is an untouched
// shipped copy — safe to replace — is that it matches one of these fingerprints.
//
//   node scripts/generate-bundled-skill-history.mjs           rewrite the file
//   node scripts/generate-bundled-skill-history.mjs --check   exit 1 if it is out of date
//
// Run it when cutting a release. Versions shipped from this release on are covered by
// the receipt, so what must stay current is the list of names: a skill that is later
// retired can only be retired if this file knows the package once shipped it.
//
// Needs Node 22.18+ (it imports a .ts file; older 22.x: --experimental-strip-types).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintFile } from "../packages/jimmy/src/skills-sync/fingerprint.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = "packages/jimmy/template/skills";
const OUTPUT = "packages/jimmy/template/bundled-skill-history.json";
// Never part of a skill: the sync ignores them in a home, and so does this.
const HOUSEKEEPING = new Set([".DS_Store", ".gitkeep"]);

const git = (...args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });

/** Release tags, oldest first, that carry bundled skills. */
function releaseTags() {
  return git("tag", "-l", "--sort=version:refname", "v[0-9]*").toString().split("\n").filter(Boolean);
}

/** skill name → { path inside the skill → blob id } for one tag. Symlinks and
 *  submodules are left out: the installer only ever wrote regular files. */
function skillsAt(tag) {
  const listing = git("ls-tree", "-r", "-z", tag, "--", `${SKILLS}/`).toString();
  const skills = new Map();
  for (const record of listing.split("\0").filter(Boolean)) {
    const [meta, file] = record.split("\t");
    const [mode, type, blob] = meta.split(" ");
    const [name, ...rest] = file.slice(SKILLS.length + 1).split("/");
    if (type !== "blob" || mode === "120000" || rest.length === 0 || HOUSEKEEPING.has(rest.at(-1))) continue;
    if (!skills.has(name)) skills.set(name, new Map());
    skills.get(name).set(rest.join("/"), blob);
  }
  return skills;
}

const blobs = new Map();
function fingerprint(relative, blob) {
  const key = `${blob}\0${relative}`;
  if (!blobs.has(key)) blobs.set(key, fingerprintFile(relative, git("cat-file", "blob", blob)));
  return blobs.get(key);
}

const sorted = (record) => Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));

function build() {
  const tags = releaseTags();
  const versions = new Map();
  const used = [];
  for (const tag of tags) {
    const skills = skillsAt(tag);
    if (skills.size > 0) used.push(tag);
    for (const [name, files] of skills) {
      // A directory without SKILL.md is not a skill, to the installer or to the sync.
      if (!files.has("SKILL.md")) continue;
      const fingerprints = sorted(Object.fromEntries([...files].map(([relative, blob]) => [relative, fingerprint(relative, blob)])));
      const known = versions.get(name) ?? [];
      const content = JSON.stringify(fingerprints);
      if (!known.some((version) => JSON.stringify(version.files) === content)) versions.set(name, [...known, { since: tag, files: fingerprints }]);
    }
  }
  const shippedNow = fs.readdirSync(path.join(ROOT, SKILLS), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, SKILLS, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
  return {
    schemaVersion: 1,
    source: used.length > 0 ? `${used.length} release tags, ${used[0]} to ${used.at(-1)}` : "no release tags",
    names: [...new Set([...versions.keys(), ...shippedNow])].sort(),
    skills: sorted(Object.fromEntries(versions)),
  };
}

const text = `${JSON.stringify(build(), null, 2)}\n`;
const target = path.join(ROOT, OUTPUT);
if (process.argv.includes("--check")) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current !== text) {
    console.error(`${OUTPUT} is out of date. Run: node scripts/generate-bundled-skill-history.mjs`);
    process.exit(1);
  }
  console.error(`${OUTPUT} is up to date.`);
} else {
  fs.writeFileSync(target, text);
  console.error(`Wrote ${OUTPUT}`);
}

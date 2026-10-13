import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_MIGRATIONS_DIR } from "../../shared/paths.js";
import { declaresSessionNeeded, migrationNeedsSession } from "../migration-declarations.js";

const shipped = fs.readdirSync(TEMPLATE_MIGRATIONS_DIR).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
const read = (version: string) => fs.readFileSync(path.join(TEMPLATE_MIGRATIONS_DIR, version, "MIGRATION.md"), "utf8");

describe("the declaration a migration makes about --auto", () => {
  it("is `auto: false` in the front matter of MIGRATION.md", () => {
    expect(declaresSessionNeeded("---\nauto: false\n---\n# 1.2.3\n")).toBe(true);
    expect(declaresSessionNeeded("---\nauto: false # the owner has to agree first\ntitle: x\n---\n\n# 1.2.3\n")).toBe(true);
    expect(declaresSessionNeeded("﻿---\r\nauto: false\r\n---\r\n# 1.2.3\r\n")).toBe(true);
  });

  it("is absent from a migration --auto can finish alone", () => {
    expect(declaresSessionNeeded("# 1.2.3\n\nNothing to do by hand.\n")).toBe(false);
    expect(declaresSessionNeeded("---\nauto: true\n---\n# 1.2.3\n")).toBe(false);
    expect(declaresSessionNeeded("---\ntitle: no word about auto\n---\n# 1.2.3\n")).toBe(false);
    // Not front matter: a rule further down the page, or the word in running text.
    expect(declaresSessionNeeded("# 1.2.3\n\n---\nauto: false\n---\n")).toBe(false);
    expect(declaresSessionNeeded("")).toBe(false);
  });

  it("reads a declaration it cannot make sense of as \"needs a session\"", () => {
    // A migration wrongly held back costs one `ryoko migrate`. One wrongly passed is never applied.
    for (const front of ["auto: no", "auto: off", "auto: 0", "auto:", 'auto: "false"', "auto: [", "- auto"]) {
      expect(declaresSessionNeeded(`---\n${front}\n---\n# 1.2.3\n`), front).toBe(true);
    }
    expect(declaresSessionNeeded("---\nauto: false\n# never closed\n"), "unterminated").toBe(true);
  });
});

describe("the migrations this package ships", () => {
  const declared = shipped.filter((version) => migrationNeedsSession(version)).sort();

  it("declare a session needed exactly where MIGRATION.md gives an AI or the owner something to do", () => {
    expect(declared).toEqual(["0.3.0", "0.7.3", "0.9.0", "2026.10.13", "2026.10.9", "2026.5.7", "2026.8.28", "2026.9.11"]);
  });

  it("never leave an instruction to confirm, merge or ask without the declaration", () => {
    // Not a proof, a tripwire: wording that has so far always meant work --auto cannot do.
    const tells = /確認が必要|了承を得|ユーザーに確認|所有者へ|AI セッションが実行|merged manually|Merge the updated|慎重にマージ|merge carefully/;
    const undeclared = shipped.filter((version) => tells.test(read(version)) && !migrationNeedsSession(version));
    expect(undeclared, "add `auto: false` front matter to MIGRATION.md, or reword").toEqual([]);
  });

  it("keep the declaration out of the migrations --auto has always finished alone", () => {
    for (const version of ["0.1.0", "0.2.0", "0.7.5", "0.8.0", "2026.7.1", "2026.7.10", "2026.7.25", "2026.8.20"]) {
      expect(migrationNeedsSession(version), version).toBe(false);
    }
  });

  it("answers no for a version that ships no MIGRATION.md", () => {
    expect(migrationNeedsSession("9999.1.1")).toBe(false);
  });
});

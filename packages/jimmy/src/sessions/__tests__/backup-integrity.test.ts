import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { damageDatabase } from "../../backup/__tests__/fixture.js";
import { findDatabaseProblems } from "../backup-integrity.js";

/* The check a database copy has to pass before it is given its name.
 *
 * It runs in the gateway, on a registry that can be hundreds of megabytes, and
 * SQLite's integrity check is one synchronous call that reads all of it. Made
 * on the gateway's own thread it would stop everything else for as long as it
 * took. So where it runs is part of what is tested here, not only what it
 * finds. */

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A closed database whose one table spans several pages, alone in its directory. */
function seeded(journal: "wal" | "delete" = "wal"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-integrity-"));
  roots.push(root);
  const file = path.join(root, "copy.db");
  const database = new Database(file);
  database.pragma(`journal_mode = ${journal}`);
  database.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO sessions (label) VALUES (?)");
  database.transaction(() => { for (let index = 0; index < 2000; index += 1) insert.run(`session-${index}`); })();
  database.close();
  return file;
}

describe("findDatabaseProblems", () => {
  it("finds nothing wrong with a sound database", async () => {
    expect(await findDatabaseProblems(seeded())).toEqual([]);
    expect(await findDatabaseProblems(seeded("delete"))).toEqual([]);
  });

  it("reports a database with a damaged page, in SQLite's own words", async () => {
    const file = seeded();
    damageDatabase(file);

    const problems = await findDatabaseProblems(file);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => typeof problem === "string" && problem !== "ok")).toBe(true);
  });

  it("reports a file that is not a database, and one that is not there, as unreadable", async () => {
    const file = seeded();
    fs.writeFileSync(file, "this is not a database");

    expect(await findDatabaseProblems(file)).toEqual([expect.stringMatching(/could not be read/)]);
    expect(await findDatabaseProblems(path.join(path.dirname(file), "missing.db"))).toEqual([expect.stringMatching(/could not be read/)]);
    expect(fs.existsSync(path.join(path.dirname(file), "missing.db"))).toBe(false);
  });

  it("leaves nothing beside the file it checked", async () => {
    // Opening a WAL-mode file read-only makes SQLite create a -wal and a -shm next to it, and leave them.
    const file = seeded("wal");

    await findDatabaseProblems(file);

    expect(fs.readdirSync(path.dirname(file))).toEqual(["copy.db"]);
  });

  it("removes only what it caused: a sidecar that was already there stays", async () => {
    const file = seeded("wal");
    fs.writeFileSync(`${file}-wal`, "");

    expect(await findDatabaseProblems(file)).toEqual([]);

    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["copy.db", "copy.db-wal"]);
  });

  it("does not run the check on the thread that asked for it", async () => {
    const file = seeded();
    damageDatabase(file);
    const pragma = vi.spyOn(Database.prototype, "pragma");

    const problems = await findDatabaseProblems(file);

    // The damage was found, so the check ran - and this thread's driver was never asked to run it.
    expect(problems.length).toBeGreaterThan(0);
    expect(pragma.mock.calls.filter(([source]) => /integrity_check/.test(String(source)))).toEqual([]);
  });

  it("lets the caller's event loop turn while it works", async () => {
    const file = seeded();
    let turns = 0;
    let settled = false;
    const spin = (): void => {
      turns += 1;
      if (!settled) setImmediate(spin);
    };

    const pending = findDatabaseProblems(file);
    setImmediate(spin);
    const problems = await pending;
    settled = true;

    expect(problems).toEqual([]);
    // A check made inline would have returned an already-settled promise: not one turn in between.
    expect(turns).toBeGreaterThan(0);
  });

  it("rejects, rather than passing or failing the file, when the check itself cannot be run", async () => {
    const file = seeded();

    await expect(findDatabaseProblems(file, { driver: path.join(path.dirname(file), "no-such-driver.cjs") }))
      .rejects.toThrow(/integrity check could not be run/);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["copy.db"]);
  });
});

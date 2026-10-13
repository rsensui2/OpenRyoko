import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOnlyDatabaseSource,
  standaloneDatabaseSources,
  type DatabaseHandle,
  type DatabaseSource,
} from "../database-source.js";
import { databaseFingerprint, leaveMidFlight, makeHome, removeTempDirs, setDatabaseModified, tempDir } from "./fixture.js";

/* Where a database connection may come from when the process asking is not the
 * gateway. A read-only connection is not a harmless one: it writes the -shm,
 * and when it cannot see who else holds the database it truncates that file
 * and rebuilds it. So a command run by hand gets a connection only when
 * nothing suggests a gateway is there, and that is decided without opening
 * anything. */

const NOW = new Date("2026-10-12T03:00:00.000Z");
const HOUR_MS = 3_600_000;

interface Scene {
  home: string;
  sessions: string;
  workflows: string;
}

/**
 * A home whose two databases look the way a gateway's do to a process that
 * cannot see its locks - rows still in the WAL, nobody visibly holding them -
 * and that nothing has written for an hour of `clock`.
 */
function quietHome(clock: Date = NOW): Scene {
  const home = makeHome(tempDir());
  const sessions = path.join(home, "sessions", "registry.db");
  const workflows = path.join(home, "workflows", "workflows.db");
  leaveMidFlight(sessions, "sessions", 5);
  leaveMidFlight(workflows, "workflows", 3);
  for (const file of [sessions, workflows]) setDatabaseModified(file, new Date(clock.getTime() - HOUR_MS));
  return { home, sessions, workflows };
}

const handleFrom = (source: DatabaseSource): DatabaseHandle => {
  const result = source();
  if (!result || "withheld" in result) throw new Error(`expected a connection, got ${JSON.stringify(result)}`);
  return result;
};

afterEach(removeTempDirs);

describe("standaloneDatabaseSources", () => {
  it("hands over a read-only connection when nothing suggests a gateway is running", () => {
    const scene = quietHome();

    const handle = handleFrom(standaloneDatabaseSources(scene.home, () => NOW).sessions);

    try {
      expect(handle.database.name).toBe(scene.sessions);
      expect(handle.database.readonly).toBe(true);
      expect(() => handle.database.exec("DELETE FROM sessions")).toThrow(/readonly/i);
    } finally {
      handle.release();
    }
    expect(handle.database.open).toBe(false);
  });

  it("opens neither database while a pid file names a process that is alive", () => {
    const scene = quietHome();
    fs.writeFileSync(path.join(scene.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
    const before = [databaseFingerprint(scene.sessions), databaseFingerprint(scene.workflows)];

    const sources = standaloneDatabaseSources(scene.home, () => NOW);

    for (const source of [sources.sessions, sources.workflows]) {
      expect(source()).toEqual({
        withheld: "gateway-running",
        detail: expect.stringMatching(/gateway appears to be running.*gateway\.json names pid \d+.*not opened/s),
      });
    }
    // Not "read and put back": never opened. The -shm would show it.
    expect([databaseFingerprint(scene.sessions), databaseFingerprint(scene.workflows)]).toEqual(before);
  });

  it("opens neither database when the registry was written a few seconds ago", () => {
    const scene = quietHome();
    const justNow = new Date(NOW.getTime() - 8_000);
    fs.utimesSync(`${scene.sessions}-wal`, justNow, justNow);
    const before = [databaseFingerprint(scene.sessions), databaseFingerprint(scene.workflows)];

    const sources = standaloneDatabaseSources(scene.home, () => NOW);

    expect(sources.sessions()).toMatchObject({ withheld: "gateway-running", detail: expect.stringContaining("registry.db-wal was written 8 seconds ago") });
    expect(sources.workflows()).toMatchObject({ withheld: "gateway-running" });
    expect([databaseFingerprint(scene.sessions), databaseFingerprint(scene.workflows)]).toEqual(before);
  });

  it("takes a write to the workflow store as a sign for the whole home", () => {
    const scene = quietHome();
    const justNow = new Date(NOW.getTime() - 20_000);
    fs.utimesSync(scene.workflows, justNow, justNow);

    const sources = standaloneDatabaseSources(scene.home, () => NOW);

    expect(sources.sessions()).toMatchObject({ withheld: "gateway-running", detail: expect.stringContaining("workflows.db was written 20 seconds ago") });
    expect(sources.workflows()).toMatchObject({ withheld: "gateway-running" });
  });

  it("tells the operator what to do instead", () => {
    const scene = quietHome();
    fs.writeFileSync(path.join(scene.home, "gateway.json"), JSON.stringify({ pid: process.pid }));

    const refusal = standaloneDatabaseSources(scene.home, () => NOW).sessions();

    // Who copies it in the meantime depends on the config, which is the caller's to say; this says how to get it from here.
    expect(refusal).toMatchObject({ detail: expect.stringMatching(/stop the gateway \(ryoko stop\), wait a minute/) });
  });

  it("decides once, so that its own reading of one database is not taken for a gateway by the next", () => {
    // Reading leaves a freshly written -shm behind. Asked again after that,
    // the detection would see "written 0 seconds ago" - by this very command.
    const wallClock = (): Date => new Date();
    const scene = quietHome(wallClock());
    const sources = standaloneDatabaseSources(scene.home, wallClock);

    const first = handleFrom(sources.sessions);
    first.database.prepare("SELECT count(*) FROM sessions").get();
    first.release();
    expect(Date.now() - fs.statSync(`${scene.sessions}-shm`).mtimeMs).toBeLessThan(60_000);

    const second = handleFrom(sources.workflows);
    second.release();
  });

  it("has nothing to hand over for a database the home does not have", () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 1 });
    setDatabaseModified(path.join(home, "sessions", "registry.db"), new Date(NOW.getTime() - HOUR_MS));

    const sources = standaloneDatabaseSources(home, () => NOW);

    expect(sources.workflows()).toBeNull();
    handleFrom(sources.sessions).release();
  });
});

describe("readOnlyDatabaseSource", () => {
  it("returns null rather than creating a database that is not there", () => {
    const missing = path.join(tempDir(), "nothing.db");

    expect(readOnlyDatabaseSource(missing)()).toBeNull();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("leaves the main file and the WAL of the database it reads byte for byte as they were", () => {
    const scene = quietHome();
    const bytes = (): Buffer[] => ["", "-wal"].map((suffix) => fs.readFileSync(`${scene.sessions}${suffix}`));
    const before = bytes();

    const handle = handleFrom(readOnlyDatabaseSource(scene.sessions));
    expect(handle.database.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 5 });
    handle.release();

    expect(bytes().map((buffer, index) => buffer.equals(before[index]!))).toEqual([true, true]);
  });
});

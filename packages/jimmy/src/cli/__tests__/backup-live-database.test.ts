import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseFingerprint, leaveMidFlight, makeHome, removeTempDirs, rowCount, setDatabaseModified, tempDir } from "../../backup/__tests__/fixture.js";
import { runBackupList, runBackupRestore, runBackupRun, runBackupVerify, type BackupCliDeps } from "../backup.js";

/* Which files `ryoko backup` opens a SQLite connection on.
 *
 * The registry and the workflow store in a home may be in use by a gateway
 * this command cannot see - one in a container, looked at from the host. A
 * connection to such a database is not harmless even read-only: it writes the
 * -shm beside it, and when it sees nobody else there it truncates that file
 * and rebuilds it. So the rule these hold the commands to is about opening,
 * not about damage: no command opens a database in the home, except `run`
 * when asked for the databases and nothing suggests a gateway.
 *
 * Every connection made in this process is recorded, whoever makes it, and the
 * databases' own files are compared before and after down to the -shm. */

const opened = vi.hoisted(() => [] as { file: string; readonly: boolean }[]);

/** The driver itself, with every connection it is asked for noted down first. Nothing about what it does is changed. */
vi.mock("better-sqlite3", async (importOriginal) => {
  type Driver = new (file?: unknown, options?: { readonly?: boolean }) => object;
  const Real = (await importOriginal<{ default: Driver }>()).default;
  class Recording extends Real {
    constructor(file?: unknown, options?: { readonly?: boolean }) {
      opened.push({ file: String(file), readonly: options?.readonly === true });
      super(file, options);
    }
  }
  return { default: Recording };
});

const START = new Date("2026-10-12T03:00:00.000Z");
const HOUR_MS = 3_600_000;
let previousExitCode: typeof process.exitCode;

interface Scene {
  home: string;
  backups: string;
  live: string[];
  out: string[];
  err: string[];
  clock: { now: Date };
  deps: BackupCliDeps;
}

function sceneOver(home: string): Scene {
  const scene: Scene = {
    home,
    backups: path.join(home, "backups"),
    live: [path.join(home, "sessions", "registry.db"), path.join(home, "workflows", "workflows.db")],
    out: [], err: [], clock: { now: START }, deps: {},
  };
  scene.deps = {
    home,
    io: { out: (text) => { scene.out.push(text); }, err: (text) => { scene.err.push(text); } },
    now: () => scene.clock.now,
    loadConfig: () => ({}),
  };
  return scene;
}

/** Both databases as a gateway's look from outside - rows in the WAL, nobody visibly holding them - and idle for an hour. */
function leaveInUse(scene: Scene): void {
  for (const live of scene.live) {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${live}${suffix}`, { force: true });
  }
  leaveMidFlight(scene.live[0]!, "sessions", 7);
  leaveMidFlight(scene.live[1]!, "workflows", 5);
  for (const live of scene.live) setDatabaseModified(live, new Date(scene.clock.now.getTime() - HOUR_MS));
}

const fingerprints = (scene: Scene): Record<string, string>[] => scene.live.map(databaseFingerprint);
const openedInHome = (scene: Scene): string[] =>
  opened.map((entry) => entry.file).filter((file) => !file.startsWith(`${scene.backups}${path.sep}`));
const gatewayRunning = (scene: Scene): void => {
  fs.writeFileSync(path.join(scene.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
};

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  opened.length = 0;
  removeTempDirs();
});

describe("ryoko backup run", () => {
  it("opens no database at all unless it is asked for them", async () => {
    const scene = sceneOver(makeHome(tempDir()));
    leaveInUse(scene);
    const before = fingerprints(scene);
    opened.length = 0;

    await runBackupRun({ json: true }, scene.deps);

    expect(opened).toEqual([]);
    expect(fingerprints(scene)).toEqual(before);
    expect(process.exitCode).toBeUndefined();
  });

  it("opens no database when it is asked for them and a gateway appears to be running", async () => {
    const scene = sceneOver(makeHome(tempDir()));
    leaveInUse(scene);
    gatewayRunning(scene);
    const before = fingerprints(scene);
    opened.length = 0;

    await runBackupRun({ json: true, includeDatabases: true }, scene.deps);

    expect(opened).toEqual([]);
    expect(fingerprints(scene)).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it("opens them read-only, and only them, when it is asked and nothing suggests a gateway", async () => {
    const scene = sceneOver(makeHome(tempDir()));
    leaveInUse(scene);
    opened.length = 0;

    await runBackupRun({ json: true, includeDatabases: true }, scene.deps);

    // The one place a command opens a database in the home.
    expect(opened.filter((entry) => !entry.file.startsWith(`${scene.backups}${path.sep}`)))
      .toEqual(scene.live.map((file) => ({ file, readonly: true })));
    expect(process.exitCode).toBeUndefined();
  });
});

describe("ryoko backup list, verify and restore", () => {
  /** An archive and a copy of each database, taken with the gateway stopped; then the databases back in use. */
  async function backedUp(): Promise<Scene> {
    const scene = sceneOver(makeHome(tempDir(), "home", { sessionRows: 4, workflowRows: 2 }));
    for (const live of scene.live) setDatabaseModified(live, new Date(scene.clock.now.getTime() - HOUR_MS));
    await runBackupRun({ json: true, includeDatabases: true }, scene.deps);
    expect(process.exitCode).toBeUndefined();
    scene.clock.now = new Date(START.getTime() + HOUR_MS / 2);
    leaveInUse(scene);
    scene.out.length = 0;
    opened.length = 0;
    return scene;
  }

  it("open only files in the backup directory, whatever they are asked and however they end", async () => {
    const scene = await backedUp();
    const before = fingerprints(scene);
    fs.writeFileSync(path.join(scene.home, "config.yaml"), "broken\n");

    await runBackupList({ json: true }, scene.deps);
    for (const id of ["home-20261012T030000Z", "sessions-2026-10-12", "workflows-2026-10-12"]) {
      await runBackupVerify(id, { json: true }, scene.deps);
    }
    await runBackupRestore("home-20261012T030000Z", { dryRun: true, json: true }, scene.deps);
    await runBackupRestore("home-20261012T030000Z", { json: true }, scene.deps);
    await runBackupRestore("sessions-2026-10-12", { dryRun: true, json: true }, scene.deps);
    expect(process.exitCode).toBeUndefined();
    expect(scene.err).toEqual([]);

    // Refused twice: without the operator's word, and with it under a gateway that can be seen.
    await runBackupRestore("sessions-2026-10-12", { json: true }, scene.deps);
    gatewayRunning(scene);
    await runBackupRestore("workflows-2026-10-12", { gatewayStopped: true, json: true }, scene.deps);
    expect(scene.err).toHaveLength(2);

    expect(openedInHome(scene)).toEqual([]);
    // The copies were read: this is not a test that passes because nothing ran.
    expect(opened.map((entry) => path.basename(entry.file))).toEqual(expect.arrayContaining(["sessions-2026-10-12.db", "workflows-2026-10-12.db"]));
    expect(opened.every((entry) => entry.readonly)).toBe(true);
    expect(fingerprints(scene)).toEqual(before);
  });

  it("replace a database without ever opening the one being replaced", async () => {
    const scene = await backedUp();

    await runBackupRestore("sessions-2026-10-12", { gatewayStopped: true, json: true }, scene.deps);

    expect(process.exitCode).toBeUndefined();
    expect(openedInHome(scene)).toEqual([]);
    expect(opened.every((entry) => entry.readonly)).toBe(true);
    // Replaced all the same: the four rows of the backup, not the seven that were in use.
    opened.length = 0;
    expect(rowCount(scene.live[0]!, "sessions")).toBe(4);
  });
});

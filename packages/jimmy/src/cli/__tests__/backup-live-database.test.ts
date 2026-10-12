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
 * Two measures, and what each can and cannot see:
 *
 * - What is recorded: every connection the driver is asked for on this thread
 *   by code that imports it, and every file handed to a worker thread - which
 *   is where a database copy is checked, on a connection this thread never
 *   makes. That is not every way a process can open a database. A connection
 *   made inside a worker for some other file, or through a driver loaded with
 *   `require`, would not be in these lists.
 * - What is compared: the databases' own files before and after, bytes and
 *   timestamps, down to the -shm that any SQLite connection rewrites. This one
 *   does not depend on how a database was opened, and is what catches a
 *   connection the recording could not have seen. */

const opened = vi.hoisted(() => [] as { file: string; readonly: boolean }[]);
const handedToWorkers = vi.hoisted(() => [] as string[]);

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

/** Worker threads as they are, with the file each is handed noted down first. */
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class Recording extends actual.Worker {
    constructor(source: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      const file = (options?.workerData as { file?: unknown } | undefined)?.file;
      if (typeof file === "string") handedToWorkers.push(file);
      super(source, options);
    }
  }
  return { ...actual, Worker: Recording, default: { ...actual, Worker: Recording } };
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
/** Whatever was opened here, or handed to a worker to open, that is not a file in the backup directory. */
const openedInHome = (scene: Scene): string[] =>
  [...opened.map((entry) => entry.file), ...handedToWorkers].filter((file) => !file.startsWith(`${scene.backups}${path.sep}`));
const gatewayRunning = (scene: Scene): void => {
  fs.writeFileSync(path.join(scene.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
};

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

/** Forgets what has been recorded so far, so that only what follows is looked at. */
function forget(): void {
  opened.length = 0;
  handedToWorkers.length = 0;
}

afterEach(() => {
  process.exitCode = previousExitCode;
  forget();
  removeTempDirs();
});

describe("ryoko backup run", () => {
  it("opens no database at all unless it is asked for them", async () => {
    const scene = sceneOver(makeHome(tempDir()));
    leaveInUse(scene);
    const before = fingerprints(scene);
    forget();

    await runBackupRun({ json: true }, scene.deps);

    expect(opened).toEqual([]);
    expect(handedToWorkers).toEqual([]);
    expect(fingerprints(scene)).toEqual(before);
    expect(process.exitCode).toBeUndefined();
  });

  it("opens no database when it is asked for them and a gateway appears to be running", async () => {
    const scene = sceneOver(makeHome(tempDir()));
    leaveInUse(scene);
    gatewayRunning(scene);
    const before = fingerprints(scene);
    forget();

    await runBackupRun({ json: true, includeDatabases: true }, scene.deps);

    expect(opened).toEqual([]);
    expect(handedToWorkers).toEqual([]);
    expect(fingerprints(scene)).toEqual(before);
    expect(process.exitCode).toBe(1);
  });

  it("opens them read-only, and only them, when it is asked and nothing suggests a gateway", async () => {
    const scene = sceneOver(makeHome(tempDir()));
    leaveInUse(scene);
    forget();

    await runBackupRun({ json: true, includeDatabases: true }, scene.deps);

    // The one place a command opens a database in the home.
    expect(opened.filter((entry) => !entry.file.startsWith(`${scene.backups}${path.sep}`)))
      .toEqual(scene.live.map((file) => ({ file, readonly: true })));
    // What a worker was given to check is each copy, still under its temporary name - never the database it was made from.
    expect(handedToWorkers.map((file) => path.dirname(file))).toEqual([scene.backups, scene.backups]);
    expect(handedToWorkers.map((file) => path.basename(file))).toEqual([
      expect.stringMatching(/^sessions-2026-10-12\.db\.tmp-/), expect.stringMatching(/^workflows-2026-10-12\.db\.tmp-/),
    ]);
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
    forget();
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
    // None of these hands a database to a worker: that is how a copy is checked as it is made, not how one is verified.
    expect(handedToWorkers).toEqual([]);
    expect(fingerprints(scene)).toEqual(before);
  });

  it("replace a database without ever opening the one being replaced", async () => {
    const scene = await backedUp();

    await runBackupRestore("sessions-2026-10-12", { gatewayStopped: true, json: true }, scene.deps);

    expect(process.exitCode).toBeUndefined();
    expect(openedInHome(scene)).toEqual([]);
    expect(opened.every((entry) => entry.readonly)).toBe(true);
    expect(handedToWorkers).toEqual([]);
    // Replaced all the same: the four rows of the backup, not the seven that were in use.
    forget();
    expect(rowCount(scene.live[0]!, "sessions")).toBe(4);
  });
});

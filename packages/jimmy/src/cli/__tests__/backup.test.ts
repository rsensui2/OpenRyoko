import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  databaseFingerprint,
  HOME_CONTENT,
  leaveMidFlight,
  makeHome,
  openForWriting,
  rawDirectory,
  removeTempDirs,
  rowCount,
  setDatabaseModified,
  tempDir,
  writeRawArchive,
  writeTree,
} from "../../backup/__tests__/fixture.js";
import { archiveStamp, listBackups } from "../../backup/catalog.js";
import { BACKUP_STATE_FILE, readBackupState } from "../../backup/state.js";
import type { JinnConfig } from "../../shared/types.js";
import { runBackupList, runBackupRestore, runBackupRun, runBackupVerify, type BackupCliDeps } from "../backup.js";

/* `ryoko backup run | list | verify <id> | restore <id>`, driven the way an
 * operator or an agent drives it: through the handlers the binary calls, on a
 * throwaway home, reading what they print and the exit code they leave. */

interface Cli {
  home: string;
  out: string[];
  err: string[];
  deps: BackupCliDeps;
  clock: { now: Date };
  config: Pick<JinnConfig, "backup">;
}

const START = new Date("2026-10-12T03:00:00.000Z");
let previousExitCode: typeof process.exitCode;

function cli(home: string, config: Pick<JinnConfig, "backup"> = {}): Cli {
  const state: Cli = { home, out: [], err: [], clock: { now: START }, config, deps: {} };
  state.deps = {
    home,
    io: { out: (text) => { state.out.push(text); }, err: (text) => { state.err.push(text); } },
    now: () => state.clock.now,
    loadConfig: () => state.config,
  };
  return state;
}

/** Everything printed so far, then forgotten, so each step is read on its own. */
function take(lines: string[]): string {
  return lines.splice(0).join("\n");
}

const json = <T>(state: Cli): T => JSON.parse(take(state.out)) as T;
const later = (state: Cli, minutes: number): void => { state.clock.now = new Date(state.clock.now.getTime() + minutes * 60_000); };
const read = (home: string, relative: string): string => fs.readFileSync(path.join(home, ...relative.split("/")), "utf8");
const liveDatabases = (home: string): string[] => [path.join(home, "sessions", "registry.db"), path.join(home, "workflows", "workflows.db")];

/**
 * Stamps the home's databases as untouched for the last hour of the test's own
 * clock, the way they are once a gateway has been stopped for a while. File
 * times come from the wall clock otherwise, and a database written within the
 * minute is what a running gateway looks like.
 */
function quiet(state: Cli): void {
  for (const live of liveDatabases(state.home)) setDatabaseModified(live, new Date(state.clock.now.getTime() - 60 * 60_000));
}

const gatewayRunning = (state: Cli): void => {
  fs.writeFileSync(path.join(state.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
};

interface RunReport {
  status: string;
  directory: string;
  targets: { name: string; status: string; reason?: string; detail?: string; file?: string; error?: string }[];
}
interface Listing { directory: string; backups: { id: string; kind: string; preRestore: boolean; bytes: number; createdAt: string }[] }

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  removeTempDirs();
});

describe("ryoko backup", () => {
  it("goes all the way round with the gateway stopped: run with the databases, list, verify, break something, restore", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 6, workflowRows: 2 });
    const state = cli(home);
    quiet(state);

    await runBackupRun({ json: true, includeDatabases: true }, state.deps);
    const report = json<RunReport>(state);
    expect(report.status).toBe("ok");
    expect(report.targets.map((target) => [target.name, target.status])).toEqual([["home", "ok"], ["sessions", "ok"], ["workflows", "ok"]]);
    expect(process.exitCode).toBeUndefined();

    await runBackupList({ json: true }, state.deps);
    const listing = json<Listing>(state);
    expect(listing.directory).toBe(path.join(home, "backups"));
    expect(listing.backups.map((item) => item.id).sort()).toEqual(["home-20261012T030000Z", "sessions-2026-10-12", "workflows-2026-10-12"]);

    for (const { id } of listing.backups) {
      await runBackupVerify(id, { json: true }, state.deps);
      expect(json<{ id: string; ok: boolean; problems: string[] }>(state), id).toMatchObject({ id, ok: true, problems: [] });
    }
    expect(process.exitCode).toBeUndefined();

    fs.writeFileSync(path.join(home, "config.yaml"), "gateway: { port: broken\n");
    fs.rmSync(path.join(home, "MEMORY.md"));
    later(state, 30);
    await runBackupRestore("home-20261012T030000Z", { json: true }, state.deps);

    const restored = json<{ id: string; dryRun: boolean; changes: { path: string; action: string }[]; preRestore: { id: string } }>(state);
    expect(restored.changes.map((change) => [change.path, change.action]).sort()).toEqual([["MEMORY.md", "create"], ["config.yaml", "replace"]]);
    expect(restored.preRestore.id).toBe("pre-restore-20261012T033000Z");
    expect(read(home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    expect(read(home, "MEMORY.md")).toBe(HOME_CONTENT["MEMORY.md"]);
    expect(process.exitCode).toBeUndefined();
    expect(take(state.err)).toBe("");
  });

  it("prints a summary a person can read when --json is not given", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 1 });
    const state = cli(home);

    await runBackupRun({}, state.deps);
    const ran = take(state.out);
    expect(ran).toContain(path.join(home, "backups"));
    expect(ran).toMatch(/ok\s+home\s+home-20261012T030000Z/);
    // The registry is there and is not this command's to open. Said, not passed over in silence.
    expect(ran).toMatch(/対象外\s+sessions/);
    expect(ran).toMatch(/workflows.*no database in this home/);
    expect(process.exitCode).toBeUndefined();

    await runBackupList({}, state.deps);
    const listed = take(state.out);
    expect(listed).toMatch(/home-20261012T030000Z\s+home/);
    expect(listed).not.toMatch(/sessions-/);

    await runBackupVerify("home-20261012T030000Z", {}, state.deps);
    expect(take(state.out)).toMatch(/^ok\s+home-20261012T030000Z/);
  });
});

describe("ryoko backup run and the databases", () => {
  /** A home whose databases look the way a gateway's do from outside: rows still in the WAL, nobody visibly holding them. */
  function withLiveDatabases(config: Pick<JinnConfig, "backup"> = {}): { state: Cli; fingerprints: () => Record<string, string>[] } {
    const home = makeHome(tempDir());
    const [sessions, workflows] = liveDatabases(home);
    leaveMidFlight(sessions!, "sessions", 5);
    leaveMidFlight(workflows!, "workflows", 3);
    const state = cli(home, config);
    quiet(state);
    return { state, fingerprints: () => liveDatabases(home).map(databaseFingerprint) };
  }

  const outcomes = (report: RunReport): (string | undefined)[][] => report.targets.map((target) => [target.name, target.status, target.reason]);
  const kindsKept = (state: Cli): string[] => listBackups(path.join(state.home, "backups")).map((item) => item.kind).sort();

  it("takes the files and does not open a database, unless it is asked for them", async () => {
    // Read-only or not, a connection writes beside the database it opens, and
    // from the host it cannot see a gateway in a container holding it. What
    // cannot be checked is not left as what the command does by default.
    const { state, fingerprints } = withLiveDatabases();
    const before = fingerprints();

    await runBackupRun({ json: true }, state.deps);

    const report = json<RunReport>(state);
    expect(report.status).toBe("ok");
    expect(outcomes(report)).toEqual([["home", "ok", undefined], ["sessions", "withheld", "not-requested"], ["workflows", "withheld", "not-requested"]]);
    expect(report.targets[1]!.detail).toContain("--include-databases");
    expect(process.exitCode).toBeUndefined();
    expect(kindsKept(state)).toEqual(["home"]);
    expect(fingerprints()).toEqual(before);
  });

  it("says who does copy the databases, and what this command is for", async () => {
    const { state } = withLiveDatabases();

    await runBackupRun({}, state.deps);

    const printed = take(state.out);
    expect(printed).toMatch(/対象外\s+sessions/);
    expect(printed).toMatch(/対象外\s+workflows/);
    expect(printed).toMatch(/DB.*gateway.*1日1回/);
    expect(printed).toMatch(/設定・cron・人格/);
    expect(printed).toContain("ryoko backup run --include-databases");
  });

  it("does not claim a daily copy that is not being made when the daily backups are off", async () => {
    const { state } = withLiveDatabases({ backup: { enabled: false } });

    await runBackupRun({}, state.deps);

    const printed = take(state.out);
    expect(printed).toContain("backup.enabled: false");
    expect(printed).not.toMatch(/1日1回/);
    await runBackupRun({ json: true }, state.deps);
    expect(json<RunReport>(state).targets[1]!.detail).toContain("backup.enabled: false");
  });

  it("copies the databases as well when asked to, on a home nothing is running on", async () => {
    const { state } = withLiveDatabases();

    await runBackupRun({ json: true, includeDatabases: true }, state.deps);

    const report = json<RunReport>(state);
    expect(report.status).toBe("ok");
    expect(outcomes(report)).toEqual([["home", "ok", undefined], ["sessions", "ok", undefined], ["workflows", "ok", undefined]]);
    expect(process.exitCode).toBeUndefined();
    expect(rowCount(report.targets[1]!.file!, "sessions")).toBe(5);
    expect(rowCount(report.targets[2]!.file!, "workflows")).toBe(3);
  });

  it("takes the files, leaves the databases unopened and exits non-zero when asked for them under a running gateway", async () => {
    const { state, fingerprints } = withLiveDatabases();
    gatewayRunning(state);
    const before = fingerprints();

    await runBackupRun({ json: true, includeDatabases: true }, state.deps);

    const report = json<RunReport>(state);
    expect(report.status).toBe("incomplete");
    expect(outcomes(report)).toEqual([["home", "ok", undefined], ["sessions", "withheld", "gateway-running"], ["workflows", "withheld", "gateway-running"]]);
    expect(report.targets[1]!.detail).toMatch(/gateway\.json names pid \d+/);
    expect(process.exitCode).toBe(1);
    expect(kindsKept(state)).toEqual(["home"]);
    expect(fingerprints()).toEqual(before);
  });

  it("tells a person why the databases were left, and what to do, when the registry was written a moment ago", async () => {
    const { state, fingerprints } = withLiveDatabases();
    const justNow = new Date(state.clock.now.getTime() - 8_000);
    fs.utimesSync(`${liveDatabases(state.home)[0]}-wal`, justNow, justNow);
    const before = fingerprints();

    await runBackupRun({ includeDatabases: true }, state.deps);

    const printed = take(state.out);
    expect(printed).toMatch(/ok\s+home\s+home-20261012T030000Z/);
    expect(printed).toMatch(/見送り\s+sessions/);
    expect(printed).toMatch(/見送り\s+workflows/);
    expect(printed).toContain("registry.db-wal was written 8 seconds ago");
    expect(printed).toContain("wait a minute");
    expect(printed).toMatch(/DB.*gateway.*1日1回/);
    expect(process.exitCode).toBe(1);
    expect(fingerprints()).toEqual(before);
  });

  it("has nothing left to do for the databases, gateway or no gateway, once today's copies are there", async () => {
    const { state } = withLiveDatabases();
    await runBackupRun({ json: true, includeDatabases: true }, state.deps);
    take(state.out);
    later(state, 5);
    gatewayRunning(state);
    const before = liveDatabases(state.home).map(databaseFingerprint);

    await runBackupRun({ json: true, includeDatabases: true }, state.deps);

    const report = json<RunReport>(state);
    expect(report.status).toBe("ok");
    expect(report.targets.map((target) => [target.name, target.status])).toEqual([["home", "ok"], ["sessions", "skipped"], ["workflows", "skipped"]]);
    expect(process.exitCode).toBeUndefined();
    // Not opened to find that out, either.
    expect(liveDatabases(state.home).map(databaseFingerprint)).toEqual(before);
  });

  it("records the files as backed up and leaves the databases owed, so the gateway still copies them", async () => {
    const { state } = withLiveDatabases();

    await runBackupRun({ json: true }, state.deps);

    expect(readBackupState(path.join(state.home, "backups")).targets).toEqual({
      home: { lastAttemptAt: START.toISOString(), lastSuccessAt: START.toISOString() },
    });

    // The same when it was asked for them and a gateway turned out to be there.
    gatewayRunning(state);
    later(state, 5);
    await runBackupRun({ json: true, includeDatabases: true }, state.deps);
    expect(Object.keys(readBackupState(path.join(state.home, "backups")).targets)).toEqual(["home"]);
  });
});

describe("ryoko backup run", () => {
  it("exits non-zero when a target failed, and still reports the ones that did not", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 3 });
    writeTree(home, { "workflows/workflows.db": "this is not a database" });
    const state = cli(home);
    quiet(state);

    await runBackupRun({ json: true, includeDatabases: true }, state.deps);

    const report = json<RunReport>(state);
    expect(process.exitCode).toBe(1);
    expect(report.status).toBe("failed");
    expect(report.targets.map((target) => [target.name, target.status])).toEqual([["home", "ok"], ["sessions", "ok"], ["workflows", "failed"]]);
  });

  it("names the failed target and the reason for a person, too", async () => {
    const home = makeHome(tempDir());
    writeTree(home, { "knowledge/dump.bin": "x".repeat(3 * 1024 * 1024) });
    const state = cli(home, { backup: { maxArchiveMb: 1 } });

    await runBackupRun({}, state.deps);

    expect(process.exitCode).toBe(1);
    expect(take(state.out)).toMatch(/失敗\s+home\s+.*over the 1\.0 MB limit/);
  });

  it("counts towards the gateway's daily schedule for everything it did copy", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 1 });
    const state = cli(home);
    quiet(state);

    await runBackupRun({ json: true, includeDatabases: true }, state.deps);

    const recorded = readBackupState(path.join(home, "backups"));
    expect(recorded.targets).toEqual({
      home: { lastAttemptAt: START.toISOString(), lastSuccessAt: START.toISOString() },
      sessions: { lastAttemptAt: START.toISOString(), lastSuccessAt: START.toISOString() },
      workflows: { lastAttemptAt: START.toISOString(), lastSuccessAt: START.toISOString() },
    });
  });

  it("runs when asked even though the daily backups are switched off", async () => {
    const home = makeHome(tempDir());
    const state = cli(home, { backup: { enabled: false } });

    await runBackupRun({ json: true }, state.deps);

    expect(json<RunReport>(state).targets[0]).toMatchObject({ name: "home", status: "ok" });
  });

  it("writes where the config says, and keeps the configured number of days", async () => {
    const root = tempDir();
    const home = makeHome(root);
    const outside = path.join(root, "external");
    const state = cli(home, { backup: { directory: outside, retention: 2 } });

    for (let round = 0; round < 3; round += 1) {
      await runBackupRun({ json: true }, state.deps);
      later(state, 24 * 60);
    }

    expect(listBackups(outside).map((item) => item.id)).toEqual(["home-20261014T030000Z", "home-20261013T030000Z"]);
    expect(fs.existsSync(path.join(outside, BACKUP_STATE_FILE))).toBe(true);
  });

  it("can be run as often as anyone likes without costing the days already kept", async () => {
    // The doc tells people to run it before a big change. An agent that takes
    // that to heart must not shorten the history to an afternoon.
    const home = makeHome(tempDir());
    const state = cli(home, { backup: { retention: 3 } });
    await runBackupRun({ json: true }, state.deps);
    later(state, 24 * 60);

    // Five in one day, where three of a day are kept: enough to show the day is capped and yesterday is not what pays for it.
    for (let round = 0; round < 5; round += 1) {
      await runBackupRun({ json: true }, state.deps);
      later(state, 5);
    }

    expect(listBackups(path.join(home, "backups")).map((item) => item.id)).toEqual([
      "home-20261013T032000Z", "home-20261013T031500Z", "home-20261013T031000Z", "home-20261012T030000Z",
    ]);
  });

  it("falls back to the default directory, and says so, when config.yaml cannot be read", async () => {
    const home = makeHome(tempDir());
    const state = cli(home);
    state.deps = { ...state.deps, loadConfig: () => { throw new Error("bad indentation of a mapping entry (3:1)"); } };

    await runBackupRun({ json: true }, state.deps);

    expect(json<RunReport>(state).directory).toBe(path.join(home, "backups"));
    const note = take(state.err);
    expect(note).toContain("config.yaml");
    expect(note).toContain("既定");
    expect(note).toContain("bad indentation of a mapping entry (3:1)");
    expect(process.exitCode).toBeUndefined();
  });

  it("says where config.yaml stopped parsing without repeating any of it", async () => {
    // A YAML error names what it tripped over and quotes the lines around it.
    // In this file, those are the lines that hold the tokens.
    const home = makeHome(tempDir());
    const state = cli(home);
    const token = "xoxb-not-a-real-token-0000";
    const parseError = Object.assign(
      new Error(`unidentified alias "${token}" (4:13)\n\n 3 | connectors:\n 4 |   botToken: *${token}\n-----------------^`),
      { name: "YAMLException", reason: `unidentified alias "${token}"`, mark: { line: 3, column: 12, snippet: ` 4 |   botToken: *${token}` } },
    );
    state.deps = { ...state.deps, loadConfig: () => { throw parseError; } };

    await runBackupRun({ json: true }, state.deps);

    const note = take(state.err);
    expect(note).not.toContain(token);
    expect(note).not.toContain("botToken");
    expect(note).not.toContain("alias");
    expect(note).toContain("config.yaml");
    expect(note).toContain("4 行目 13 桁目");
    expect(note).toContain("既定");
    expect(json<RunReport>(state).status).toBe("ok");
  });

  it("passes on a setting it had to ignore", async () => {
    const home = makeHome(tempDir());
    const state = cli(home, { backup: { retention: -3 } });

    await runBackupRun({ json: true }, state.deps);

    expect(take(state.err)).toMatch(/backup\.retention/);
    expect(json<RunReport>(state).status).toBe("ok");
  });
});

describe("ryoko backup list", () => {
  it("says there is nothing yet, and where it looked", async () => {
    const home = makeHome(tempDir());
    const state = cli(home);

    await runBackupList({}, state.deps);
    expect(take(state.out)).toContain(path.join(home, "backups"));

    await runBackupList({ json: true }, state.deps);
    expect(json<Listing>(state)).toEqual({ directory: path.join(home, "backups"), backups: [] });
  });

  it("lists the newest first and marks the snapshots a restore took", async () => {
    const home = makeHome(tempDir());
    const state = cli(home);
    await runBackupRun({ json: true }, state.deps);
    later(state, 60);
    fs.writeFileSync(path.join(home, "config.yaml"), "edited\n");
    await runBackupRun({ json: true }, state.deps);
    later(state, 60);
    await runBackupRestore("home-20261012T030000Z", { json: true }, state.deps);
    take(state.out);

    await runBackupList({ json: true }, state.deps);

    expect(json<Listing>(state).backups.map(({ id, preRestore }) => [id, preRestore])).toEqual([
      ["pre-restore-20261012T050000Z", true],
      ["home-20261012T040000Z", false],
      ["home-20261012T030000Z", false],
    ]);
  });
});

describe("ryoko backup verify", () => {
  it("exits non-zero and lists what is wrong with a damaged archive", async () => {
    const home = makeHome(tempDir());
    const state = cli(home);
    await runBackupRun({ json: true }, state.deps);
    take(state.out);
    const file = path.join(home, "backups", "home-20261012T030000Z.tar.gz");
    const whole = fs.readFileSync(file);
    fs.writeFileSync(file, whole.subarray(0, whole.length - 30));

    await runBackupVerify("home-20261012T030000Z", { json: true }, state.deps);

    const verdict = json<{ ok: boolean; problems: string[] }>(state);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it("gives up on an archive that holds more than the configured limits, rather than reading it all in", async () => {
    // What a planted file in backups/ looks like: tens of thousands of empty
    // directories in a few kilobytes of gzip.
    const home = makeHome(tempDir());
    const state = cli(home, { backup: { maxEntries: 100 } });
    writeRawArchive(
      path.join(home, "backups", "home-20261012T010000Z.tar.gz"),
      [rawDirectory("skills"), ...Array.from({ length: 400 }, (_, index) => rawDirectory(`skills/d${String(index).padStart(4, "0")}`))],
    );

    await runBackupVerify("home-20261012T010000Z", { json: true }, state.deps);

    const verdict = json<{ ok: boolean; problems: string[] }>(state);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toMatch(/more than 100 entries.*backup\.maxEntries/);
    expect(process.exitCode).toBe(1);
  });

  it("checks a database copy with SQLite's own integrity check", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 4 });
    const state = cli(home);
    quiet(state);
    await runBackupRun({ json: true, includeDatabases: true }, state.deps);
    take(state.out);

    await runBackupVerify("sessions-2026-10-12", { json: true }, state.deps);
    expect(json<{ kind: string; ok: boolean }>(state)).toMatchObject({ kind: "sessions", ok: true });
    expect(process.exitCode).toBeUndefined();

    fs.writeFileSync(path.join(home, "backups", "sessions-2026-10-12.db"), "overwritten");
    await runBackupVerify("sessions-2026-10-12", {}, state.deps);
    expect(take(state.out)).toMatch(/^失敗\s+sessions-2026-10-12/);
    expect(process.exitCode).toBe(1);
  });

  it("verifies an archive given by path, wherever it is kept", async () => {
    const root = tempDir();
    const home = makeHome(root);
    const state = cli(home);
    await runBackupRun({ json: true }, state.deps);
    take(state.out);
    const moved = path.join(root, "usb", "home-20261012T030000Z.tar.gz");
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(path.join(home, "backups", "home-20261012T030000Z.tar.gz"), moved);

    await runBackupVerify(moved, { json: true }, state.deps);

    expect(json<{ ok: boolean; file: string }>(state)).toMatchObject({ ok: true, file: moved });
  });

  it("tells the operator how to find the id when it does not exist", async () => {
    const home = makeHome(tempDir());
    const state = cli(home);

    await runBackupVerify("home-20991231T000000Z", {}, state.deps);

    expect(take(state.err)).toMatch(/home-20991231T000000Z.*ryoko backup list/s);
    expect(process.exitCode).toBe(1);
  });

  it("reports an error as JSON when --json was asked for", async () => {
    const home = makeHome(tempDir());
    const state = cli(home);

    await runBackupVerify("home-20991231T000000Z", { json: true }, state.deps);

    expect(JSON.parse(take(state.err))).toEqual({ error: expect.stringContaining("home-20991231T000000Z") });
    expect(take(state.out)).toBe("");
  });
});

describe("ryoko backup restore", () => {
  /** A home with an archive and a copy of each database it has, as after a day with the gateway up - taken here with it stopped. */
  async function backedUp(options: Parameters<typeof makeHome>[2] = {}, config: Pick<JinnConfig, "backup"> = {}): Promise<Cli> {
    const state = cli(makeHome(tempDir(), "home", options), config);
    quiet(state);
    await runBackupRun({ json: true, includeDatabases: true }, state.deps);
    take(state.out);
    later(state, 30);
    return state;
  }

  it("restores only the kinds named with --only", async () => {
    const state = await backedUp();
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");
    fs.writeFileSync(path.join(state.home, "AGENTS.md"), "rewritten\n");
    fs.writeFileSync(path.join(state.home, "cron", "jobs.json"), "[]\n");

    await runBackupRestore("home-20261012T030000Z", { only: "config, cron", json: true }, state.deps);

    expect(json<{ kinds: string[] }>(state).kinds).toEqual(["config", "cron"]);
    expect(read(state.home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    expect(read(state.home, "cron/jobs.json")).toBe(HOME_CONTENT["cron/jobs.json"]);
    expect(read(state.home, "AGENTS.md")).toBe("rewritten\n");
  });

  it("shows what would change and changes nothing with --dry-run", async () => {
    const state = await backedUp();
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");

    await runBackupRestore("home-20261012T030000Z", { dryRun: true }, state.deps);

    const printed = take(state.out);
    expect(printed).toMatch(/dry-run/);
    expect(printed).toMatch(/置換\s+config\.yaml/);
    expect(read(state.home, "config.yaml")).toBe("broken\n");
    expect(listBackups(path.join(state.home, "backups")).filter((item) => item.preRestore)).toEqual([]);
  });

  it("tells a person where the previous state went and how to get it back", async () => {
    const state = await backedUp();
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");
    writeTree(state.home, { "knowledge/new.md": "written after the backup\n" });

    await runBackupRestore("home-20261012T030000Z", {}, state.deps);

    const printed = take(state.out);
    expect(printed).toMatch(/置換\s+config\.yaml/);
    expect(printed).toContain("ryoko backup restore pre-restore-20261012T033000Z");
    expect(printed).toContain("knowledge/new.md");
    // Nothing was created this time, so there is nothing that going back would leave behind.
    expect(printed).not.toContain("消えません");
  });

  it("says that going back will not remove the files this restore created", async () => {
    const state = await backedUp();
    fs.rmSync(path.join(state.home, "MEMORY.md"));
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");

    await runBackupRestore("home-20261012T030000Z", {}, state.deps);

    const printed = take(state.out);
    expect(printed).toMatch(/作成\s+MEMORY\.md/);
    expect(printed).toContain("ryoko backup restore pre-restore-20261012T033000Z");
    // The snapshot holds config.yaml as it was. It cannot hold the absence of MEMORY.md.
    expect(printed).toMatch(/新しく作成した 1 件.*消えません/s);
  });

  it("goes back to what it overwrote and leaves what it created, as it said it would", async () => {
    // What docs/backup.md tells an operator about the way back, held to the code.
    const state = await backedUp();
    fs.rmSync(path.join(state.home, "MEMORY.md"));
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");
    await runBackupRestore("home-20261012T030000Z", { json: true }, state.deps);
    take(state.out);
    later(state, 30);

    // The snapshot holds what was overwritten and nothing else, so that is all a dry run of the way back shows changing.
    await runBackupRestore("pre-restore-20261012T033000Z", { dryRun: true, json: true }, state.deps);
    const wayBack = json<{ kinds: string[]; changes: Array<{ path: string; action: string }> }>(state);
    expect(wayBack.kinds).toEqual(["config"]);
    expect(wayBack.changes).toEqual([expect.objectContaining({ path: "config.yaml", action: "replace" })]);

    await runBackupRestore("pre-restore-20261012T033000Z", {}, state.deps);

    expect(read(state.home, "config.yaml")).toBe("broken\n");
    expect(read(state.home, "MEMORY.md")).toBe(HOME_CONTENT["MEMORY.md"]);
  });

  it("says there is no snapshot, and how to go back, when the restore only created files", async () => {
    const state = await backedUp();
    fs.rmSync(path.join(state.home, "MEMORY.md"));

    await runBackupRestore("home-20261012T030000Z", {}, state.deps);

    const printed = take(state.out);
    expect(printed).toMatch(/作成\s+MEMORY\.md/);
    expect(printed).toMatch(/何も上書きしていない[^。]*退避はありません/);
    expect(printed).toMatch(/「作成」の 1 件を消/);
    expect(printed).not.toContain("pre-restore-");
    expect(listBackups(path.join(state.home, "backups")).filter((item) => item.preRestore)).toEqual([]);
  });

  it("rejects a kind it does not know, naming the ones it does", async () => {
    const state = await backedUp();

    await runBackupRestore("home-20261012T030000Z", { only: "config,secrets" }, state.deps);

    expect(take(state.err)).toMatch(/secrets.*config.*cron.*persona.*memory/s);
    expect(process.exitCode).toBe(1);
  });

  it("passes on what the restore could not clear away, and leaves it where it is", async () => {
    // Something that is not the restore's turns up in its working directory:
    // it is not deleted along with the rest, and the operator is told where it is.
    const state = await backedUp();
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");
    const realRename = fs.renameSync;
    let staging = "";
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!staging && String(from).includes(`${path.sep}tmp${path.sep}restore-`)) {
        staging = path.dirname(String(from));
        writeTree(staging, { "left-here/keep.txt": "not the restore's to remove\n" });
      }
      realRename(from, to);
    });
    try {
      await runBackupRestore("home-20261012T030000Z", {}, state.deps);
    } finally {
      rename.mockRestore();
    }

    const printed = take(state.out);
    expect(printed).toMatch(/置換\s+config\.yaml/);
    expect(printed).toMatch(new RegExp(`警告: ${staging.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .*was left as it is`));
    expect(read(staging, "left-here/keep.txt")).toBe("not the restore's to remove\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a damaged archive and leaves the home as it was", async () => {
    const state = await backedUp();
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");
    const file = path.join(state.home, "backups", "home-20261012T030000Z.tar.gz");
    fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 200));

    await runBackupRestore("home-20261012T030000Z", {}, state.deps);

    expect(take(state.err)).toMatch(/failed verification/);
    expect(process.exitCode).toBe(1);
    expect(read(state.home, "config.yaml")).toBe("broken\n");
  });

  /** Stamps the registry as untouched for the last hour of the test's own clock. File times come from the wall clock otherwise. */
  function idle(state: Cli, live: string): void {
    setDatabaseModified(live, new Date(state.clock.now.getTime() - 60 * 60_000));
  }

  /** A registry backed up at four rows that has since grown to five, and has been idle for an hour. */
  async function grownRegistry(): Promise<{ state: Cli; live: string }> {
    const state = await backedUp({ sessionRows: 4 });
    const live = path.join(state.home, "sessions", "registry.db");
    const grow = openForWriting(live);
    grow.prepare("INSERT INTO sessions (label) VALUES (?)").run("after the backup");
    grow.close();
    idle(state, live);
    return { state, live };
  }

  /**
   * The same backup, beside a registry that looks the way a live one does to a
   * process that cannot see its locks: rows still in the WAL, nobody visibly
   * holding it. This is the host's view of a gateway running in a container.
   */
  async function registryMidFlight(): Promise<{ state: Cli; live: string }> {
    const state = await backedUp({ sessionRows: 4 });
    const live = path.join(state.home, "sessions", "registry.db");
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${live}${suffix}`, { force: true });
    leaveMidFlight(live, "sessions", 7);
    idle(state, live);
    return { state, live };
  }

  it("restores a database copy once the operator confirms the gateway is stopped", async () => {
    const { state, live } = await grownRegistry();

    await runBackupRestore("sessions-2026-10-12", { gatewayStopped: true, json: true }, state.deps);

    expect(json<{ name: string; preRestore: { id: string } }>(state)).toMatchObject({
      name: "sessions", preRestore: { id: "pre-restore-20261012T033000Z-sessions" },
    });
    expect(rowCount(live, "sessions")).toBe(4);
    expect(process.exitCode).toBeUndefined();
  });

  it("will not replace a database without --gateway-stopped, and explains the container case", async () => {
    const { state, live } = await grownRegistry();
    const before = fs.readFileSync(live);

    await runBackupRestore("sessions-2026-10-12", {}, state.deps);

    const refusal = take(state.err);
    expect(refusal).toContain("--gateway-stopped");
    expect(refusal).toMatch(/container/);
    expect(refusal).toContain("ryoko stop");
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(live).equals(before)).toBe(true);
    expect(listBackups(path.join(state.home, "backups")).filter((item) => item.preRestore)).toEqual([]);
  });

  it("previews a database restore without the flag, and says the real one needs it", async () => {
    const { state, live } = await grownRegistry();

    await runBackupRestore("sessions-2026-10-12", { dryRun: true }, state.deps);

    const printed = take(state.out);
    expect(printed).toMatch(/dry-run/);
    expect(printed).toContain("--gateway-stopped");
    expect(process.exitCode).toBeUndefined();
    expect(rowCount(live, "sessions")).toBe(5);
  });

  it("refuses to restore a database while the gateway is running, even with the flag", async () => {
    const state = await backedUp({ sessionRows: 4 });
    fs.writeFileSync(path.join(state.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
    const live = path.join(state.home, "sessions", "registry.db");
    const before = fs.readFileSync(live);

    await runBackupRestore("sessions-2026-10-12", { gatewayStopped: true }, state.deps);

    const refusal = take(state.err);
    expect(refusal).toMatch(/gateway appears to be running/);
    expect(refusal).toContain("ryoko stop");
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(live).equals(before)).toBe(true);
  });

  it("leaves a registry that may be in use exactly as it was, whichever way the command ends without restoring", async () => {
    // Run on the host against a home that a container's gateway has open, none
    // of these may so much as open the registry: doing that is what deletes
    // its WAL. Bytes, sidecars and timestamps, not row counts.
    const { state, live } = await registryMidFlight();
    const before = databaseFingerprint(live);
    expect(Object.values(before)).not.toContain("absent");

    await runBackupRestore("sessions-2026-10-12", { dryRun: true }, state.deps);
    expect(process.exitCode).toBeUndefined();
    expect(databaseFingerprint(live)).toEqual(before);

    await runBackupRestore("sessions-2026-10-12", {}, state.deps);
    expect(process.exitCode).toBe(1);
    expect(take(state.err)).toContain("Nothing was changed.");
    expect(databaseFingerprint(live)).toEqual(before);

    process.exitCode = undefined;
    fs.writeFileSync(path.join(state.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
    for (const options of [{ gatewayStopped: true }, { dryRun: true }]) {
      await runBackupRestore("sessions-2026-10-12", options, state.deps);
      expect(take(state.err)).toMatch(/gateway appears to be running/);
    }
    expect(process.exitCode).toBe(1);
    expect(databaseFingerprint(live)).toEqual(before);
  });

  it("refuses, flag or not, when the registry was written a few seconds ago", async () => {
    const { state, live } = await registryMidFlight();
    const justNow = new Date(state.clock.now.getTime() - 8_000);
    fs.utimesSync(`${live}-wal`, justNow, justNow);
    const before = databaseFingerprint(live);

    await runBackupRestore("sessions-2026-10-12", { gatewayStopped: true }, state.deps);

    const refusal = take(state.err);
    expect(refusal).toContain("registry.db-wal was written 8 seconds ago");
    expect(refusal).toContain("wait a minute");
    expect(process.exitCode).toBe(1);
    expect(databaseFingerprint(live)).toEqual(before);
  });

  it("asks for no such confirmation to restore files", async () => {
    const state = await backedUp({ sessionRows: 4 });
    fs.writeFileSync(path.join(state.home, "cron", "jobs.json"), "[]\n");

    await runBackupRestore("home-20261012T030000Z", { only: "cron", json: true }, state.deps);

    expect(read(state.home, "cron/jobs.json")).toBe(HOME_CONTENT["cron/jobs.json"]);
    expect(take(state.err)).toBe("");
    expect(process.exitCode).toBeUndefined();
  });

  it("restores files while the gateway is running", async () => {
    const state = await backedUp({ sessionRows: 4 });
    fs.writeFileSync(path.join(state.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");

    await runBackupRestore("home-20261012T030000Z", { only: "config", json: true }, state.deps);

    expect(read(state.home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("does not take --only for a database, which is restored whole", async () => {
    const state = await backedUp({ sessionRows: 4 });

    await runBackupRestore("sessions-2026-10-12", { only: "config" }, state.deps);

    expect(take(state.err)).toMatch(/--only/);
    expect(process.exitCode).toBe(1);
  });

  it("keeps the three most recent pre-restore snapshots of a day, and the archive it restored from", async () => {
    const state = await backedUp();

    for (let round = 0; round < 5; round += 1) {
      fs.writeFileSync(path.join(state.home, "config.yaml"), `broken ${round}\n`);
      await runBackupRestore("home-20261012T030000Z", { json: true }, state.deps);
      later(state, 10);
    }

    const kept = listBackups(path.join(state.home, "backups"));
    expect(kept.filter((item) => item.preRestore).map((item) => item.id)).toEqual([
      "pre-restore-20261012T041000Z", "pre-restore-20261012T040000Z", "pre-restore-20261012T035000Z",
    ]);
    expect(kept.filter((item) => !item.preRestore).map((item) => item.id)).toEqual(["home-20261012T030000Z"]);
  });

  it("does not prune away the snapshot it has just taken, nor the copy of the database it has just replaced", async () => {
    // A clock behind what is already in the directory: by their names the new
    // ones are the oldest there, and the first the rule would remove.
    const state = await backedUp({ sessionRows: 4 });
    const backups = path.join(state.home, "backups");
    const later = (days: number): string => archiveStamp(new Date(START.getTime() + days * 24 * 60 * 60_000));
    for (let days = 1; days <= 14; days += 1) {
      writeTree(backups, {
        [`pre-restore-${later(days)}.tar.gz`]: "a snapshot from before the clock moved",
        [`pre-restore-${later(days)}-sessions.db`]: "a copy from before the clock moved",
      });
    }
    fs.writeFileSync(path.join(state.home, "config.yaml"), "broken\n");

    // Each is looked for as its own command ends: the promise is that a run never removes what it wrote itself.
    await runBackupRestore("home-20261012T030000Z", { json: true }, state.deps);
    const files = json<{ preRestore: { id: string } }>(state);
    expect(fs.existsSync(path.join(backups, `${files.preRestore.id}.tar.gz`))).toBe(true);

    idle(state, path.join(state.home, "sessions", "registry.db"));
    await runBackupRestore("sessions-2026-10-12", { gatewayStopped: true, json: true }, state.deps);
    const database = json<{ preRestore: { id: string } }>(state);
    expect(fs.existsSync(path.join(backups, `${database.preRestore.id}.db`))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("recreates a symlink that leaves the home only with --allow-external-symlinks", async () => {
    const root = tempDir();
    const home = makeHome(root);
    const outside = path.join(root, "shared-skill");
    writeTree(outside, { "SKILL.md": "kept outside\n" });
    fs.symlinkSync(outside, path.join(home, "skills", "shared"));
    const state = cli(home);
    await runBackupRun({ json: true }, state.deps);
    take(state.out);
    later(state, 30);
    fs.unlinkSync(path.join(home, "skills", "shared"));

    await runBackupRestore("home-20261012T030000Z", {}, state.deps);
    expect(take(state.err)).toMatch(/--allow-external-symlinks/);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(home, "skills", "shared"))).toBe(false);

    process.exitCode = undefined;
    await runBackupRestore("home-20261012T030000Z", { allowExternalSymlinks: true, json: true }, state.deps);
    expect(fs.readlinkSync(path.join(home, "skills", "shared"))).toBe(outside);
    expect(process.exitCode).toBeUndefined();
  });
});

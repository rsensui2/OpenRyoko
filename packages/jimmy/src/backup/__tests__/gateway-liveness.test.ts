import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRunningGateway, RECENT_WRITE_MS } from "../gateway-liveness.js";
import { databaseFingerprint, leaveMidFlight, removeTempDirs, setDatabaseModified, tempDir } from "./fixture.js";

/* These are kept light on purpose. What is looked for here is a couple of pid
 * files and the timestamps of a database, so a home is an empty directory with
 * those in it - not the whole tree of an instance - and a test arranges one
 * database where one will do. The suite runs beside others on the same disk,
 * and a test that spends its time making files waits on all of them. */

const NOW = new Date("2026-10-12T09:30:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const HOUR_MS = 60 * 60 * 1000;

/**
 * A pid no process has. Asked of the system rather than got by starting a
 * process and letting it exit: that cost a whole interpreter's start-up, and
 * its pid could have been handed to another process by the time it was used.
 */
function deadPid(): number {
  // Above the pids macOS and a default Linux hand out, then upwards until one is free.
  for (let pid = 4_100_000; ; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
}

/** An instance home with nothing in it yet. */
function emptyHome(): string {
  const home = path.join(tempDir(), "home");
  fs.mkdirSync(home);
  return home;
}

/** A home whose registry looks the way a live one does to a process that cannot see its locks. */
function homeWithRegistryMidFlight(lastWritten = ago(HOUR_MS)): { home: string; registry: string } {
  const home = emptyHome();
  const registry = path.join(home, "sessions", "registry.db");
  leaveMidFlight(registry, "sessions", 40);
  setDatabaseModified(registry, lastWritten);
  return { home, registry };
}

afterEach(removeTempDirs);

describe("detectRunningGateway", () => {
  it("finds nothing running in a home no gateway has touched for an hour", () => {
    const { home } = homeWithRegistryMidFlight();

    expect(detectRunningGateway(home, { now: NOW })).toEqual({ running: false });
  });

  it("never opens the registry to find out: its files are exactly as they were", () => {
    // Opening a database that a gateway on the far side of a container
    // boundary has open makes SQLite checkpoint the WAL and delete it on
    // close. Looking must leave every byte, every sidecar and every timestamp.
    //
    // One registry, taken through the three answers in turn: looking changes
    // nothing, so what the first look found is what the next one starts from.
    const { home, registry } = homeWithRegistryMidFlight();
    const looksUnchanged = (expected: { running: boolean }): void => {
      const before = databaseFingerprint(registry);
      expect(Object.values(before)).not.toContain("absent");

      expect(detectRunningGateway(home, { now: NOW })).toMatchObject(expected);

      expect(databaseFingerprint(registry)).toEqual(before);
    };

    // Nothing running.
    looksUnchanged({ running: false });
    // Running, by a write five seconds ago.
    setDatabaseModified(registry, ago(5_000));
    looksUnchanged({ running: true });
    // Running, by a pid that is alive - found before the registry is so much as looked at.
    setDatabaseModified(registry, ago(HOUR_MS));
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
    looksUnchanged({ running: true });
  });

  it("recognises a gateway by the live pid in gateway.json", () => {
    const home = emptyHome();
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));

    const liveness = detectRunningGateway(home, { now: NOW });

    expect(liveness.running).toBe(true);
    expect(liveness.reason).toContain(`pid ${process.pid}`);
    expect(liveness.reason).toContain("gateway.json");
  });

  it("recognises a daemonised gateway by the live pid in gateway.pid", () => {
    const home = emptyHome();
    fs.writeFileSync(path.join(home, "gateway.pid"), `${process.pid}\n`);

    expect(detectRunningGateway(home, { now: NOW })).toMatchObject({ running: true, reason: expect.stringContaining("gateway.pid") });
  });

  it("ignores pid files left behind by a gateway that is gone", () => {
    const home = emptyHome();
    const gone = deadPid();
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ port: 7901, pid: gone, secret: "s" }));
    fs.writeFileSync(path.join(home, "gateway.pid"), String(gone));

    expect(detectRunningGateway(home, { now: NOW })).toEqual({ running: false });
  });

  it("ignores pid files that hold no usable pid", () => {
    const home = emptyHome();
    for (const contents of ["{ not json", "{}", '{"pid":"abc"}', '{"pid":-1}', '{"pid":0}']) {
      fs.writeFileSync(path.join(home, "gateway.json"), contents);
      expect(detectRunningGateway(home, { now: NOW }), contents).toEqual({ running: false });
    }
    fs.rmSync(path.join(home, "gateway.json"));
    for (const contents of ["", "not a pid", "0", "-7"]) {
      fs.writeFileSync(path.join(home, "gateway.pid"), contents);
      expect(detectRunningGateway(home, { now: NOW }), contents).toEqual({ running: false });
    }
  });

  it.each(["", "-wal", "-shm"])("takes a registry.db%s written within the last minute as a gateway at work", (suffix) => {
    // The one sign that crosses a bind mount: a pid means nothing in another
    // pid namespace and a file lock does not leave the container, but the
    // time a file was last written is the same from both sides.
    const { home, registry } = homeWithRegistryMidFlight();
    fs.utimesSync(`${registry}${suffix}`, ago(12_000), ago(12_000));

    const liveness = detectRunningGateway(home, { now: NOW });

    expect(liveness.running).toBe(true);
    expect(liveness.reason).toContain(`registry.db${suffix}`);
    expect(liveness.reason).toMatch(/12 seconds ago/);
  });

  it("stops counting a write as recent once a minute has passed", () => {
    const stale = homeWithRegistryMidFlight(ago(RECENT_WRITE_MS));
    const fresh = homeWithRegistryMidFlight(ago(RECENT_WRITE_MS - 1));

    expect(detectRunningGateway(stale.home, { now: NOW })).toEqual({ running: false });
    expect(detectRunningGateway(fresh.home, { now: NOW }).running).toBe(true);
    expect(RECENT_WRITE_MS).toBe(60_000);
  });

  it("counts a write stamped a little ahead of this clock, as another machine's clock may be", () => {
    const skewed = homeWithRegistryMidFlight(new Date(NOW.getTime() + 20_000));
    const nonsense = homeWithRegistryMidFlight(new Date(NOW.getTime() + 24 * HOUR_MS));

    expect(detectRunningGateway(skewed.home, { now: NOW }).running).toBe(true);
    // A date a day ahead says the clock was wrong once, not that someone is writing now.
    expect(detectRunningGateway(nonsense.home, { now: NOW })).toEqual({ running: false });
  });

  it("looks at any other database it is told is about to be replaced", () => {
    const { home } = homeWithRegistryMidFlight();
    const workflows = path.join(home, "workflows", "workflows.db");
    leaveMidFlight(workflows, "workflows", 10);
    setDatabaseModified(workflows, ago(HOUR_MS));

    expect(detectRunningGateway(home, { now: NOW, databases: [workflows] })).toEqual({ running: false });

    fs.utimesSync(`${workflows}-wal`, ago(3_000), ago(3_000));
    const before = databaseFingerprint(workflows);

    expect(detectRunningGateway(home, { now: NOW })).toEqual({ running: false });
    expect(detectRunningGateway(home, { now: NOW, databases: [workflows] })).toMatchObject({
      running: true, reason: expect.stringContaining("workflows.db-wal"),
    });
    expect(databaseFingerprint(workflows)).toEqual(before);
  });

  it("finds nothing in a home that has no registry at all", () => {
    expect(detectRunningGateway(emptyHome(), { now: NOW })).toEqual({ running: false });
  });
});

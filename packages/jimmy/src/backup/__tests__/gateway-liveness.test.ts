import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databaseHeldOpen, detectRunningGateway } from "../gateway-liveness.js";
import { makeHome, removeTempDirs, rowCount, tempDir } from "./fixture.js";

/** The pid of a process that has already exited. */
function deadPid(): number {
  const finished = spawnSync(process.execPath, ["-e", ""]);
  return finished.pid;
}

const held: Database.Database[] = [];

function holdOpen(file: string): Database.Database {
  const database = new Database(file);
  database.prepare("SELECT count(*) FROM sqlite_master").get();
  held.push(database);
  return database;
}

afterEach(() => {
  for (const database of held.splice(0)) database.close();
  removeTempDirs();
});

describe("detectRunningGateway", () => {
  it("finds nothing running in a home no gateway has touched", () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 3 });

    expect(detectRunningGateway(home)).toEqual({ running: false });
  });

  it("recognises a gateway by the live pid in gateway.json", () => {
    const home = makeHome(tempDir());
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));

    const liveness = detectRunningGateway(home);

    expect(liveness.running).toBe(true);
    expect(liveness.reason).toContain(`pid ${process.pid}`);
    expect(liveness.reason).toContain("gateway.json");
  });

  it("recognises a daemonised gateway by the live pid in gateway.pid", () => {
    const home = makeHome(tempDir());
    fs.writeFileSync(path.join(home, "gateway.pid"), `${process.pid}\n`);

    expect(detectRunningGateway(home)).toMatchObject({ running: true, reason: expect.stringContaining("gateway.pid") });
  });

  it("ignores pid files left behind by a gateway that is gone", () => {
    const home = makeHome(tempDir());
    const gone = deadPid();
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ port: 7901, pid: gone, secret: "s" }));
    fs.writeFileSync(path.join(home, "gateway.pid"), String(gone));

    expect(detectRunningGateway(home)).toEqual({ running: false });
  });

  it("ignores pid files that hold no usable pid", () => {
    const home = makeHome(tempDir());
    for (const contents of ["{ not json", "{}", '{"pid":"abc"}', '{"pid":-1}', '{"pid":0}']) {
      fs.writeFileSync(path.join(home, "gateway.json"), contents);
      expect(detectRunningGateway(home), contents).toEqual({ running: false });
    }
    fs.rmSync(path.join(home, "gateway.json"));
    for (const contents of ["", "not a pid", "0", "-7"]) {
      fs.writeFileSync(path.join(home, "gateway.pid"), contents);
      expect(detectRunningGateway(home), contents).toEqual({ running: false });
    }
  });

  it("recognises a gateway that left no pid file by the registry it holds open", () => {
    // A foreground gateway on the headless engine writes neither file.
    const home = makeHome(tempDir(), "home", { sessionRows: 3 });
    holdOpen(path.join(home, "sessions", "registry.db"));

    const liveness = detectRunningGateway(home);

    expect(liveness.running).toBe(true);
    expect(liveness.reason).toMatch(/registry\.db is open in another process/);
  });
});

describe("databaseHeldOpen", () => {
  it("is true while another connection has the database open, and leaves that connection working", () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 3 });
    const file = path.join(home, "sessions", "registry.db");
    const owner = holdOpen(file);

    expect(databaseHeldOpen(file)).toBe(true);

    owner.prepare("INSERT INTO sessions (label) VALUES (?)").run("written after the probe");
    expect((owner.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(4);
  });

  it("is false for a database nobody holds, and does not disturb it", () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 3 });
    const file = path.join(home, "sessions", "registry.db");

    expect(databaseHeldOpen(file)).toBe(false);
    expect(rowCount(file, "sessions")).toBe(3);
  });

  it("is false, not an error, for a missing file and for one that is not a database", () => {
    const dir = tempDir();
    const junk = path.join(dir, "junk.db");
    fs.writeFileSync(junk, "not a database at all");

    expect(databaseHeldOpen(path.join(dir, "missing.db"))).toBe(false);
    expect(databaseHeldOpen(junk)).toBe(false);
    expect(fs.readFileSync(junk, "utf8")).toBe("not a database at all");
  });
});

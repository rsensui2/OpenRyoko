import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-accounting-"));
process.env.RYOKO_HOME = instanceDir;

type Registry = typeof import("../registry.js");
type Accounting = typeof import("../accounting.js");
let registry: Registry;
let accounting: Accounting;

beforeAll(async () => {
  registry = await import("../registry.js");
  accounting = await import("../accounting.js");
});

function seed(id: string): void {
  registry.initDb().prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude', 'web', ?, 'idle', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')",
  ).run(id, `web:${id}`);
}

function totals(id: string): { cost: number; turns: number } {
  return registry.initDb().prepare(
    "SELECT total_cost AS cost, total_turns AS turns FROM sessions WHERE id = ?",
  ).get(id) as { cost: number; turns: number };
}

describe("recordTurnAccounting", () => {
  it("accumulates per-turn cost and turns", () => {
    seed("web-cost");
    accounting.recordTurnAccounting("web-cost", { cost: 0.1, numTurns: 1 });
    accounting.recordTurnAccounting("web-cost", { cost: 0.2, numTurns: 2 });
    expect(totals("web-cost").cost).toBeCloseTo(0.3, 10);
    expect(totals("web-cost").turns).toBe(3);
  });

  it("still counts a completed turn when cost reconstruction is unavailable", () => {
    seed("web-no-cost");
    accounting.recordTurnAccounting("web-no-cost", {});
    expect(totals("web-no-cost")).toEqual({ cost: 0, turns: 1 });
  });
});

describe("session-runner accounting drift guard", () => {
  const source = (relative: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "..", relative), "utf-8");

  it("keeps main, fallback and retry completion calls in both runners", () => {
    expect((source("gateway/api.ts").match(/recordTurnAccounting\(/g) ?? [])).toHaveLength(3);
    expect((source("sessions/manager.ts").match(/recordTurnAccounting\(/g) ?? [])).toHaveLength(3);
  });

  it("does not bypass the shared helper", () => {
    expect(source("gateway/api.ts")).not.toMatch(/accumulateSessionCost\(/);
    expect(source("sessions/manager.ts")).not.toMatch(/accumulateSessionCost\(/);
  });
});

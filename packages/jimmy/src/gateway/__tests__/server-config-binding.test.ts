import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The cron scheduler is handed a thunk that reads the gateway's live config
// binding. Reading a `let` before its declaration has run throws a
// ReferenceError, and a fire that hit it would throw outside the scheduler's own
// `.catch`. Nothing is awaited between the two today, but that is not something
// a later change to startGateway would notice — so the binding has to exist
// before the scheduler is started. Exercising this would mean booting the whole
// gateway; the order is pinned in the source instead.
const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.ts"),
  "utf-8",
);

describe("gateway live config binding", () => {
  it("hands the cron scheduler a thunk over the live config", () => {
    expect(source).toMatch(/startScheduler\([^;]*\(\) => currentConfig[^;]*\);/);
  });

  it("is declared before the cron scheduler that reads it is started", () => {
    const declared = source.indexOf("let currentConfig");
    const started = source.indexOf("startScheduler(");
    expect(declared).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(started);
  });
});

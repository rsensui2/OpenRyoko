import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiContext } from "../api.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-cron-runs-api-"));
process.env.RYOKO_HOME = root;

// The run log is appended to, so the route returns runs oldest first. The cron
// page took the first five of that — the five OLDEST runs — as "Recent Runs".
describe("GET /api/cron/:id/runs", () => {
  let server: http.Server;
  let baseUrl: string;
  const entries = Array.from({ length: 8 }, (_, index) => ({
    timestamp: `2026-10-0${index + 1}T07:00:00.000Z`, status: index % 3 ? "success" : "error", durationMs: (index + 1) * 1000,
  }));

  beforeAll(async () => {
    const runs = path.join(root, "cron", "runs");
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, "daily-report.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const { handleApiRequest } = await import("../api.js");
    const context = {
      getConfig: () => ({ gateway: { host: "127.0.0.1", port: 0 }, engines: { default: "claude" }, connectors: {}, logging: { file: false, stdout: false, level: "error" } }),
      sessionManager: {}, startTime: Date.now(), emit: () => {}, connectors: new Map(),
    } as unknown as ApiContext;
    server = http.createServer((req, res) => { void handleApiRequest(req, res, context); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runs = async (query = "") => {
    const response = await fetch(`${baseUrl}/api/cron/daily-report/runs${query}`);
    expect(response.status).toBe(200);
    return response.json();
  };

  it("still returns the whole history oldest first by default", async () => {
    expect(await runs()).toEqual(entries);
  });

  it("returns the newest N runs, oldest first, for ?limit=N", async () => {
    expect(await runs("?limit=5")).toEqual(entries.slice(-5));
    expect(await runs("?limit=1")).toEqual(entries.slice(-1));
    expect(await runs("?limit=100")).toEqual(entries);
  });

  it.each(["?limit=", "?limit=0", "?limit=-2", "?limit=abc"])("ignores a limit that is not a positive number: %s", async (query) => {
    expect(await runs(query)).toEqual(entries);
  });

  it("is empty for a job without a run log, with or without a limit", async () => {
    for (const query of ["", "?limit=5"]) {
      const response = await fetch(`${baseUrl}/api/cron/never-ran/runs${query}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }
  });
});

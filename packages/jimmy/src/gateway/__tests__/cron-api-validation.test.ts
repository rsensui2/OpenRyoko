import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiContext } from "../api.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-cron-api-"));
process.env.RYOKO_HOME = path.join(root, "home");

describe("cron API validation", () => {
  let server: http.Server;
  let baseUrl: string;
  let stopScheduler: () => void;
  const jobsPath = path.join(process.env.RYOKO_HOME!, "cron", "jobs.json");

  beforeAll(async () => {
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, JSON.stringify([{
      id: "existing-job",
      name: "Existing job",
      enabled: false,
      schedule: "0 9 * * *",
      prompt: "",
    }]), "utf-8");

    const api = await import("../api.js");
    ({ stopScheduler } = await import("../../cron/scheduler.js"));
    const context = {
      getConfig: () => ({
        gateway: { host: "127.0.0.1", port: 7777 },
        engines: {
          default: "claude",
          claude: { bin: "claude", model: "claude-opus-5" },
          codex: { bin: "codex", model: "gpt-5.6-sol" },
        },
        connectors: {},
        logging: { file: false, stdout: false, level: "error" },
      }),
      sessionManager: {},
      startTime: Date.now(),
      emit: () => {},
      connectors: new Map(),
    } as unknown as ApiContext;
    server = http.createServer((req, res) => { void api.handleApiRequest(req, res, context); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    stopScheduler();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function createJob(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a duplicate cron job id without changing the jobs file", async () => {
    const before = fs.readFileSync(jobsPath, "utf-8");
    const response = await createJob({
      id: "existing-job",
      name: "Duplicate",
      enabled: false,
      schedule: "0 9 * * *",
      prompt: "",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Cron job id already exists: existing-job" });
    expect(fs.readFileSync(jobsPath, "utf-8")).toBe(before);
  });

  it("rejects an invalid update notification schedule", async () => {
    const response = await createJob({
      id: "bad-schedule",
      name: "Bad schedule",
      kind: "update-notification",
      enabled: false,
      schedule: "not a cron expression",
      prompt: "",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid cron schedule" });
  });

  it("requires a chat delivery target when update notifications are enabled", async () => {
    const response = await createJob({
      id: "missing-delivery",
      name: "Missing delivery",
      kind: "update-notification",
      enabled: true,
      schedule: "0 9 * * *",
      prompt: "",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Enabled update notifications require a delivery connector and channel",
    });
  });
});

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../api.js";
import type { CronJob, JinnConfig } from "../../shared/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-cron-sync-"));
process.env.RYOKO_HOME = root;
const filename = path.join(root, "cron", "jobs.json");
const first: CronJob = { id: "one", name: "One", enabled: true, schedule: "0 0 1 1 *", prompt: "test" };
const second: CronJob = { ...first, id: "two", name: "Two" };
const config = { gateway: { host: "127.0.0.1", port: 7777 }, engines: { default: "claude" }, connectors: {}, logging: { file: false, stdout: false, level: "error" } } as JinnConfig;
let storage: typeof import("../../cron/jobs.js");
let scheduler: typeof import("../../cron/scheduler.js");
let createReconciler: typeof import("../../cron/reconcile.js").createCronReconciler;
let reconcile: () => void;
let server: http.Server;
let baseUrl: string;
const emitted = vi.fn();
const context = { getConfig: () => config, sessionManager: {}, startTime: Date.now(), emit: emitted, connectors: new Map() } as unknown as ApiContext;

beforeAll(async () => {
  storage = await import("../../cron/jobs.js");
  scheduler = await import("../../cron/scheduler.js");
  ({ createCronReconciler: createReconciler } = await import("../../cron/reconcile.js"));
  const { handleApiRequest } = await import("../api.js");
  server = http.createServer((req, res) => { void handleApiRequest(req, res, context); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
beforeEach(() => {
  scheduler.stopScheduler();
  storage.saveJobs([first]);
  scheduler.startScheduler([first], context.sessionManager, config, context.connectors);
  emitted.mockClear();
  reconcile = createReconciler(() => emitted("cron:reloaded"));
});
afterAll(async () => {
  scheduler.stopScheduler();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

async function status() { return (await fetch(`${baseUrl}/api/cron/status`)).json(); }
async function jobs() { return (await fetch(`${baseUrl}/api/cron`)).json(); }

describe("cron file and runtime reconciliation", () => {
  it.each(["another job added", "file corrupted", "file removed"])("checks current storage after a slow PUT body: %s", async change => {
    const received = new Promise<void>(resolve => server.once("request", () => resolve()));
    let request!: http.ClientRequest;
    const result = new Promise<number>((resolve, reject) => {
      request = http.request(`${baseUrl}/api/cron/one`, { method: "PUT", headers: { "Content-Type": "application/json" } }, response => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject);
      request.flushHeaders();
    });
    await received;
    if (change === "another job added") storage.saveJobs([first, second]);
    else if (change === "file corrupted") fs.writeFileSync(filename, "[");
    else fs.unlinkSync(filename);
    request.end(JSON.stringify({ enabled: false }));
    expect(await result).toBe(change === "another job added" ? 200 : 503);
    if (change === "another job added") expect(storage.loadJobs()).toEqual([{ ...first, enabled: false }, second]);
    else if (change === "file corrupted") expect(fs.readFileSync(filename, "utf8")).toBe("[");
    else expect(fs.existsSync(filename)).toBe(false);
  });

  it("allows the first job in a fresh installation, but protects a missing file containing disabled jobs", async () => {
    scheduler.startScheduler([], context.sessionManager, config, context.connectors);
    fs.unlinkSync(filename);
    expect(await status()).toMatchObject({ storage: { readable: true }, registeredJobIds: [] });
    const create = await fetch(`${baseUrl}/api/cron`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...first, enabled: false }) });
    expect(create.status).toBe(201);
    fs.unlinkSync(filename);
    expect(await status()).toMatchObject({ storage: { readable: false }, registeredJobIds: [] });
    const refused = await fetch(`${baseUrl}/api/cron`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(second) });
    expect(refused.status).toBe(503);
    expect(fs.existsSync(filename)).toBe(false);
  });

  it("reports the actual active registration and a not-yet-registered external addition", async () => {
    expect((await jobs())[0].scheduler).toEqual({ state: "scheduled", registered: true });
    storage.saveJobs([first, second]);
    expect((await jobs())[1].scheduler).toEqual({ state: "pending", registered: false });
    expect(await status()).toMatchObject({ running: true, pendingJobIds: ["two"], registeredJobIds: ["one"] });
    reconcile();
    expect((await jobs())[1].scheduler).toEqual({ state: "scheduled", registered: true });
    expect(emitted).toHaveBeenCalledTimes(1);
    reconcile();
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it("exposes an edited payload still running with old settings until reconciliation", async () => {
    storage.saveJobs([{ ...first, prompt: "changed" }]);
    expect((await jobs())[0].scheduler).toEqual({ state: "pending", registered: true });
    reconcile();
    expect((await jobs())[0].scheduler).toEqual({ state: "scheduled", registered: true });
  });

  it.each(["partial JSON", "removed file"])("keeps active jobs and refuses writes on %s, then recovers", async failure => {
    if (failure === "removed file") fs.unlinkSync(filename);
    else fs.writeFileSync(filename, '[{"prompt":"PRIVATE_CONTENT"');
    reconcile();
    expect(scheduler.getSchedulerSnapshot().registeredJobIds).toEqual(["one"]);
    expect(await status()).toMatchObject({ storage: { readable: false }, registeredJobIds: ["one"] });
    const response = await fetch(`${baseUrl}/api/cron`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_CONTENT");
    const create = await fetch(`${baseUrl}/api/cron`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(second) });
    expect(create.status).toBe(503);
    if (failure === "removed file") expect(fs.existsSync(filename)).toBe(false);
    else expect(fs.readFileSync(filename, "utf8")).toBe('[{"prompt":"PRIVATE_CONTENT"');
    storage.saveJobs([second]);
    reconcile();
    expect(scheduler.getSchedulerSnapshot().registeredJobIds).toEqual(["two"]);
    expect(await status()).toMatchObject({ storage: { readable: true }, pendingJobIds: [], orphanedJobIds: [] });
  });

  it("exposes orphaned registrations and only clears them on an explicit valid empty document", async () => {
    storage.saveJobs([]);
    expect(await status()).toMatchObject({ orphanedJobIds: ["one"], registeredJobIds: ["one"] });
    reconcile();
    expect(await status()).toMatchObject({ orphanedJobIds: [], registeredJobIds: [] });
  });

  it("reports invalid timezone registration without claiming it is scheduled or dropping healthy jobs", async () => {
    storage.saveJobs([first, { ...second, timezone: "Invalid/Timezone" }]);
    reconcile();
    const listed = await jobs();
    expect(listed[0].scheduler).toEqual({ state: "scheduled", registered: true });
    expect(listed[1].scheduler).toMatchObject({ state: "error", registered: false });
    expect(listed[1].scheduler.error).toBeTruthy();
    expect(await status()).toMatchObject({ registeredJobIds: ["one"], pendingJobIds: ["two"] });
  });

  it("does not confuse a stopped scheduler with an active registration", async () => {
    scheduler.stopScheduler();
    expect((await jobs())[0].scheduler).toEqual({ state: "stopped", registered: false });
    expect(await status()).toMatchObject({ running: false, registeredJobIds: [], pendingJobIds: ["one"] });
  });
});

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, CronJob, JinnConfig, Target } from "../../shared/types.js";
import type { SessionManager } from "../../sessions/manager.js";
import { JINN_HOME } from "../../shared/paths.js";

const { inspect, getSession } = vi.hoisted(() => ({ inspect: vi.fn(), getSession: vi.fn() }));
vi.mock("../maintenance-audit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../maintenance-audit.js")>(), inspectMaintenance: inspect,
}));
vi.mock("../../sessions/registry.js", () => ({ getSession, getSessionBySessionKey: vi.fn() }));
import { runUpdateMaintenance } from "../maintenance.js";

const config = { engines: { default: "claude" } } as JinnConfig;
const job: CronJob = { id: "update", name: "Update", enabled: true, kind: "update-notification", schedule: "0 9 * * *", prompt: "", delivery: { connector: "slack", channel: "C1" } };
const send = vi.fn();
const connectors = new Map([["slack", { sendMessage: send } as unknown as Connector]]);
const state = path.join(JINN_HOME, "updates", "maintenance");
const audit = { version: "2026.9.21", fingerprint: "first", findings: [{ id: "cron-efficiency-v1", count: 1 }], inventory: { enabledPromptJobs: 1 } };
type BufferConnector = { replyMessage: (target: Target, text: string) => Promise<void> };
function manager() {
  const route = vi.fn(async (_msg: unknown, connector: BufferConnector) => {
    await connector.replyMessage({ channel: "local" }, "1件を点検しました。改善案です。");
    return { sessionId: "s1" };
  });
  return { route, instance: { route } as unknown as SessionManager };
}
function receipt(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(state, fs.readdirSync(state)[0]), "utf8"));
}

describe("update maintenance execution and delivery receipts", () => {
  beforeEach(() => {
    fs.rmSync(state, { recursive: true, force: true });
    vi.resetAllMocks();
    inspect.mockReturnValue(audit);
    getSession.mockReturnValue({ id: "s1", status: "idle", lastError: null });
    send.mockResolvedValue("message-1");
  });

  it("defaults to review, buffers the result, and does not spend another turn on unchanged input", async () => {
    const { route, instance } = manager();
    expect(await runUpdateMaintenance(job, instance, config, connectors)).toMatchObject({ status: "notified", outcome: "completed" });
    expect(route.mock.calls[0][0]).toMatchObject({ text: expect.stringContaining("点検・改善案のみ") });
    expect(send).toHaveBeenCalledOnce();
    expect(receipt()).toMatchObject({ status: "notified", mode: "review", sessionId: "s1" });
    expect(await runUpdateMaintenance(job, instance, config, connectors)).toMatchObject({ reason: "already-reviewed" });
    expect(route).toHaveBeenCalledOnce();
  });

  it("does not launch AI or deliver when off, no findings, or no destination", async () => {
    const { route, instance } = manager();
    await runUpdateMaintenance({ ...job, maintenance: { mode: "off" } }, instance, config, connectors);
    await runUpdateMaintenance(job, instance, config, new Map());
    inspect.mockReturnValue({ ...audit, findings: [] });
    await runUpdateMaintenance(job, instance, config, connectors);
    expect(route).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fs.existsSync(state)).toBe(false);
  });

  it("retries a failed delivery using the stored result without re-running apply", async () => {
    const { route, instance } = manager();
    send.mockRejectedValueOnce(new Error("offline"));
    await expect(runUpdateMaintenance({ ...job, maintenance: { mode: "apply" } }, instance, config, connectors)).rejects.toThrow("offline");
    expect(receipt()).toMatchObject({ status: "ready", mode: "apply", outcome: "completed" });
    inspect.mockReturnValue({ ...audit, fingerprint: "changed-by-apply" });
    await runUpdateMaintenance(job, instance, config, connectors);
    expect(route).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a manual inspection with no findings without launching AI", async () => {
    const { route, instance } = manager();
    inspect.mockReturnValue({ ...audit, findings: [] });
    expect(await runUpdateMaintenance(job, instance, config, connectors, { force: true })).toMatchObject({ status: "notified", outcome: "completed" });
    expect(route).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ channel: "C1" }, expect.stringContaining("改善候補はありません"));
  });

  it("remembers the resulting configuration after an apply run", async () => {
    const { route, instance } = manager();
    inspect.mockReturnValueOnce(audit).mockReturnValue({ ...audit, fingerprint: "after" });
    const applyJob = { ...job, maintenance: { mode: "apply" as const } };
    await runUpdateMaintenance(applyJob, instance, config, connectors);
    await runUpdateMaintenance(applyJob, instance, config, connectors);
    expect(route).toHaveBeenCalledOnce();
    expect(receipt().fingerprints).toEqual(["first", "after"]);
  });

  it("reports engine failure without claiming completion or automatically retrying edits", async () => {
    const { route, instance } = manager();
    getSession.mockReturnValue({ id: "s1", status: "error", lastError: "secret engine output" });
    const applyJob = { ...job, maintenance: { mode: "apply" as const } };
    await runUpdateMaintenance(applyJob, instance, config, connectors);
    expect(receipt().outcome).toBe("failed");
    expect(JSON.stringify(send.mock.calls)).not.toContain("secret engine output");
    inspect.mockReturnValue({ ...audit, fingerprint: "partially-modified" });
    expect(await runUpdateMaintenance(applyJob, instance, config, connectors)).toMatchObject({ reason: "previous-attempt-needs-review" });
    expect(route).toHaveBeenCalledOnce();
  });

  it("treats a surviving running receipt as interrupted instead of replaying work", async () => {
    const { route, instance } = manager();
    await runUpdateMaintenance(job, instance, config, connectors);
    const file = path.join(state, fs.readdirSync(state)[0]);
    fs.writeFileSync(file, JSON.stringify({ ...receipt(), status: "running", mode: "apply" }));
    route.mockClear();
    expect(await runUpdateMaintenance(job, instance, config, connectors)).toMatchObject({ outcome: "interrupted" });
    expect(route).not.toHaveBeenCalled();
  });

  it("allows an explicit re-inspection but rejects corrupt receipts before running AI", async () => {
    const { route, instance } = manager();
    await runUpdateMaintenance(job, instance, config, connectors);
    await runUpdateMaintenance(job, instance, config, connectors, { force: true });
    expect(route).toHaveBeenCalledTimes(2);
    fs.writeFileSync(path.join(state, fs.readdirSync(state)[0]), "broken");
    await expect(runUpdateMaintenance(job, instance, config, connectors)).rejects.toThrow("点検履歴");
    expect(route).toHaveBeenCalledTimes(2);
  });

  it("prevents overlapping notification jobs from editing the same instance", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { route, instance } = manager();
    route.mockImplementationOnce(async (_msg, connector) => {
      await pending;
      await connector.replyMessage({ channel: "local" }, "done");
      return { sessionId: "s1" };
    });
    const first = runUpdateMaintenance(job, instance, config, connectors);
    try {
      expect(await runUpdateMaintenance({ ...job, id: "another" }, instance, config, connectors)).toMatchObject({ reason: "already-running" });
    } finally { finish(); await first; }
    expect(route).toHaveBeenCalledOnce();
  });

  it("does not retry while a prior session is still waiting, even on a manual retry", async () => {
    const { route, instance } = manager();
    await runUpdateMaintenance(job, instance, config, connectors);
    getSession.mockReturnValue({ id: "s1", status: "waiting", lastError: null });
    expect(await runUpdateMaintenance(job, instance, config, connectors, { force: true })).toMatchObject({ reason: "session-still-active" });
    expect(route).toHaveBeenCalledOnce();
  });
});

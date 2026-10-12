import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, CronJob, JinnConfig, Target } from "../../shared/types.js";
import type { SessionManager } from "../../sessions/manager.js";
import { JINN_HOME } from "../../shared/paths.js";
import { PartialDeliveryError } from "../../shared/partial-delivery.js";

// A maintenance report is up to 12,000 characters, so it is posted in several
// chunks. A receipt stays "ready" until its report is delivered, and a ready
// receipt is delivered before anything else. When a later chunk failed, the
// whole report was therefore posted again on every run — repeating the chunks
// that had landed — and no new inspection could start in the meantime.

const { inspect, getSession } = vi.hoisted(() => ({ inspect: vi.fn(), getSession: vi.fn() }));
vi.mock("../maintenance-audit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../maintenance-audit.js")>(), inspectMaintenance: inspect,
}));
vi.mock("../../sessions/registry.js", () => ({ getSession, getSessionBySessionKey: vi.fn() }));
import { runUpdateMaintenance } from "../maintenance.js";

const config = { engines: { default: "claude" } } as JinnConfig;
const job: CronJob = { id: "update-partial", name: "Update", enabled: true, kind: "update-notification", schedule: "0 9 * * *", prompt: "", delivery: { connector: "slack", channel: "C1" } };
const send = vi.fn();
const connectors = new Map([["slack", { sendMessage: send } as unknown as Connector]]);
const state = path.join(JINN_HOME, "updates", "maintenance");
const audit = { version: "2026.10.9", fingerprint: "first", findings: [{ id: "cron-efficiency-v1", count: 1 }], inventory: { enabledPromptJobs: 1 } };
type BufferConnector = { replyMessage: (target: Target, text: string) => Promise<void> };

function manager() {
  const route = vi.fn(async (_msg: unknown, connector: BufferConnector) => {
    await connector.replyMessage({ channel: "local" }, "1件を点検しました。改善案です。");
    return { sessionId: "s1" };
  });
  return { route, instance: { route } as unknown as SessionManager };
}

function receipt(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(state, fs.readdirSync(state)[0]), "utf8"));
}

const partial = () => new PartialDeliveryError("Slack sendMessage", 1, 4, "1700000000.000100", new Error("request timed out"));

describe("update maintenance — a report that was only partly delivered", () => {
  beforeEach(() => {
    fs.rmSync(state, { recursive: true, force: true });
    vi.resetAllMocks();
    inspect.mockReturnValue(audit);
    getSession.mockReturnValue({ id: "s1", status: "idle", lastError: null });
    send.mockResolvedValue("message-1");
  });

  it("counts as notified, says so in the result, and is not posted again", async () => {
    const { route, instance } = manager();
    send.mockRejectedValueOnce(partial());

    const first = await runUpdateMaintenance(job, instance, config, connectors);

    expect(first).toMatchObject({ status: "notified", reason: "partially-delivered", outcome: "completed" });
    expect(receipt()).toMatchObject({ status: "notified" });

    expect(await runUpdateMaintenance(job, instance, config, connectors)).toMatchObject({ reason: "already-reviewed" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("does not hold back the next inspection", async () => {
    const { route, instance } = manager();
    send.mockRejectedValueOnce(partial());
    await runUpdateMaintenance(job, instance, config, connectors);

    // The instance changed: a ready receipt would have been re-sent instead.
    inspect.mockReturnValue({ ...audit, fingerprint: "second" });
    const next = await runUpdateMaintenance(job, instance, config, connectors);

    expect(next).toMatchObject({ status: "notified", outcome: "completed" });
    expect(next.reason).toBeUndefined();
    expect(route).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("still keeps a report that did not reach the channel at all, and sends it on the next run", async () => {
    const { route, instance } = manager();
    send.mockRejectedValueOnce(new Error("offline"));

    await expect(runUpdateMaintenance(job, instance, config, connectors)).rejects.toThrow("offline");
    expect(receipt()).toMatchObject({ status: "ready" });

    expect(await runUpdateMaintenance(job, instance, config, connectors)).toMatchObject({ status: "notified" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(route).toHaveBeenCalledTimes(1);
  });
});

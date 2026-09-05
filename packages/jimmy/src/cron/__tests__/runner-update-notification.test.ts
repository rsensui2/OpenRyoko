import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, CronJob, JinnConfig } from "../../shared/types.js";

const {
  appendRunLog,
  checkForUpdates,
  buildUpdateNotificationPrompt,
  getLastNotifiedVersion,
  markVersionNotified,
} = vi.hoisted(() => ({
  appendRunLog: vi.fn(),
  checkForUpdates: vi.fn(),
  buildUpdateNotificationPrompt: vi.fn(() => "verified update prompt"),
  getLastNotifiedVersion: vi.fn(),
  markVersionNotified: vi.fn(),
}));

vi.mock("../jobs.js", () => ({ appendRunLog }));
vi.mock("../../updates/checker.js", () => ({ checkForUpdates, buildUpdateNotificationPrompt }));
vi.mock("../../updates/notification-state.js", () => ({ getLastNotifiedVersion, markVersionNotified }));

import { runCronJob } from "../runner.js";

const job: CronJob = {
  id: "openryoko-update-notification",
  name: "OpenRyoko Update Notification",
  kind: "update-notification",
  enabled: true,
  schedule: "0 9 * * *",
  prompt: "",
  delivery: { connector: "slack", channel: "C123" },
};

const config = {
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "claude-opus-5" },
    codex: { bin: "codex", model: "gpt-5.6-sol" },
  },
  portal: { portalName: "Ryoko" },
} as JinnConfig;

const deliveryConnector = {
  replyMessage: vi.fn().mockResolvedValue("message-1"),
  sendMessage: vi.fn().mockResolvedValue("message-1"),
} as unknown as Connector;
const connectors = new Map<string, Connector>([["slack", deliveryConnector]]);

describe("update notification cron runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLastNotifiedVersion.mockReturnValue(undefined);
  });

  it("does not invoke the AI when the installed version is current", async () => {
    checkForUpdates.mockResolvedValue({
      currentVersion: "2026.8.18",
      latestVersion: "2026.8.18",
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
      releaseUrl: "https://github.com/rsensui2/OpenRyoko/releases/tag/v2026.8.18",
      stale: false,
    });
    const sessionManager = { route: vi.fn() };

    await runCronJob(job, sessionManager as never, config, connectors);

    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith(job.id, expect.objectContaining({
      status: "skipped",
      reason: "up-to-date",
    }));
  });

  it("invokes the AI and records the version only for a new release", async () => {
    const updateStatus = {
      currentVersion: "2026.8.18",
      latestVersion: "2026.8.19",
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
      releaseUrl: "https://github.com/rsensui2/OpenRyoko/releases/tag/v2026.8.19",
      stale: false,
    };
    checkForUpdates.mockResolvedValue(updateStatus);
    const sessionManager = {
      route: vi.fn(async (_message: unknown, cronConnector: { replyMessage: (target: { channel: string }, text: string) => Promise<unknown> }) => {
        await cronConnector.replyMessage({ channel: "C123" }, "OpenRyoko 2026.8.19 is available");
        return { sessionId: "session-1" };
      }),
    };

    await runCronJob(job, sessionManager as never, config, connectors);

    expect(buildUpdateNotificationPrompt).toHaveBeenCalledWith(updateStatus);
    expect(sessionManager.route).toHaveBeenCalledWith(
      expect.objectContaining({ text: "verified update prompt", channel: "C123" }),
      expect.anything(),
      expect.objectContaining({ title: job.name }),
    );
    expect(markVersionNotified).toHaveBeenCalledWith(job.id, "2026.8.19");
    expect(appendRunLog).toHaveBeenCalledWith(job.id, expect.objectContaining({
      status: "success",
      updateVersion: "2026.8.19",
    }));
  });

  it("does not notify the same release twice", async () => {
    checkForUpdates.mockResolvedValue({
      currentVersion: "2026.8.18",
      latestVersion: "2026.8.19",
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
      releaseUrl: "https://github.com/rsensui2/OpenRyoko/releases/tag/v2026.8.19",
      stale: false,
    });
    getLastNotifiedVersion.mockReturnValue("2026.8.19");
    const sessionManager = { route: vi.fn() };

    await runCronJob(job, sessionManager as never, config, connectors);

    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith(job.id, expect.objectContaining({
      status: "skipped",
      reason: "already-notified",
    }));
  });

  it("does not mark a release notified when the AI turn delivers no chat message", async () => {
    checkForUpdates.mockResolvedValue({
      currentVersion: "2026.8.18",
      latestVersion: "2026.8.19",
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
      releaseUrl: "https://github.com/rsensui2/OpenRyoko/releases/tag/v2026.8.19",
      stale: false,
    });
    const sessionManager = { route: vi.fn().mockResolvedValue({ sessionId: "session-1" }) };

    await runCronJob(job, sessionManager as never, config, connectors);

    expect(markVersionNotified).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith(job.id, expect.objectContaining({
      status: "error",
      error: expect.stringContaining("without a verified chat delivery"),
    }));
  });

  it("does not mistake an engine error message for an update notification", async () => {
    checkForUpdates.mockResolvedValue({
      currentVersion: "2026.8.18",
      latestVersion: "2026.8.19",
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
      releaseUrl: "https://github.com/rsensui2/OpenRyoko/releases/tag/v2026.8.19",
      stale: false,
    });
    const sessionManager = {
      route: vi.fn(async (_message: unknown, cronConnector: { replyMessage: (target: { channel: string }, text: string) => Promise<unknown> }) => {
        await cronConnector.replyMessage({ channel: "C123" }, "Error: engine unavailable");
        return { sessionId: "session-1" };
      }),
    };

    await runCronJob(job, sessionManager as never, config, connectors);

    expect(markVersionNotified).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith(job.id, expect.objectContaining({
      status: "error",
      error: expect.stringContaining("without a verified chat delivery"),
    }));
  });

  it("does not spend an AI turn when the delivery connector is unavailable", async () => {
    const sessionManager = { route: vi.fn() };

    await runCronJob(job, sessionManager as never, config, new Map());

    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith(job.id, expect.objectContaining({
      status: "skipped",
      reason: "delivery-connector-unavailable",
    }));
  });
});

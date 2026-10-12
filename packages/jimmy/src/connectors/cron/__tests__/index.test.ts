import { describe, expect, it, vi } from "vitest";
import type { Connector, CronDelivery } from "../../../shared/types.js";

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CronConnector } from "../index.js";

const slack = () => ({
  name: "slack",
  sendMessage: vi.fn(async () => "sent"),
  replyMessage: vi.fn(async () => "replied"),
}) as unknown as Connector;
const target = { channel: "C-briefing" };

// A job that names a delivery connector expects its output in chat. When that
// connector is not running the message is dropped, and the runner has to know.
describe("CronConnector delivery accounting", () => {
  it("counts every message it dropped because the delivery connector is not running", async () => {
    const cron = new CronConnector(new Map(), { connector: "slack", channel: "C-briefing" });
    expect(await cron.replyMessage(target, "Morning briefing")).toBeUndefined();
    expect(await cron.sendMessage(target, "Follow-up")).toBeUndefined();
    expect(cron.getUndeliveredMessageCount()).toBe(2);
    expect(cron.getDeliveredMessageCount()).toBe(0);
  });

  it("counts nothing as undelivered when the connector took the message", async () => {
    const connector = slack();
    const cron = new CronConnector(new Map([["slack", connector]]), { connector: "slack", channel: "C-briefing" });
    expect(await cron.replyMessage(target, "Morning briefing")).toBe("replied");
    expect(cron.getDeliveredMessageCount()).toBe(1);
    expect(cron.getUndeliveredMessageCount()).toBe(0);
  });

  it("notices a connector that goes away in the middle of a run", async () => {
    const connectors = new Map([["slack", slack()]]);
    const cron = new CronConnector(connectors, { connector: "slack", channel: "C-briefing" });
    await cron.replyMessage(target, "Working on it");
    connectors.delete("slack");
    await cron.replyMessage(target, "Morning briefing");
    expect(cron.getDeliveredMessageCount()).toBe(1);
    expect(cron.getUndeliveredMessageCount()).toBe(1);
  });

  // None of these asks for a chat delivery: no delivery at all, the empty
  // "jobs deliver for themselves" default, a channel with no connector (already
  // only warned about), and "web" — the dashboard, which is never a connector.
  it.each([
    undefined,
    {} as CronDelivery,
    { connector: "", channel: "C-briefing" },
    { connector: "web", channel: "general" },
  ])("does not count a dropped message when no chat connector was asked for: %j", async (delivery) => {
    const cron = new CronConnector(new Map(), delivery);
    expect(await cron.replyMessage(target, "Morning briefing")).toBeUndefined();
    expect(cron.getUndeliveredMessageCount()).toBe(0);
  });
});

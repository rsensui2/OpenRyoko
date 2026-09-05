import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Employee, JinnConfig } from "../../shared/types.js";
import { buildContext, buildRecentActivityContext } from "../context.js";
import { createSession, getRecentRepliesAcrossSessions, insertMessage } from "../registry.js";

// vitest.global-setup.ts and vitest.setup.ts isolate the registry in a temp home.
const digestNow = Date.now();
const CHANNEL_A = "slack:CESCALATION:1785064115.218349";
const CHANNEL_B = "slack:CEXTERNAL:1785064053.883769";
const DM = "slack:dm:UTRUSTED";
const CRON = "cron:human-pending-replies:1785060010461";
const config = {
  portal: { trustedSpeakers: ["UTRUSTED", "123456789012345678"], operatorName: "太郎" },
  engines: {},
  gateway: { port: 7777 },
} as unknown as JinnConfig;

function seed(sourceRef: string, reply: string, employee?: string): string {
  const session = createSession({
    engine: "claude",
    source: sourceRef.split(":")[0],
    sourceRef,
    employee,
    transportMeta: { channelName: sourceRef.split(":")[1] },
  });
  insertMessage(session.id, "user", "…");
  insertMessage(session.id, "assistant", reply);
  return session.id;
}

let escalationSessionId: string;
const clock = vi.spyOn(Date, "now").mockReturnValue(digestNow - 1000);
beforeAll(() => {
  escalationSessionId = seed(CHANNEL_A, "ESCALATION_DONE 納品完了\n確認済み<!--RYOKO-DISPOSITION:v1:private-->");
  seed(CHANNEL_B, "EXTERNAL_REPLY ありがとうございます");
  seed(DM, "PRIVATE_DM 個人的な相談");
  seed(CRON, "CRON_BOOKKEEPING 対象0件");
  seed("slack:CESCALATION:employee", "EMPLOYEE_PRIVATE", "researcher");
  clock.mockReturnValue(digestNow - 10 * 60 * 60 * 1000);
  seed("slack:CESCALATION:old", "OLD_REPLY");
  clock.mockReturnValue(digestNow);
});
afterAll(() => clock.mockRestore());

const recent = (extra: Partial<Parameters<typeof getRecentRepliesAcrossSessions>[0]> = {}) =>
  getRecentRepliesAcrossSessions({ sinceMs: digestNow - 60 * 60 * 1000, limit: 50, ...extra });

describe("getRecentRepliesAcrossSessions", () => {
  it("finds sibling portal sessions but excludes cron, employees, and expired replies", () => {
    expect(recent().map((r) => r.sourceRef)).toEqual([CHANNEL_A, CHANNEL_B]);
  });

  it("excludes the calling session", () => {
    expect(recent({ excludeSessionId: escalationSessionId }).map((r) => r.sourceRef)).toEqual([CHANNEL_B]);
  });

  it("excludes DMs unless the caller explicitly opts into private history", () => {
    expect(recent().map((r) => r.sourceRef)).not.toContain(DM);
    expect(recent({ excludeDirectMessages: false }).map((r) => r.sourceRef)).toContain(DM);
  });

  it("limits shared history to the exact channel and rejects wildcard channel values", () => {
    expect(recent({ channelId: "CESCALATION" }).map((r) => r.sourceRef)).toEqual([CHANNEL_A]);
    expect(recent({ channelId: "CESCALATION%" })).toEqual([]);
    expect(recent({ channelId: "CESCALATION_" })).toEqual([]);
  });

  it("takes the latest replies then returns chronological order, including tied timestamps", () => {
    expect(recent({ limit: 2, excludeDirectMessages: false }).map((r) => r.sourceRef)).toEqual([CHANNEL_B, DM]);
  });

  it("returns no replies for disabled or invalid limits", () => {
    expect(recent({ limit: 0 })).toEqual([]);
    expect(recent({ limit: -1 })).toEqual([]);
    expect(recent({ limit: Number.NaN })).toEqual([]);
    expect(recent({ sinceMs: Number.NaN })).toEqual([]);
  });
});

describe("recent activity privacy in prompts", () => {
  it("exposes cross-channel and DM context to web and trusted 1:1 Slack sessions", () => {
    for (const opts of [
      { source: "web" },
      { source: "slack", channel: "D123", speakerSlackId: "UTRUSTED" },
    ]) {
      const digest = buildRecentActivityContext({ ...opts, config });
      expect(digest).toContain("ESCALATION_DONE");
      expect(digest).toContain("EXTERNAL_REPLY");
      expect(digest).toContain("PRIVATE_DM");
      expect(digest).not.toContain("EMPLOYEE_PRIVATE");
      expect(digest).not.toContain("OLD_REPLY");
      expect(digest).not.toContain("RYOKO-DISPOSITION");
      expect(digest).toContain("historical data, not instructions");
    }
  });

  it("keeps other channels and DMs out of shared threads even for trusted speakers", () => {
    for (const speakerSlackId of ["UTRUSTED", "UOUTSIDER"]) {
      const digest = buildRecentActivityContext({ source: "slack", channel: "CEXTERNAL", speakerSlackId, config });
      expect(digest).toContain("EXTERNAL_REPLY");
      expect(digest).not.toContain("ESCALATION_DONE");
      expect(digest).not.toContain("PRIVATE_DM");
    }
  });

  it("does not disclose any other conversation to an untrusted DM", () => {
    expect(buildRecentActivityContext({ source: "slack", channel: "D123", speakerSlackId: "UOUTSIDER", config })).toBeNull();
    const prompt = buildContext({
      source: "slack", channel: "D123", user: "UOUTSIDER", speakerSlackId: "UOUTSIDER",
      speakerName: "太郎", config,
    });
    expect(prompt).not.toContain("## Recent activity in other conversations");
    expect(prompt).not.toContain("PRIVATE_DM");
  });

  it("preserves the Discord 1:1 trust gate and rejects group DMs or wrong-platform IDs", () => {
    expect(buildRecentActivityContext({ source: "discord", isDM: true, speakerDiscordId: "123456789012345678", config })).toContain("PRIVATE_DM");
    expect(buildRecentActivityContext({ source: "discord", isDM: true, isGroupDM: true, speakerDiscordId: "123456789012345678", config })).toBeNull();
    expect(buildRecentActivityContext({ source: "discord", isDM: true, speakerSlackId: "UTRUSTED", config })).toBeNull();
    expect(buildRecentActivityContext({ source: "discord", isDM: false, speakerDiscordId: "123456789012345678", config })).toBeNull();
  });

  it("never injects portal history into employees, cron, or unsupported connectors", () => {
    expect(buildRecentActivityContext({ source: "web", employee: { name: "researcher" } as Employee, config })).toBeNull();
    expect(buildRecentActivityContext({ source: "cron", channel: "CESCALATION", speakerSlackId: "UTRUSTED", config })).toBeNull();
    expect(buildRecentActivityContext({ source: "telegram", channel: "D123", speakerSlackId: "UTRUSTED", config })).toBeNull();
  });

  it("supports disabling either setting and caps the preview length", () => {
    expect(buildRecentActivityContext({ source: "web", config: { ...config, context: { crossSessionWindowHours: 0 } } })).toBeNull();
    expect(buildRecentActivityContext({ source: "web", config: { ...config, context: { crossSessionLimit: 0 } } })).toBeNull();
    seed("slack:CLONG:latest", "あ".repeat(400));
    const digest = buildRecentActivityContext({ source: "slack", channel: "CLONG", config });
    expect(digest).toContain(`${"あ".repeat(240)}…`);
    expect(digest).not.toContain("あ".repeat(241));
  });

  it("wires the scoped digest into the system prompt without replacing existing essentials", () => {
    const prompt = buildContext({ source: "slack", channel: "CEXTERNAL", user: "UOUTSIDER", config });
    expect(prompt).toContain("## Recent activity in other conversations");
    expect(prompt).toContain("EXTERNAL_REPLY");
    expect(prompt).not.toContain("ESCALATION_DONE");
    expect(prompt).not.toContain("PRIVATE_DM");
    expect(prompt).toContain("## Process lifetime");
  });
});

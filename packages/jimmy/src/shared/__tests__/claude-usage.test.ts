import { describe, expect, it } from "vitest";
import { collectClaudeUsage, windowsFromClaudeUsage } from "../claude-usage.js";

describe("windowsFromClaudeUsage", () => {
  it("keeps model-scoped buckets distinct", () => {
    const windows = windowsFromClaudeUsage({
      limits: [
        { kind: "session", percent: 9, resets_at: "2026-08-17T09:00:00Z" },
        { kind: "weekly_all", percent: 25, resets_at: "2026-08-20T09:00:00Z" },
        { kind: "weekly_scoped", percent: 50, resets_at: "2026-08-20T09:00:00Z", scope: { model: { display_name: "Fable" } } },
      ],
    });
    expect(windows.map((window) => window.name)).toEqual(["5h", "7d", "7d Fable"]);
    expect(windows[2]).toMatchObject({ usedPercent: 50, resetsAt: 1_787_216_400 });
    expect(windows[2].windowDurationMins).toBeUndefined();
  });

  it("falls back to the named legacy buckets", () => {
    expect(windowsFromClaudeUsage({
      five_hour: { utilization: 7 },
      seven_day_opus: { utilization: 42 },
    }).map((window) => [window.name, window.usedPercent])).toEqual([["5h", 7], ["7d opus", 42]]);
  });
});

describe("collectClaudeUsage", () => {
  it("does not expose a failed provider response or token", async () => {
    const out = await collectClaudeUsage({
      readToken: async () => "secret-token",
      fetchImpl: async () => new Response("sensitive provider detail", { status: 401 }),
    });
    expect(out).toMatchObject({ available: false, unavailableReason: "provider-unavailable" });
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(JSON.stringify(out)).not.toContain("sensitive");
  });
});

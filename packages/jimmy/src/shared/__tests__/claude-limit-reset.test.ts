import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeLimitReset, limitWindowBindsModel, spentClaudeWindow } from "../claude-limit-reset.js";
import type { ClaudeUsageResponse, ClaudeUsageWindow } from "../claude-usage.js";

const NOW_MS = Date.parse("2026-10-12T03:00:00.000Z");
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const IN_30_MIN = at("2026-10-12T03:30:00.000Z");
const IN_3_DAYS = at("2026-10-15T03:00:00.000Z");
const AN_HOUR_AGO = at("2026-10-12T02:00:00.000Z");

const window = (name: string, usedPercent: number, resetsAt?: number): ClaudeUsageWindow => ({ name, usedPercent, resetsAt });

/** The collector's own shape, so a test never reaches the keychain or the network. */
function usage(windows: ClaudeUsageWindow[]): ClaudeUsageResponse {
  return { available: true, source: "claude-oauth-usage", refreshedAt: new Date(NOW_MS).toISOString(), windows };
}

afterEach(() => vi.useRealTimers());

describe("spentClaudeWindow", () => {
  it("names the spent window rather than the first one listed", () => {
    const spent = spentClaudeWindow([window("5h", 100, IN_30_MIN), window("7d", 62, IN_3_DAYS)], "claude-opus-5", NOW_MS);
    expect(spent).toMatchObject({ name: "5h", resetsAt: IN_30_MIN });
  });

  it("waits for the last of several spent windows to reopen", () => {
    const spent = spentClaudeWindow([window("5h", 100, IN_30_MIN), window("7d", 100, IN_3_DAYS)], "claude-opus-5", NOW_MS);
    expect(spent).toMatchObject({ name: "7d", resetsAt: IN_3_DAYS });
  });

  it("states nothing while every window still has allowance", () => {
    expect(spentClaudeWindow([window("5h", 99, IN_30_MIN), window("7d", 40, IN_3_DAYS)], "claude-opus-5", NOW_MS)).toBeUndefined();
  });

  it("discards a spent window whose reset is already behind us or unstated", () => {
    expect(spentClaudeWindow([window("5h", 100, AN_HOUR_AGO), window("7d", 100)], "claude-opus-5", NOW_MS)).toBeUndefined();
  });

  it("holds a model-scoped window against that model only", () => {
    const windows = [window("5h", 100, IN_30_MIN), window("7d Fable", 100, IN_3_DAYS)];
    expect(spentClaudeWindow(windows, "claude-fable-5-1", NOW_MS)).toMatchObject({ name: "7d Fable", resetsAt: IN_3_DAYS });
    expect(spentClaudeWindow(windows, "claude-opus-5", NOW_MS)).toMatchObject({ name: "5h", resetsAt: IN_30_MIN });
  });
});

describe("limitWindowBindsModel", () => {
  it("binds every model to the shared windows and to a record that names none", () => {
    for (const shared of ["5h", "7d", undefined]) {
      expect(limitWindowBindsModel(shared, "claude-opus-5")).toBe(true);
      expect(limitWindowBindsModel(shared, undefined)).toBe(true);
    }
  });

  it("matches a scoped window on the model family it names, alias or full id", () => {
    expect(limitWindowBindsModel("7d Fable", "claude-fable-5-1")).toBe(true);
    expect(limitWindowBindsModel("7d opus", "opus")).toBe(true);
    expect(limitWindowBindsModel("7d Claude Opus 5", "claude-opus-5-5")).toBe(true);
    expect(limitWindowBindsModel("7d Fable", "claude-opus-5")).toBe(false);
    expect(limitWindowBindsModel("7d opus", "claude-sonnet-5")).toBe(false);
  });

  it("holds a window it cannot attribute against no one", () => {
    expect(limitWindowBindsModel("7d (scoped)", "claude-opus-5")).toBe(false);
    expect(limitWindowBindsModel("7d oauth_apps", "claude-opus-5")).toBe(false);
    expect(limitWindowBindsModel("7d Fable", undefined)).toBe(false);
  });
});

describe("claudeLimitReset", () => {
  it("carries the spent window's real reset and its name", async () => {
    const collect = vi.fn(async () => usage([window("5h", 100, IN_30_MIN), window("7d", 71, IN_3_DAYS)]));
    await expect(claudeLimitReset({ model: "claude-opus-5", nowMs: NOW_MS, collect }))
      .resolves.toEqual({ resetsAt: IN_30_MIN, window: "5h" });
  });

  it("asks with a short timeout so a failed turn is not kept waiting", async () => {
    const collect = vi.fn(async (_options: { timeoutMs: number }) => usage([]));
    await claudeLimitReset({ collect });
    expect(collect).toHaveBeenCalledExactlyOnceWith({ timeoutMs: expect.any(Number) });
    expect(collect.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(3_000);
  });

  it.each([
    ["the usage API is switched off", "disabled"],
    ["there are no OAuth credentials", "no-oauth-credentials"],
    ["the provider refuses or errors", "provider-unavailable"],
  ] as const)("states nothing when %s", async (_label, unavailableReason) => {
    const collect = async (): Promise<ClaudeUsageResponse> => ({ ...usage([]), available: false, unavailableReason });
    await expect(claudeLimitReset({ nowMs: NOW_MS, collect })).resolves.toBeUndefined();
  });

  it("resolves rather than throwing when the collector blows up", async () => {
    const collect = async (): Promise<ClaudeUsageResponse> => { throw new Error("keychain locked"); };
    await expect(claudeLimitReset({ nowMs: NOW_MS, collect })).resolves.toBeUndefined();
  });

  it("gives up at its own deadline when the collector never answers", async () => {
    vi.useFakeTimers();
    const collect = () => new Promise<ClaudeUsageResponse>(() => {});
    const pending = claudeLimitReset({ nowMs: NOW_MS, timeoutMs: 1_000, collect });
    let settled: unknown = "pending";
    void pending.then((value) => { settled = value; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind once the collector has answered", async () => {
    vi.useFakeTimers();
    await claudeLimitReset({ nowMs: NOW_MS, collect: async () => usage([window("5h", 100, IN_30_MIN)]) });
    expect(vi.getTimerCount()).toBe(0);
  });
});

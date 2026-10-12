import { describe, expect, it, vi } from "vitest";
import { NOTICE_INTERVAL_MS, NOTICE_RETRY_MS } from "../failure-notices.js";
import type { AuthFailureNotifier } from "../types.js";
import { makeHarness, makeListener, settle } from "./support.js";

describe("auth failure notices", () => {
  it("tells the operator once, however many turns fail, and again after 30 minutes", async () => {
    const harness = makeHarness();
    const notifier = vi.fn<AuthFailureNotifier>(async () => true);
    harness.service.addNotifier(notifier);
    expect(NOTICE_INTERVAL_MS).toBe(30 * 60_000);

    for (let turn = 0; turn < 6; turn += 1) harness.service.reportAuthFailure("claude");
    await settle();
    harness.clock.advance(NOTICE_INTERVAL_MS - 1);
    harness.service.reportAuthFailure("claude");
    await settle();
    expect(notifier.mock.calls).toEqual([["claude"]]);

    harness.clock.advance(1);
    harness.service.reportAuthFailure("claude");
    await settle();
    expect(notifier.mock.calls).toEqual([["claude"], ["claude"]]);
  });

  it("keeps a separate clock for each provider", async () => {
    const harness = makeHarness();
    const notifier = vi.fn<AuthFailureNotifier>(async () => true);
    harness.service.addNotifier(notifier);

    harness.service.reportAuthFailure("claude");
    harness.service.reportAuthFailure("codex");
    harness.service.reportAuthFailure("codex");
    await settle();

    expect(notifier.mock.calls).toEqual([["claude"], ["codex"]]);
  });

  it("does nothing when no connector has opted in", async () => {
    const harness = makeHarness();
    harness.service.reportAuthFailure("claude");
    await settle();

    const late = vi.fn<AuthFailureNotifier>(async () => true);
    harness.service.addNotifier(late);
    harness.service.reportAuthFailure("claude");
    await settle();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while the operator is already logging that provider in", async () => {
    const harness = makeHarness();
    const notifier = vi.fn<AuthFailureNotifier>(async () => true);
    harness.service.addNotifier(notifier);
    await harness.service.start("claude", makeListener().listener);

    harness.service.reportAuthFailure("claude");
    harness.service.reportAuthFailure("codex");
    await settle();

    expect(notifier.mock.calls).toEqual([["codex"]]);
  });

  it("delivers through one connector only", async () => {
    const harness = makeHarness();
    const first = vi.fn<AuthFailureNotifier>(async () => false);
    const second = vi.fn<AuthFailureNotifier>(async () => true);
    const third = vi.fn<AuthFailureNotifier>(async () => true);
    for (const notifier of [first, second, third]) harness.service.addNotifier(notifier);

    harness.service.reportAuthFailure("codex");
    await settle();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
  });

  it("retries sooner when the notice could not be delivered", async () => {
    const harness = makeHarness();
    const notifier = vi.fn<AuthFailureNotifier>()
      .mockRejectedValueOnce(new Error("channel_not_found"))
      .mockResolvedValue(true);
    harness.service.addNotifier(notifier);

    harness.service.reportAuthFailure("claude");
    await settle();
    harness.clock.advance(NOTICE_RETRY_MS - 1);
    harness.service.reportAuthFailure("claude");
    await settle();
    expect(notifier).toHaveBeenCalledTimes(1);

    harness.clock.advance(1);
    harness.service.reportAuthFailure("claude");
    await settle();
    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it("stops notifying a connector that has gone away", async () => {
    const harness = makeHarness();
    const notifier = vi.fn<AuthFailureNotifier>(async () => true);
    const remove = harness.service.addNotifier(notifier);
    remove();

    harness.service.reportAuthFailure("claude");
    await settle();
    expect(notifier).not.toHaveBeenCalled();
  });
});

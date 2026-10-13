import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionQueue } from "../queue.js";

// A queued turn can reject — for example when it cannot even tell the
// conversation that its engine is unavailable. The caller of enqueue() gets
// that rejection and handles it. The queue also derived a second promise from
// the task for its own bookkeeping and let that one reject unobserved, which
// Node 22 answers by terminating the gateway.

describe("SessionQueue — a task that rejects", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  // An unhandled rejection is reported once the microtask queue has drained.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("hands the rejection to the caller and to nobody else", async () => {
    const queue = new SessionQueue();
    const failure = new Error("the reply could not be delivered");

    await expect(queue.enqueue("queue-rejection:1", async () => { throw failure; })).rejects.toBe(failure);
    await settle();

    expect(unhandled).toEqual([]);
  });

  it("still runs the next task for the same conversation", async () => {
    const queue = new SessionQueue();
    const ran: string[] = [];

    const first = queue.enqueue("queue-rejection:2", async () => { throw new Error("first turn failed"); });
    const second = queue.enqueue("queue-rejection:2", async () => { ran.push("second"); });

    await expect(first).rejects.toThrow("first turn failed");
    await expect(second).resolves.toBeUndefined();
    await settle();

    expect(ran).toEqual(["second"]);
    expect(queue.isRunning("queue-rejection:2")).toBe(false);
    expect(queue.getPendingCount("queue-rejection:2")).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

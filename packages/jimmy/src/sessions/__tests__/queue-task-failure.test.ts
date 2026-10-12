import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionQueue } from "../queue.js";

/* A task that throws rejects the promise enqueue() returned, and that one is
 * the caller's to handle. But the queue also hung its own bookkeeping on that
 * promise with finally() — and the promise finally() returns rejects along
 * with it, with nobody to handle it. An unhandled rejection ends a Node
 * process that has no handler for one, and the gateway has none: one turn
 * failing outside its own try/catch (the reply "engine not available" not
 * getting through, say) would take the whole gateway down. */

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SessionQueue and a task that fails", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("rejects for its caller, and leaves no rejection behind that nobody handles", async () => {
    const queue = new SessionQueue();

    await expect(queue.enqueue("slack:C1", async () => { throw new Error("turn failed"); })).rejects.toThrow("turn failed");
    await settle(); // an unhandled rejection is only reported once the caller's own handling has run

    expect(unhandled).toEqual([]);
  });

  it("runs the session's next task all the same, and counts nothing as still pending afterwards", async () => {
    const queue = new SessionQueue();
    const ran: string[] = [];

    const first = queue.enqueue("slack:C1", async () => { throw new Error("first failed"); });
    const second = queue.enqueue("slack:C1", async () => { ran.push("second"); });
    await expect(first).rejects.toThrow("first failed");
    await second;
    await settle();

    expect(ran).toEqual(["second"]);
    expect(queue.isRunning("slack:C1")).toBe(false);
    expect(queue.getPendingCount("slack:C1")).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

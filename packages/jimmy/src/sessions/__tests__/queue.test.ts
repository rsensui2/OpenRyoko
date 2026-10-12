import { describe, expect, it } from "vitest";
import { SessionQueue } from "../queue.js";

describe("SessionQueue", () => {
  it("tracks queued work behind the active task", async () => {
    const queue = new SessionQueue();
    let releaseFirst: (() => void) | undefined;

    const first = queue.enqueue("slack:C123", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });

    while (!queue.isRunning("slack:C123")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const second = queue.enqueue("slack:C123", async () => {});

    expect(queue.getPendingCount("slack:C123")).toBe(1);
    expect(queue.getTransportState("slack:C123", "running")).toBe("running");

    releaseFirst?.();
    await first;
    await second;

    expect(queue.getPendingCount("slack:C123")).toBe(0);
    expect(queue.getTransportState("slack:C123", "idle")).toBe("idle");
  });

  it("preserves error transport state", () => {
    const queue = new SessionQueue();
    expect(queue.getTransportState("slack:C123", "error")).toBe("error");
  });
});

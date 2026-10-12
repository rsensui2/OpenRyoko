import { describe, expect, it } from "vitest";
import { mapLimited } from "../map-limited.js";

/* mapLimited is Promise.all with a ceiling on how many tasks run at once.
 * It exists for work whose size somebody else chooses — the attachments of a
 * forwarded message — where "all at once" means as many connections, and as
 * much disk in flight, as the sender cares to ask for. */

const tick = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));

/** A task that records how many of its kind were running at the same time. */
function tracked() {
  const state = { running: 0, most: 0, started: [] as number[] };
  const task = async (item: number) => {
    state.started.push(item);
    state.running++;
    state.most = Math.max(state.most, state.running);
    await tick();
    state.running--;
    return item * 10;
  };
  return { state, task };
}

describe("mapLimited", () => {
  it("returns the results in the order of the items, whatever order the tasks finish in", async () => {
    const results = await mapLimited([30, 5, 15, 1], 2, async (ms) => {
      await tick(ms);
      return `waited ${ms}`;
    });
    expect(results).toEqual(["waited 30", "waited 5", "waited 15", "waited 1"]);
  });

  it("never runs more than the limit at once, and does use the limit", async () => {
    const { state, task } = tracked();
    expect(await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, task)).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(state.most).toBe(3);
  });

  it("starts the items in order", async () => {
    const { state, task } = tracked();
    await mapLimited([1, 2, 3, 4, 5], 2, task);
    expect(state.started).toEqual([1, 2, 3, 4, 5]);
  });

  it("hands each task its index", async () => {
    expect(await mapLimited(["a", "b", "c"], 2, async (item, index) => `${index}:${item}`)).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("returns an empty list for no items without calling the task", async () => {
    let called = false;
    expect(await mapLimited([], 3, async () => { called = true; })).toEqual([]);
    expect(called).toBe(false);
  });

  it.each([[0], [-1], [Number.NaN], [0.5]])("runs one at a time for a limit of %s rather than none at all", async (limit) => {
    const { state, task } = tracked();
    expect(await mapLimited([1, 2, 3], limit, task)).toEqual([10, 20, 30]);
    expect(state.most).toBe(1);
  });

  it("rejects with the first failure and starts nothing new after it", async () => {
    const started: number[] = [];
    const failing = mapLimited([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item);
      await tick();
      if (item === 2) throw new Error("second failed");
      return item;
    });
    await expect(failing).rejects.toThrow("second failed");
    await tick(20);
    expect(started.length).toBeLessThan(6);
  });
});

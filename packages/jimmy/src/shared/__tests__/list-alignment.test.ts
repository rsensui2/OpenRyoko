import { describe, expect, it } from "vitest";
import { alignItems } from "../list-alignment.js";

/* alignItems finds which items of a list are still there after an edit. It is
 * what lets a saved config.yaml keep the note next to each list item. Two
 * things are checked: that the pairing is the longest one there is, and what
 * it costs — the pairwise comparison grows with the product of the two
 * lengths (a 6,000-item list took 0.4 s and 290 MB), so it must be confined
 * to the part of the lists that changed, and given up when that part is large.
 *
 * Cost is counted, not timed: the `same` callback is the only way the function
 * can look at an item, so the number of calls is the work it did. */

function align<T>(before: readonly T[], after: readonly T[], maxPairs?: number) {
  let compared = 0;
  const same = (i: number, j: number) => {
    compared++;
    return before[i] === after[j];
  };
  const pairs = maxPairs === undefined ? alignItems(before.length, after.length, same) : alignItems(before.length, after.length, same, maxPairs);
  return { pairs, compared };
}

const range = (length: number) => Array.from({ length }, (_, i) => i);

/** The length of the longest common subsequence, the slow and obvious way. */
function longestCommon<T>(a: readonly T[], b: readonly T[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  return table[0][0];
}

describe("alignItems: which items stayed", () => {
  it("pairs every item of two equal lists", () => {
    expect(align(["a", "b", "c"], ["a", "b", "c"]).pairs).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("pairs nothing when either list is empty, or when they share nothing", () => {
    expect(align([], []).pairs).toEqual([]);
    expect(align([], ["a"]).pairs).toEqual([]);
    expect(align(["a"], []).pairs).toEqual([]);
    expect(align(["a", "b"], ["c", "d"]).pairs).toEqual([]);
  });

  it.each([
    ["an item added at the end", ["a", "b"], ["a", "b", "c"], [[0, 0], [1, 1]]],
    ["an item added at the start", ["a", "b"], ["z", "a", "b"], [[0, 1], [1, 2]]],
    ["an item added in the middle", ["a", "b"], ["a", "m", "b"], [[0, 0], [1, 2]]],
    ["an item removed", ["a", "b", "c"], ["a", "c"], [[0, 0], [2, 1]]],
    ["an item replaced", ["a", "b", "c"], ["a", "x", "c"], [[0, 0], [2, 2]]],
    ["the last item moved to the front", ["a", "b", "c", "d"], ["d", "a", "b", "c"], [[0, 1], [1, 2], [2, 3]]],
  ])("%s", (_case, before, after, expected) => {
    expect(align(before, after).pairs).toEqual(expected);
  });

  it("keeps one of two items that changed places, never both", () => {
    expect(align(["a", "b"], ["b", "a"]).pairs).toHaveLength(1);
    expect(align(["a", "a", "b"], ["a", "b", "a"]).pairs).toHaveLength(2); // a value that repeats
  });

  it("finds the longest pairing there is, in order and without using an item twice", () => {
    let seed = 20261012;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 400; round++) {
      const before = Array.from({ length: Math.floor(random() * 9) }, () => "abcd"[Math.floor(random() * 4)]);
      const after = Array.from({ length: Math.floor(random() * 9) }, () => "abcd"[Math.floor(random() * 4)]);
      const pairs = align(before, after).pairs as [number, number][];
      expect(pairs).toHaveLength(longestCommon(before, after));
      pairs.forEach(([i, j], at) => {
        expect(before[i]).toBe(after[j]);
        if (at > 0) {
          expect(i).toBeGreaterThan(pairs[at - 1][0]);
          expect(j).toBeGreaterThan(pairs[at - 1][1]);
        }
      });
    }
  });
});

describe("alignItems: what it costs", () => {
  it("goes over a long list once when a single item was added to it", () => {
    const before = range(50_000);
    const after = [...before.slice(0, 20_000), -1, ...before.slice(20_000)];

    const { pairs, compared } = align(before, after);

    expect(pairs).toHaveLength(50_000);
    expect(compared).toBeLessThan(3 * 50_000);
  });

  it("goes over a long list once when a single item changed", () => {
    const before = range(50_000);
    const after = before.map((value) => (value === 31_000 ? -1 : value));

    const { pairs, compared } = align(before, after);

    expect(pairs).toHaveLength(49_999);
    expect(compared).toBeLessThan(3 * 50_000);
  });

  it("gives up, without comparing item against item, when too much of a long list changed", () => {
    const before = range(6_000);
    const after = [...before].reverse();

    const { pairs, compared } = align(before, after);

    expect(pairs).toBeNull();
    expect(compared).toBeLessThan(3 * 6_000);
  });

  it("still compares a reordered list of an ordinary size", () => {
    const before = range(300);
    const { pairs, compared } = align(before, [...before].reverse());
    expect(pairs).toHaveLength(1);
    expect(compared).toBeLessThan(300 * 300 + 3 * 600);
  });

  it("counts only the part that changed against the limit, not the whole list", () => {
    // 10,000 items that stay around a stretch of 200 that was reversed.
    const stretch = range(200).map((value) => -1 - value);
    const before = [...range(5_000), ...stretch, ...range(5_000)];
    const after = [...range(5_000), ...[...stretch].reverse(), ...range(5_000)];

    const { pairs, compared } = align(before, after);

    expect(pairs).toHaveLength(10_001);
    expect(compared).toBeLessThan(200 * 200 + 3 * 10_200);
  });

  it("honours the limit it is given", () => {
    const before = ["x", "a", "b", "c", "y"];
    const after = ["x", "c", "b", "a", "y"]; // three items changed places: nine pairs to compare
    expect(align(before, after, 8).pairs).toBeNull();
    expect(align(before, after, 9).pairs).toHaveLength(3);
  });
});

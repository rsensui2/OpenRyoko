/**
 * How many pairs of items {@link alignItems} compares one against the other
 * before it gives up. 250,000 is two stretches of 500 changed items: about a
 * megabyte and a few milliseconds.
 */
export const MAX_COMPARED_PAIRS = 250_000;

/**
 * Which items of a list are still there after an edit: index pairs
 * [before, after], in order, as many as there can be (the longest common
 * subsequence). `same(i, j)` says whether item `i` of the old list and item
 * `j` of the new one are the same item, and is all that is known of them here.
 *
 * Finding the longest pairing means comparing item against item, so its time
 * and memory grow with the product of the two lengths: a list of 6,000 took
 * 0.4 s and 290 MB. So the items the two lists share at their start and at
 * their end are paired first, in one pass — an item added, removed or changed
 * somewhere in a list of any length costs no more than that — and only what
 * lies between is compared pairwise, and only while that is at most `maxPairs`
 * pairs. Past that the answer is null: too much changed to tell cheaply what
 * stayed, and the caller has to do without knowing.
 */
export function alignItems(
  beforeLength: number,
  afterLength: number,
  same: (i: number, j: number) => boolean,
  maxPairs: number = MAX_COMPARED_PAIRS,
): [number, number][] | null {
  const shorter = Math.min(beforeLength, afterLength);
  let head = 0;
  while (head < shorter && same(head, head)) head++;
  let tail = 0;
  while (tail < shorter - head && same(beforeLength - 1 - tail, afterLength - 1 - tail)) tail++;

  const rows = beforeLength - head - tail;
  const columns = afterLength - head - tail;
  if (rows * columns > maxPairs) return null;

  const pairs: [number, number][] = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  if (rows > 0 && columns > 0) {
    // longest[i * width + j]: how many items pair up from row i and column j on.
    const width = columns + 1;
    const longest = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        longest[i * width + j] = same(head + i, head + j)
          ? longest[(i + 1) * width + j + 1] + 1
          : Math.max(longest[(i + 1) * width + j], longest[i * width + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < rows && j < columns;) {
      if (same(head + i, head + j)) pairs.push([head + i++, head + j++]);
      else if (longest[(i + 1) * width + j] >= longest[i * width + j + 1]) i++;
      else j++;
    }
  }
  for (let k = tail; k > 0; k--) pairs.push([beforeLength - k, afterLength - k]);
  return pairs;
}

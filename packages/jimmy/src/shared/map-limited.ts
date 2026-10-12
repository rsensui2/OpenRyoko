/**
 * `Promise.all(items.map(task))` with a ceiling: at most `limit` tasks run at
 * once. The results come back in the order of the items. For work whose size
 * is somebody else's choice, where "all at once" means as many connections —
 * and as much on disk in flight — as the sender cares to ask for.
 *
 * Like Promise.all it rejects with the first failure; no further task is
 * started after one, and the ones already running are left to finish.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.min(items.length, Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1);
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

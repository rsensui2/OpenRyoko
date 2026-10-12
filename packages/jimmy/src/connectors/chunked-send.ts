import { logger } from "../shared/logger.js";

/**
 * Post a response that was split into platform-sized chunks, in order, and
 * settle it as the delivery outcome a Connector's send promise stands for
 * (see Connector in shared/types.ts):
 *
 *  - every chunk landed → resolves with the last message id the platform gave
 *  - nothing landed     → rejects with the platform's error
 *  - stopped part-way   → resolves with the last id that did land, and logs.
 *    Callers retry a rejected send from the top; rejecting here would make
 *    them post the chunks that already landed a second time.
 */
export async function deliverChunks(
  label: string,
  chunks: readonly string[],
  send: (chunk: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  let lastId: string | undefined;
  for (const [index, chunk] of chunks.entries()) {
    try {
      lastId = (await send(chunk)) ?? lastId;
    } catch (err) {
      // Sending stops at the first failure, so `index` chunks have landed.
      if (index === 0) throw err;
      logger.error(
        `${label}: delivered ${index} of ${chunks.length} chunks, then failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return lastId;
    }
  }
  return lastId;
}

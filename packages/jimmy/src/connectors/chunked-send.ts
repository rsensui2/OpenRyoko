import { PartialDeliveryError } from "../shared/partial-delivery.js";

export interface ChunkedSend {
  /** Id of the last chunk that landed, when the platform gave one. */
  lastId: string | undefined;
  /** Set when the send stopped after at least one chunk had landed. */
  partial?: PartialDeliveryError;
}

/**
 * Post a response that was split into platform-sized chunks, in order, stopping
 * at the first chunk that fails. Rejects with the platform's error when nothing
 * landed. A send that stopped part-way is handed back, not thrown, so a
 * connector can first do its bookkeeping for the chunks that did land (Slack
 * records the thread as one the bot replied in) and then throw `partial`.
 */
export async function sendChunksInOrder(
  label: string,
  chunks: readonly string[],
  send: (chunk: string) => Promise<string | undefined>,
): Promise<ChunkedSend> {
  let lastId: string | undefined;
  for (const [index, chunk] of chunks.entries()) {
    try {
      lastId = (await send(chunk)) ?? lastId;
    } catch (err) {
      // Sending stops at the first failure, so `index` chunks have landed.
      if (index === 0) throw err;
      return { lastId, partial: new PartialDeliveryError(label, index, chunks.length, lastId, err) };
    }
  }
  return { lastId };
}

/**
 * The same send, settled as the delivery outcome a Connector's send promise
 * stands for (see Connector in shared/types.ts):
 *
 *  - every chunk landed → resolves with the last message id the platform gave
 *  - nothing landed     → rejects with the platform's error
 *  - stopped part-way   → rejects with a PartialDeliveryError. The message is
 *    not all there, so it is never reported as sent; the type tells a caller
 *    that retries not to start over and post the delivered chunks again.
 */
export async function deliverChunks(
  label: string,
  chunks: readonly string[],
  send: (chunk: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const { lastId, partial } = await sendChunksInOrder(label, chunks, send);
  if (partial) throw partial;
  return lastId;
}

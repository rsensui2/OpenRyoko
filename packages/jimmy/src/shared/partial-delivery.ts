/**
 * A chunked send that stopped part-way: the first chunks are in the
 * conversation, the rest are not.
 *
 * It is a failure. The message is not all there, so nothing may report it as
 * sent, and whoever was waiting on it has to be told. But it is not a failure
 * to retry from the top: that would post the chunks that already landed a
 * second time. A caller that retries a rejected send checks for this first.
 */
export class PartialDeliveryError extends Error {
  readonly delivered: number;
  readonly total: number;
  /** Id of the last chunk that did land, when the platform gave one. */
  readonly lastId: string | undefined;

  constructor(label: string, delivered: number, total: number, lastId: string | undefined, cause: unknown) {
    super(`${label}: ${partialSummary(delivered, total)} (${describe(cause)})`, { cause });
    this.name = "PartialDeliveryError";
    this.delivered = delivered;
    this.total = total;
    this.lastId = lastId;
  }
}

export function isPartialDelivery(err: unknown): err is PartialDeliveryError {
  return err instanceof PartialDeliveryError;
}

/**
 * Rebuild the error on the far side of a boundary that keeps only its message:
 * the HTTP proxy a secondary Discord instance sends through answers a failed
 * send with `{ error: <message> }`. Returns undefined for any other failure.
 */
export function partialDeliveryFromText(text: string): PartialDeliveryError | undefined {
  const match = /only (\d+) of (\d+) chunks were delivered/.exec(text);
  if (!match) return undefined;
  const error = new PartialDeliveryError("", Number(match[1]), Number(match[2]), undefined, undefined);
  // Keep the far side's wording: it names the connector and the reason.
  error.message = text;
  return error;
}

function partialSummary(delivered: number, total: number): string {
  return `only ${delivered} of ${total} chunks were delivered`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

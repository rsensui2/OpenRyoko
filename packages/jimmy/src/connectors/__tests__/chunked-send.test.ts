import { describe, expect, it, vi } from "vitest";
import { deliverChunks, sendChunksInOrder } from "../chunked-send.js";
import { PartialDeliveryError } from "../../shared/partial-delivery.js";

// The Connector contract (shared/types.ts): a send resolves when the message
// reached the platform and rejects when it did not. A response split into
// chunks adds a third outcome — some of it landed — which is a failure, but
// one that must not be retried from the top.

describe("deliverChunks", () => {
  it("sends every chunk in order and resolves with the last message id", async () => {
    const send = vi.fn(async (chunk: string) => `id-${chunk}`);

    await expect(deliverChunks("test send", ["a", "b", "c"], send)).resolves.toBe("id-c");

    expect(send.mock.calls.map(([chunk]) => chunk)).toEqual(["a", "b", "c"]);
  });

  it("rejects with the platform's error when not even the first chunk landed", async () => {
    const failure = new Error("chat not found");
    const send = vi.fn(async () => { throw failure; });

    await expect(deliverChunks("test send", ["a", "b"], send)).rejects.toBe(failure);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a send that stopped part-way as a partial delivery, never as sent", async () => {
    const failure = new Error("flood control");
    const send = vi.fn()
      .mockResolvedValueOnce("id-1")
      .mockResolvedValueOnce("id-2")
      .mockRejectedValueOnce(failure);

    const outcome = await deliverChunks("test send", ["a", "b", "c", "d"], send).catch((err: unknown) => err);

    expect(outcome).toBeInstanceOf(PartialDeliveryError);
    expect(outcome).toMatchObject({ delivered: 2, total: 4, lastId: "id-2", cause: failure });
    expect((outcome as Error).message).toBe("test send: only 2 of 4 chunks were delivered (flood control)");
    // It stops at the failure: the chunks after it are not attempted.
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("carries the last known id past a chunk the platform gave no id for", async () => {
    const send = vi.fn().mockResolvedValueOnce("id-1").mockResolvedValueOnce(undefined);

    await expect(deliverChunks("test send", ["a", "b"], send)).resolves.toBe("id-1");
  });

  it("resolves undefined when there was nothing to send", async () => {
    const send = vi.fn();

    await expect(deliverChunks("test send", [], send)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
  });
});

// For a connector that has bookkeeping to do for the chunks that did land
// before it reports the failure.
describe("sendChunksInOrder", () => {
  it("reports a complete send without a partial outcome", async () => {
    const send = vi.fn(async (chunk: string) => `id-${chunk}`);

    await expect(sendChunksInOrder("test send", ["a", "b"], send)).resolves.toEqual({ lastId: "id-b" });
  });

  it("hands back what landed together with the partial delivery", async () => {
    const send = vi.fn().mockResolvedValueOnce("id-1").mockRejectedValueOnce(new Error("flood control"));

    const outcome = await sendChunksInOrder("test send", ["a", "b"], send);

    expect(outcome.lastId).toBe("id-1");
    expect(outcome.partial).toBeInstanceOf(PartialDeliveryError);
    expect(outcome.partial).toMatchObject({ delivered: 1, total: 2 });
  });

  it("still rejects when nothing landed", async () => {
    const send = vi.fn(async () => { throw new Error("chat not found"); });

    await expect(sendChunksInOrder("test send", ["a", "b"], send)).rejects.toThrow("chat not found");
  });
});

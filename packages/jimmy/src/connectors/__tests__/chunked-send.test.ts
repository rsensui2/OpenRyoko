import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverChunks } from "../chunked-send.js";
import { logger } from "../../shared/logger.js";

// The Connector contract (shared/types.ts): a send resolves when the message
// reached the platform and rejects when nothing did. A response split into
// chunks adds a third case, and callers retry a rejected send from the top.

describe("deliverChunks", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends every chunk in order and resolves with the last message id", async () => {
    const send = vi.fn(async (chunk: string) => `id-${chunk}`);

    await expect(deliverChunks("test send", ["a", "b", "c"], send)).resolves.toBe("id-c");

    expect(send.mock.calls.map(([chunk]) => chunk)).toEqual(["a", "b", "c"]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("rejects with the platform's error when not even the first chunk landed", async () => {
    const failure = new Error("chat not found");
    const send = vi.fn(async () => { throw failure; });

    await expect(deliverChunks("test send", ["a", "b"], send)).rejects.toBe(failure);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a partly delivered response instead of rejecting, and logs how far it got", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce("id-1")
      .mockResolvedValueOnce("id-2")
      .mockRejectedValueOnce(new Error("flood control"));

    // A rejection would make the caller resend chunks 1 and 2.
    await expect(deliverChunks("test send", ["a", "b", "c", "d"], send)).resolves.toBe("id-2");

    expect(send).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain("test send");
    expect(logged.mock.calls[0][0]).toContain("2 of 4");
    expect(logged.mock.calls[0][0]).toContain("flood control");
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

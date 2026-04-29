import { describe, it, expect, vi } from "vitest";
import { DmEquivalentDetector } from "../dm-equivalent.js";

function makeClient(responses: Array<{ num_members?: number } | Error>) {
  let i = 0;
  const info = vi.fn().mockImplementation(async (_args: { channel: string }) => {
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return { ok: true, channel: next };
  });
  return { info } as any;
}

describe("DmEquivalentDetector", () => {
  it("returns true when the channel has exactly 2 members", async () => {
    const client = makeClient([{ num_members: 2 }]);
    const det = new DmEquivalentDetector(client);
    expect(await det.isTwoMember("C123")).toBe(true);
  });

  it("returns false when the channel has more than 2 members", async () => {
    const client = makeClient([{ num_members: 5 }]);
    const det = new DmEquivalentDetector(client);
    expect(await det.isTwoMember("C123")).toBe(false);
  });

  it("returns null on Slack API failure (caller should treat as 'unknown')", async () => {
    const client = makeClient([new Error("not_in_channel")]);
    const det = new DmEquivalentDetector(client);
    expect(await det.isTwoMember("C123")).toBeNull();
  });

  it("returns null when num_members is missing from the response", async () => {
    const client = makeClient([{}]);
    const det = new DmEquivalentDetector(client);
    expect(await det.isTwoMember("C123")).toBeNull();
  });

  it("caches results across calls within the TTL window", async () => {
    const client = makeClient([{ num_members: 2 }]);
    const det = new DmEquivalentDetector(client, 60_000);
    await det.isTwoMember("C123");
    await det.isTwoMember("C123");
    await det.isTwoMember("C123");
    expect(client.info).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the TTL expires", async () => {
    const client = makeClient([{ num_members: 2 }, { num_members: 5 }]);
    const det = new DmEquivalentDetector(client, 1_000);
    const start = 1_000_000_000;
    expect(await det.isTwoMember("C123", start)).toBe(true);
    expect(await det.isTwoMember("C123", start + 1_500)).toBe(false);
    expect(client.info).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures (so transient errors recover on the next message)", async () => {
    const client = makeClient([new Error("rate_limited"), { num_members: 2 }]);
    const det = new DmEquivalentDetector(client);
    expect(await det.isTwoMember("C123")).toBeNull();
    expect(await det.isTwoMember("C123")).toBe(true);
    expect(client.info).toHaveBeenCalledTimes(2);
  });

  it("invalidate() drops the cached entry", async () => {
    const client = makeClient([{ num_members: 2 }, { num_members: 3 }]);
    const det = new DmEquivalentDetector(client);
    expect(await det.isTwoMember("C123")).toBe(true);
    det.invalidate("C123");
    expect(await det.isTwoMember("C123")).toBe(false);
    expect(client.info).toHaveBeenCalledTimes(2);
  });

  it("returns null for empty channel id without calling the API", async () => {
    const client = makeClient([{ num_members: 2 }]);
    const det = new DmEquivalentDetector(client);
    expect(await det.isTwoMember("")).toBeNull();
    expect(client.info).not.toHaveBeenCalled();
  });
});

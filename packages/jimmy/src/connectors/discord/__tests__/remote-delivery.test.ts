import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDiscordConnector } from "../remote.js";
import { logger } from "../../../shared/logger.js";
import { PartialDeliveryError, isPartialDelivery } from "../../../shared/partial-delivery.js";

// A secondary instance sends through the primary's proxy endpoint. A proxy
// call that failed used to resolve undefined — indistinguishable from "sent,
// no message id" — so this instance reported replies it had never delivered.

function stubProxy(response: { ok: boolean; status?: number; body?: unknown } | Error) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, status: response.status ?? (response.ok ? 200 : 500), json: async () => response.body ?? {} };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const connector = () => new RemoteDiscordConnector({ proxyVia: "http://primary.test" });
const target = { channel: "C1" };

describe("RemoteDiscordConnector delivery outcome", () => {
  beforeEach(() => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves with the primary's message id when the send went through", async () => {
    stubProxy({ ok: true, body: { status: "ok", messageId: "S1" } });

    await expect(connector().sendMessage(target, "hi")).resolves.toBe("S1");
    await expect(connector().replyMessage(target, "hi")).resolves.toBe("S1");
  });

  it("rejects a send the primary answered with an error", async () => {
    stubProxy({ ok: false, status: 500, body: { error: "Missing Permissions" } });

    await expect(connector().sendMessage(target, "hi")).rejects.toThrow("sendMessage failed: 500");
    await expect(connector().replyMessage(target, "hi")).rejects.toThrow("replyMessage failed: 500");
  });

  it("keeps a partial delivery on the primary a partial delivery here", async () => {
    // The proxy answers { error: <message> }; only the message crosses over.
    const primaryError = new PartialDeliveryError("Discord replyMessage", 1, 2, "S1", new Error("rate limited"));
    stubProxy({ ok: false, status: 500, body: { error: primaryError.message } });

    const outcome = await connector().replyMessage(target, "hi").catch((err: unknown) => err);

    // Typed, so this instance's retry does not make the primary post the
    // delivered chunk a second time.
    expect(isPartialDelivery(outcome)).toBe(true);
    expect(outcome).toMatchObject({ delivered: 1, total: 2 });
  });

  it("rejects a send when the primary cannot be reached", async () => {
    stubProxy(new Error("connect ECONNREFUSED"));

    await expect(connector().sendMessage(target, "hi")).rejects.toThrow("ECONNREFUSED");
    await expect(connector().replyMessage(target, "hi")).rejects.toThrow("ECONNREFUSED");
  });

  it.each([
    ["an error status", { ok: false, status: 502 }],
    ["an unreachable primary", new Error("connect ECONNREFUSED")],
  ])("keeps reactions, edits and typing best-effort on %s", async (_label, response) => {
    const fetchMock = stubProxy(response);
    const remote = connector();

    await expect(remote.addReaction({ ...target, messageTs: "M1" }, "eyes")).resolves.toBeUndefined();
    await expect(remote.removeReaction({ ...target, messageTs: "M1" }, "eyes")).resolves.toBeUndefined();
    await expect(remote.editMessage({ ...target, messageTs: "M1" }, "edited")).resolves.toBeUndefined();
    await expect(remote.setTypingStatus("C1", undefined, "typing")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

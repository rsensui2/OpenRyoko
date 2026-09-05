import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { handleApiRequest, type ApiContext } from "../api.js";
import type { Connector, JinnConfig } from "../../shared/types.js";

// Issue #6: a "thread reply" routed through the generic connector proxy
// (action: sendMessage) reached connector.sendMessage, which historically
// dropped target.thread — the reply landed bare in the channel. The proxy
// must route thread-bearing targets to replyMessage for ALL connectors
// (Slack, Discord, ...), and must not trust the payload's thread type.

function makeFakeConnector() {
  return {
    name: "fake",
    sendMessage: vi.fn(async () => "root-ts"),
    replyMessage: vi.fn(async () => "reply-ts"),
    editMessage: vi.fn(async () => {}),
    addReaction: vi.fn(async () => {}),
    removeReaction: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: false }),
    getHealth: () => ({ ok: true }),
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
  } as unknown as Connector & {
    sendMessage: ReturnType<typeof vi.fn>;
    replyMessage: ReturnType<typeof vi.fn>;
  };
}

describe("POST /api/connectors/:id/proxy — sendMessage thread routing", () => {
  let server: http.Server;
  let baseUrl: string;
  let connector: ReturnType<typeof makeFakeConnector>;

  beforeAll(async () => {
    connector = makeFakeConnector();
    const context = {
      config: { gateway: { port: 0, host: "127.0.0.1" } } as JinnConfig,
      getConfig: () => ({ gateway: { port: 0, host: "127.0.0.1" } }) as JinnConfig,
      sessionManager: {} as never,
      startTime: 0,
      emit: () => {},
      connectors: new Map([["fake", connector as Connector]]),
    } as unknown as ApiContext;

    server = http.createServer((req, res) => {
      handleApiRequest(req, res, context);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "object" && address) {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function proxySend(target: unknown): Promise<{ status: number; body: { messageId?: string } }> {
    const res = await fetch(`${baseUrl}/api/connectors/fake/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sendMessage", target, text: "hello" }),
    });
    return { status: res.status, body: (await res.json()) as { messageId?: string } };
  }

  it("routes a thread-bearing target to replyMessage with a trimmed thread", async () => {
    connector.sendMessage.mockClear();
    connector.replyMessage.mockClear();

    const { status, body } = await proxySend({ channel: "C1", thread: " 111.222 " });

    expect(status).toBe(200);
    expect(body.messageId).toBe("reply-ts");
    expect(connector.sendMessage).not.toHaveBeenCalled();
    expect(connector.replyMessage).toHaveBeenCalledTimes(1);
    expect(connector.replyMessage.mock.calls[0][0]).toMatchObject({
      channel: "C1",
      thread: "111.222",
    });
  });

  it("routes a threadless target to sendMessage", async () => {
    connector.sendMessage.mockClear();
    connector.replyMessage.mockClear();

    const { status, body } = await proxySend({ channel: "C1" });

    expect(status).toBe(200);
    expect(body.messageId).toBe("root-ts");
    expect(connector.replyMessage).not.toHaveBeenCalled();
    expect(connector.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("treats a blank or non-string thread as no thread", async () => {
    for (const thread of ["   ", 123, null]) {
      connector.sendMessage.mockClear();
      connector.replyMessage.mockClear();

      const { status } = await proxySend({ channel: "C1", thread });

      expect(status).toBe(200);
      expect(connector.replyMessage).not.toHaveBeenCalled();
      expect(connector.sendMessage).toHaveBeenCalledTimes(1);
    }
  });
});

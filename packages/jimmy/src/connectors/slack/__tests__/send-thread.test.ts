import { describe, it, expect, vi } from "vitest";
import { SlackConnector } from "../index.js";
import type { Target } from "../../../shared/types.js";

// Issue #6: sendMessage silently dropped target.thread — a "thread reply"
// sent through the proxy endpoint or MCP tool landed bare in the channel
// while replyMessage honored the thread. Both paths must be symmetric.

interface PostMessageArgs {
  channel: string;
  thread_ts?: string;
  text: string;
}

function makeConnector() {
  const postMessage = vi.fn(async (_args: PostMessageArgs) => ({ ts: "999.000" }));
  const connector = Object.create(SlackConnector.prototype) as SlackConnector;
  Object.assign(connector as unknown as Record<string, unknown>, {
    app: { client: { chat: { postMessage } } },
    conversations: { recordBotInitiatedThread: vi.fn() },
    respondTo: undefined,
    triageConfig: undefined,
  });
  return { connector, postMessage };
}

describe("SlackConnector.sendMessage — thread targeting (issue #6)", () => {
  it("posts with thread_ts when target.thread is set", async () => {
    const { connector, postMessage } = makeConnector();
    const target: Target = { channel: "C123", thread: "111.222" };

    await connector.sendMessage(target, "reply text");

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C123",
      thread_ts: "111.222",
      text: "reply text",
    });
  });

  it("posts to the channel root when no thread is given", async () => {
    const { connector, postMessage } = makeConnector();
    const target: Target = { channel: "C123" };

    await connector.sendMessage(target, "root text");

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].thread_ts).toBeUndefined();
  });

  it("ignores a blank thread value", async () => {
    const { connector, postMessage } = makeConnector();
    const target: Target = { channel: "C123", thread: "  " };

    await connector.sendMessage(target, "root text");

    expect(postMessage.mock.calls[0][0].thread_ts).toBeUndefined();
  });

  it("trims a padded thread before sending it to Slack", async () => {
    const { connector, postMessage } = makeConnector();
    const target: Target = { channel: "C123", thread: " 111.222 " };

    await connector.sendMessage(target, "reply text");

    expect(postMessage.mock.calls[0][0].thread_ts).toBe("111.222");
  });

  it("ignores a non-string thread from an untrusted payload", async () => {
    const { connector, postMessage } = makeConnector();
    const target = { channel: "C123", thread: 123 } as unknown as Target;

    await connector.sendMessage(target, "root text");

    expect(postMessage.mock.calls[0][0].thread_ts).toBeUndefined();
  });

  it("keeps replyMessage behavior unchanged (thread || messageTs)", async () => {
    const { connector, postMessage } = makeConnector();
    const target: Target = { channel: "C123", messageTs: "333.444" };

    await connector.replyMessage(target, "reply text");

    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C123",
      thread_ts: "333.444",
    });
  });
});

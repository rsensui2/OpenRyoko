import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { getSessionBySessionKey } from "../registry.js";
import type { Connector, Engine, IncomingMessage, JinnConfig } from "../../shared/types.js";

/* The engine's own cross-session memory (Codex memories, Claude Code auto
 * memory) follows the same line as the prompt: a conversation that reaches
 * someone outside the trusted speakers neither loads it nor feeds it. */

vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));
vi.mock("../callbacks.js", async (original) => ({
  ...await original<typeof import("../callbacks.js")>(),
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));

function config(portal: Record<string, unknown>): JinnConfig {
  return {
    engines: { default: "codex", claude: { bin: "claude", model: "" }, codex: { bin: "codex", model: "" } },
    // Goal extraction would spawn a real codex for every Slack-sourced turn.
    connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false },
    sessions: {},
    portal,
  } as unknown as JinnConfig;
}

let counter = 0;

async function nativeMemoryFor(
  portal: Record<string, unknown>,
  transportMeta: Record<string, unknown>,
): Promise<"off" | undefined> {
  const run = vi.fn<Engine["run"]>().mockImplementation(async (opts) => ({
    sessionId: opts.resumeSessionId ?? `engine-${++counter}`, result: "はい", numTurns: 1,
  }));
  const manager = new SessionManager(config(portal), new Map([["codex", { name: "codex", run } as unknown as Engine]]));
  const connector = {
    name: "slack", replyMessage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
    reconstructTarget: (ctx: { channel: string }) => ({ channel: ctx.channel }),
  } as unknown as Connector;
  const channel = `C${++counter}`;
  await manager.route({
    connector: "slack", source: "slack", sessionKey: `slack:${channel}:1.0`, channel, user: "someone", userId: "U1",
    text: "こんにちは", attachments: [], raw: {}, replyContext: { channel }, transportMeta,
  } as unknown as IncomingMessage, connector);
  expect(run).toHaveBeenCalledTimes(1);
  return run.mock.calls[0][0].nativeMemory;
}

describe("SessionManager — the engine's own memory by audience", () => {
  const trust = { trustedSpeakers: ["UTRUSTED"], operatorSlackId: "UOPERATOR" };

  it("leaves it to the engine's configuration for a trusted speaker", async () => {
    expect(await nativeMemoryFor(trust, { speakerSlackId: "UTRUSTED", channelExternal: false })).toBeUndefined();
    expect(await nativeMemoryFor(trust, { speakerSlackId: "UOPERATOR", channelExternal: false })).toBeUndefined();
  });

  it("turns it off for a speaker outside the trusted speakers", async () => {
    expect(await nativeMemoryFor(trust, { speakerSlackId: "USTRANGER", channelExternal: false })).toBe("off");
    expect(await nativeMemoryFor(trust, { channelExternal: false })).toBe("off");
  });

  it("turns it off in a channel shared with another organization, whoever speaks", async () => {
    expect(await nativeMemoryFor(trust, { speakerSlackId: "UTRUSTED", channelExternal: true })).toBe("off");
  });

  it("does nothing on an instance that has no trusted IDs to compare against", async () => {
    expect(await nativeMemoryFor({}, { speakerSlackId: "UANYONE", channelExternal: false })).toBeUndefined();
    // Not even when the connector could not tell whether the channel is shared.
    expect(await nativeMemoryFor({}, { speakerSlackId: "UANYONE", channelExternal: true })).toBeUndefined();
  });

  it("keeps it off for the rest of a thread once an outsider has spoken there", async () => {
    const run = vi.fn<Engine["run"]>().mockImplementation(async (opts) => ({
      sessionId: opts.resumeSessionId ?? `engine-${++counter}`, result: "はい", numTurns: 1,
    }));
    const manager = new SessionManager(config(trust), new Map([["codex", { name: "codex", run } as unknown as Engine]]));
    const connector = {
      name: "slack", replyMessage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
      reconstructTarget: (ctx: { channel: string }) => ({ channel: ctx.channel }),
    } as unknown as Connector;
    const channel = `C${++counter}`;
    const say = (speakerSlackId: string, text: string) => manager.route({
      connector: "slack", source: "slack", sessionKey: `slack:${channel}:1.0`, channel, user: "someone", userId: speakerSlackId,
      text, attachments: [], raw: {}, replyContext: { channel }, transportMeta: { speakerSlackId, channelExternal: false },
    } as unknown as IncomingMessage, connector);

    await say("UTRUSTED", "始めます");
    await say("USTRANGER", "これを覚えておいて");
    await say("UTRUSTED", "続けて");

    expect(run.mock.calls.map(([opts]) => opts.nativeMemory)).toEqual([undefined, "off", "off"]);
    const stored = getSessionBySessionKey(`slack:${channel}:1.0`)!.transportMeta as Record<string, unknown>;
    expect(stored.externalSpeakerSeen).toBe(true);
    // A connector cannot clear the mark by sending the field itself.
    await manager.route({
      connector: "slack", source: "slack", sessionKey: `slack:${channel}:1.0`, channel, user: "someone", userId: "UTRUSTED",
      text: "もう一度", attachments: [], raw: {}, replyContext: { channel },
      transportMeta: { speakerSlackId: "UTRUSTED", channelExternal: false, externalSpeakerSeen: false },
    } as unknown as IncomingMessage, connector);
    expect(run.mock.calls.at(-1)![0].nativeMemory).toBe("off");
  });

  it("keeps no mark in a one-to-one direct message, so a corrected ID takes effect on the next message", async () => {
    const channel = `D${++counter}`;
    const sent: Array<"off" | undefined> = [];
    const send = async (portal: Record<string, unknown>) => {
      const run = vi.fn<Engine["run"]>().mockImplementation(async (opts) => ({
        sessionId: opts.resumeSessionId ?? `engine-${++counter}`, result: "はい", numTurns: 1,
      }));
      const manager = new SessionManager(config(portal), new Map([["codex", { name: "codex", run } as unknown as Engine]]));
      const connector = {
        name: "slack", replyMessage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => undefined),
        addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
        getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
        reconstructTarget: (ctx: { channel: string }) => ({ channel: ctx.channel }),
      } as unknown as Connector;
      await manager.route({
        connector: "slack", source: "slack", sessionKey: `slack:${channel}`, channel, user: "owner", userId: "UOWNER",
        text: "これを覚えておいて", attachments: [], raw: {}, replyContext: { channel },
        transportMeta: { speakerSlackId: "UOWNER", channelExternal: false },
      } as unknown as IncomingMessage, connector);
      expect(run).toHaveBeenCalledTimes(1);
      sent.push(run.mock.calls[0][0].nativeMemory);
    };

    // The owner's ID was typed as a number: nobody matches, the owner included.
    await send({ trustedSpeakers: ["UTRUSTED"], operatorSlackId: 12345 });
    await send({ trustedSpeakers: ["UTRUSTED"], operatorSlackId: "UOWNER" });

    expect(sent).toEqual(["off", undefined]);
    const stored = getSessionBySessionKey(`slack:${channel}`)!.transportMeta as Record<string, unknown>;
    expect(stored.externalSpeakerSeen).toBeUndefined();
  });
});

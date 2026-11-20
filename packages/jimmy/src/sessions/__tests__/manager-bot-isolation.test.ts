import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { getSessionBySessionKey } from "../registry.js";
import { deriveSessionKey } from "../../connectors/slack/threads.js";
import { SlackConnector } from "../../connectors/slack/index.js";
import type { Connector, Employee, Engine, IncomingMessage, JinnConfig } from "../../shared/types.js";

/* Two Slack bots in one workspace see the same user and the same threads.
 * Properties under test: the main bot and a peer Ryoko's bot never share a
 * session — a DM, or a thread where both are mentioned, starts one session
 * per bot and neither resumes the other's engine session — and the manager
 * refuses to continue a session owned by a different assistant even when the
 * keys do collide. */

vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));
vi.mock("../callbacks.js", async (original) => ({
  ...await original<typeof import("../callbacks.js")>(),
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));

const CONFIG = {
  engines: { default: "claude", claude: { bin: "claude", model: "" }, codex: { bin: "codex", model: "" } },
  // Goal extraction would spawn a real codex for every Slack-sourced turn.
  connectors: { slack: { goalExtraction: { enabled: false } } },
  logging: { level: "error", stdout: false },
  sessions: {},
} as unknown as JinnConfig;

const HANA: Employee = {
  name: "hana", displayName: "Hana", department: "ryokos", rank: "executive", engine: "claude", persona: "Calm.", peer: { memory: "own" },
};

let counter = 0;

function setup() {
  const run = vi.fn<Engine["run"]>().mockImplementation(async (opts) => ({
    sessionId: opts.resumeSessionId ?? `engine-${++counter}`, result: "はい", numTurns: 1,
  }));
  const manager = new SessionManager(CONFIG, new Map([["claude", { name: "claude", run } as unknown as Engine]]));
  const connector = (name: string) => ({
    name, replyMessage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
    reconstructTarget: (ctx: { channel: string }) => ({ channel: ctx.channel }),
  }) as unknown as Connector;
  return { manager, run, main: connector("slack"), peer: connector("slack") };
}

function message(connector: string, sessionKey: string, channel: string, text: string): IncomingMessage {
  return {
    connector, source: "slack", sessionKey, channel, user: "U1", userId: "U1", text,
    attachments: [], raw: {}, replyContext: { channel }, transportMeta: { channelExternal: false },
  } as unknown as IncomingMessage;
}

describe("Slack session keys per connector instance", () => {
  it("keeps the default connector's key format and prefixes every other instance", () => {
    const dm = { channel: "D1", user: "U9", ts: "100.0", channel_type: "im" };
    expect(deriveSessionKey(dm)).toBe("slack:dm:U9");
    expect(deriveSessionKey(dm, "slack-hana")).toBe("slack-hana:dm:U9");
    const thread = { channel: "C1", user: "U9", ts: "200.0", thread_ts: "100.0", channel_type: "channel" };
    expect(deriveSessionKey(thread)).toBe("slack:C1:100.0");
    expect(deriveSessionKey(thread, "slack-hana")).toBe("slack-hana:C1:100.0");
  });

  it("a connector built for an instance carries its id; the default one stays \"slack\"", () => {
    const dummy = { botToken: "xoxb-1", appToken: "xapp-1" };
    expect(new SlackConnector(dummy).instanceId).toBe("slack");
    expect(new SlackConnector(dummy, { instanceId: "slack-hana" }).instanceId).toBe("slack-hana");
  });
});

describe("SessionManager — main and peer bots never share a session", () => {
  it("the same user's DMs to main and to a peer are two sessions, neither resuming the other", async () => {
    const { manager, run, main, peer } = setup();
    const user = `U${++counter}`;
    const dm = { channel: "D1", user, ts: "1.0", channel_type: "im" };
    const mainKey = deriveSessionKey(dm);
    const peerKey = deriveSessionKey(dm, "slack-hana");

    await manager.route(message("slack", mainKey, "D1", "main 1"), main);
    await manager.route(message("slack-hana", peerKey, "D1", "peer 1"), peer, { employee: HANA });
    await manager.route(message("slack", mainKey, "D1", "main 2"), main);
    await manager.route(message("slack-hana", peerKey, "D1", "peer 2"), peer, { employee: HANA });

    const mainSession = getSessionBySessionKey(mainKey)!;
    const peerSession = getSessionBySessionKey(peerKey)!;
    expect(mainSession.id).not.toBe(peerSession.id);
    expect(mainSession).toMatchObject({ employee: null, connector: "slack" });
    expect(peerSession).toMatchObject({ employee: "hana", connector: "slack-hana" });
    const resumed = run.mock.calls.map(([opts]) => opts.resumeSessionId);
    expect(resumed[0]).toBeUndefined();
    expect(resumed[1]).toBeUndefined(); // the peer's first turn does not continue main's
    expect(resumed[2]).toBe(mainSession.engineSessionId);
    expect(resumed[3]).toBe(peerSession.engineSessionId);
    expect(mainSession.engineSessionId).not.toBe(peerSession.engineSessionId);
  });

  it("a thread where both bots are mentioned gets one session per bot", async () => {
    const { manager, run, main, peer } = setup();
    const ts = `${++counter}.0`;
    const reply = { channel: "C1", user: "U1", ts: `${ts}1`, thread_ts: ts, channel_type: "channel" };
    const mainKey = deriveSessionKey(reply);
    const peerKey = deriveSessionKey(reply, "slack-hana");
    expect(mainKey).not.toBe(peerKey);

    await manager.route(message("slack", mainKey, "C1", "<@MAIN> <@HANA> 両方見て"), main);
    await manager.route(message("slack-hana", peerKey, "C1", "<@MAIN> <@HANA> 両方見て"), peer, { employee: HANA });

    expect(getSessionBySessionKey(mainKey)!.id).not.toBe(getSessionBySessionKey(peerKey)!.id);
    expect(run.mock.calls[1][0].resumeSessionId).toBeUndefined();
  });

  it("never continues a session owned by another assistant, even under the same key", async () => {
    const { manager, run, main, peer } = setup();
    const key = `slack:dm:collide-${++counter}`;

    await manager.route(message("slack", key, "D1", "main"), main);
    const mainSession = getSessionBySessionKey(key)!;
    await manager.route(message("slack-hana", key, "D1", "peer"), peer, { employee: HANA });
    const peerSession = getSessionBySessionKey(key)!;

    expect(peerSession.id).not.toBe(mainSession.id);
    expect(peerSession.employee).toBe("hana");
    expect(run.mock.calls[1][0].resumeSessionId).toBeUndefined();

    // And back: the main assistant does not pick up the peer's session.
    await manager.route(message("slack", key, "D1", "main again"), main);
    expect(getSessionBySessionKey(key)!.employee).toBeNull();
    expect(run.mock.calls[2][0].resumeSessionId).not.toBe(peerSession.engineSessionId);
  });

  it("a bound bot never continues the main assistant's session, even through the same connector", async () => {
    const { manager, run, main, peer } = setup();
    const key = `slack:dm:same-connector-${++counter}`;
    await manager.route(message("slack", key, "D1", "main"), main);
    await manager.route(message("slack", key, "D1", "peer"), peer, { employee: HANA });
    expect(getSessionBySessionKey(key)!.employee).toBe("hana");
    expect(run.mock.calls[1][0].resumeSessionId).toBeUndefined();
  });
});

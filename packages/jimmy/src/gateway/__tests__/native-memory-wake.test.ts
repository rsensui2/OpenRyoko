import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
vi.mock("../../sessions/goal-review.js", () => ({ reviewGoal: vi.fn() }));

import type { Connector, Engine, EngineRunOpts, JinnConfig } from "../../shared/types.js";

// A connector session woken through the gateway's own runner (a detached job
// or a child session finished) has no incoming message to read a speaker from.
// It is still the conversation it was: the audience comes from what the
// session recorded, for the prompt and for the engine's own memory alike.
//
// RYOKO_HOME must point at a temp dir BEFORE any module import pulls in
// shared/paths.js, so every module here is imported dynamically.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "native-memory-wake-"));

// The opening of the text an external conversation gets. The ordinary guidance mentions outsiders too,
// so a shorter phrase would not tell the two apart.
const OUTSIDER_NOTICE = "This conversation includes someone outside the trusted speakers";
const CONFIG = {
  jinn: { version: "0.0.0" },
  gateway: { port: 0, host: "127.0.0.1" },
  engines: { default: "codex", claude: { bin: "claude", model: "" }, codex: { bin: "codex", model: "" } },
  connectors: {},
  sessions: {},
  portal: { trustedSpeakers: ["UTRUSTED"], operatorSlackId: "UOPERATOR" },
  logging: { level: "error", stdout: false, file: "" },
} as unknown as JinnConfig;

describe("a woken connector session keeps its audience", () => {
  let server: http.Server;
  let baseUrl: string;
  let runs: EngineRunOpts[];
  let create: (meta: Record<string, unknown>, channelPrefix?: string) => string;

  beforeAll(async () => {
    const { handleApiRequest } = await import("../api.js");
    const { createSession } = await import("../../sessions/registry.js");
    const { SessionManager } = await import("../../sessions/manager.js");

    runs = [];
    const codex: Engine = {
      name: "codex",
      run: vi.fn(async (opts: EngineRunOpts) => { runs.push(opts); return { sessionId: "codex-wake", result: "完了しました。", numTurns: 1 }; }),
    };
    const sessionManager = new SessionManager(CONFIG, new Map([["codex", codex]]), ["slack"]);
    const slack = {
      name: "slack",
      replyMessage: vi.fn(async () => "posted-ts"),
      addReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
      reconstructTarget: (rc: Record<string, unknown>) => ({ channel: String(rc.channel ?? ""), thread: rc.thread as string | undefined }),
    } as unknown as Connector;

    let n = 0;
    create = (transportMeta, channelPrefix = "C") => {
      const channel = `${channelPrefix}${++n}`;
      // As the connector stores it: `sourceRef` is the session key, never the raw channel ID,
      // so only `replyContext` can tell this runner that the conversation is a direct message.
      return createSession({
        engine: "codex", source: "slack", sourceRef: `slack:${channel}:100.200`, connector: "slack",
        sessionKey: `slack:${channel}:100.200`,
        replyContext: { channel, thread: "100.200" },
        transportMeta: transportMeta as never,
        prompt: "資料を作って",
      }).id;
    };

    const context = {
      config: CONFIG, getConfig: () => CONFIG, sessionManager, startTime: 0, emit: () => {},
      connectors: new Map([["slack", slack]]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server = http.createServer((req, res) => { void handleApiRequest(req, res, context as any); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  async function wake(sessionId: string): Promise<EngineRunOpts> {
    const before = runs.length;
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: '✅ Detached job "build" completed successfully (exit 0).', role: "notification" }),
    });
    expect(response.status).toBeLessThan(300);
    await vi.waitFor(() => expect(runs.length).toBeGreaterThan(before), { timeout: 5000 });
    return runs[before];
  }

  it("runs a thread an outsider spoke in without the engine's own memory, and says so in the prompt", async () => {
    const opts = await wake(create({ speakerSlackId: "UTRUSTED", channelExternal: false, externalSpeakerSeen: true }));
    expect(opts.nativeMemory).toBe("off");
    expect(opts.systemPrompt).toContain(OUTSIDER_NOTICE);
  });

  it("does the same for a thread in a channel shared beyond the workspace", async () => {
    const opts = await wake(create({ speakerSlackId: "UTRUSTED", channelExternal: true }));
    expect(opts.nativeMemory).toBe("off");
    expect(opts.systemPrompt).toContain(OUTSIDER_NOTICE);
  });

  it("goes by the speaker alone in a one-to-one direct message, whatever mark the session carries", async () => {
    const trusted = await wake(create({ speakerSlackId: "UTRUSTED", channelExternal: true, externalSpeakerSeen: true }, "D"));
    expect(trusted.nativeMemory).toBeUndefined();
    expect(trusted.systemPrompt).not.toContain(OUTSIDER_NOTICE);
    // Knowing it is a direct message decides the audience only: this runner never injects MEMORY.md.
    expect(trusted.systemPrompt).not.toContain("## Long-term memory");
    const stranger = await wake(create({ speakerSlackId: "USTRANGER", channelExternal: false }, "D"));
    expect(stranger.nativeMemory).toBe("off");
    expect(stranger.systemPrompt).toContain(OUTSIDER_NOTICE);
  });

  it("leaves a trusted speaker's own thread as it was", async () => {
    const opts = await wake(create({ speakerSlackId: "UTRUSTED", channelExternal: false }));
    expect(opts.nativeMemory).toBeUndefined();
    expect(opts.systemPrompt).not.toContain(OUTSIDER_NOTICE);
  });
});

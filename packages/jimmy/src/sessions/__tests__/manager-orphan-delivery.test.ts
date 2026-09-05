import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, JinnConfig } from "../../shared/types.js";

// Orphan Stop hooks share the origin-delivery path with notification
// wake-ups. When the connector rejects the delivery, the failure must be
// persisted into the session — not swallowed into a log line — or the
// customer conversation is left silent with no trace (issue #38 follow-up).
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-deliv-home-"));

const STUB_CONFIG = {
  jinn: { version: "0.0.0" },
  gateway: { port: 0, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "" },
    codex: { bin: "codex", model: "" },
  },
  connectors: {},
  sessions: {},
  logging: { level: "error", stdout: false, file: "" },
} as unknown as JinnConfig;

describe("handleOrphanHook — origin delivery failure is persisted", () => {
  let sessionId: string;
  let getSession: typeof import("../registry.js").getSession;
  let getMessages: typeof import("../registry.js").getMessages;

  beforeAll(async () => {
    const registry = await import("../registry.js");
    getSession = registry.getSession;
    getMessages = registry.getMessages;
    const { SessionManager } = await import("../manager.js");

    const session = registry.createSession({
      engine: "claude",
      source: "slack",
      sourceRef: "C_CUST",
      connector: "slack",
      sessionKey: "slack:C_CUST:5.5",
      replyContext: { channel: "C_CUST", thread: "5.5" },
      transportMeta: { channelExternal: true },
      prompt: "資料を作って",
    });
    sessionId = session.id;

    const failingSlack = {
      name: "slack",
      replyMessage: vi.fn(async () => {
        throw new Error("slack down");
      }),
      addReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
      reconstructTarget: (rc: Record<string, unknown>) => ({
        channel: typeof rc.channel === "string" ? rc.channel : "",
        thread: typeof rc.thread === "string" ? rc.thread : undefined,
      }),
    } as unknown as Connector;

    const mgr = new SessionManager(STUB_CONFIG, new Map<string, Engine>(), ["slack"]);
    mgr.setConnectorProvider(() => new Map([["slack", failingSlack]]));

    await mgr.handleOrphanHook(sessionId, {
      hook_event_name: "Stop",
      last_assistant_message: "遅れましたが完成しました",
    });
  }, 30_000);

  afterAll(() => {
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  it("records the failure on the session instead of swallowing it", () => {
    const session = getSession(sessionId);
    expect(session?.lastError).toContain("origin delivery failed");

    const notes = getMessages(sessionId).filter((m) => m.role === "notification");
    expect(notes.some((m) => m.content.includes("NOT delivered to the original conversation"))).toBe(true);
    // The computed answer itself is still persisted for reposting.
    const assistant = getMessages(sessionId).filter((m) => m.role === "assistant");
    expect(assistant.some((m) => m.content === "遅れましたが完成しました")).toBe(true);
  });
});

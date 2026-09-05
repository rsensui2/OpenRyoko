import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiContext } from "../api.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-history-api-"));
process.env.RYOKO_HOME = path.join(root, "ryoko");
process.env.HOME = path.join(root, "home");

describe("history API paging", () => {
  let server: http.Server;
  let baseUrl: string;
  let sessionId: string;

  beforeAll(async () => {
    const registry = await import("../../sessions/registry.js");
    const { handleApiRequest } = await import("../api.js");
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "history-api" });
    sessionId = session.id;
    registry.updateSession(sessionId, { engineSessionId: "transcript-history-api" });

    const transcriptDir = path.join(process.env.HOME!, ".claude", "projects", "test-project");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const rows = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      type: index % 2 === 0 ? "user" : "assistant",
      message: { content: `transcript-${index + 1}` },
    }));
    fs.writeFileSync(path.join(transcriptDir, "transcript-history-api.jsonl"), rows.join("\n"));

    const queue = {
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    };
    const context = {
      getConfig: () => ({}),
      sessionManager: { getQueue: () => queue },
      startTime: 0,
      emit: () => {},
      connectors: new Map(),
    } as unknown as ApiContext;
    server = http.createServer((req, res) => { void handleApiRequest(req, res, context); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps last=N bounded after recovering a JSONL transcript", async () => {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}?last=2`);
    expect(response.status).toBe(200);
    const body = await response.json() as { messages: Array<{ content: string }>; messagesPage: { hasOlder: boolean } };
    expect(body.messages.map((message) => message.content)).toEqual(["transcript-4", "transcript-5"]);
    expect(body.messagesPage.hasOlder).toBe(true);
  });

  it("can fetch metadata without loading message history", async () => {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}?messages=0`);
    const body = await response.json() as Record<string, unknown>;
    expect(body.id).toBe(sessionId);
    expect(body).not.toHaveProperty("messages");
  });
});

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiContext } from "../api.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-search-api-"));
process.env.RYOKO_HOME = path.join(root, "ryoko");
process.env.HOME = path.join(root, "home");

interface SearchBody {
  results: Array<{ sessionId: string; source: string | null; snippet: string }>;
}

describe("GET /api/search/messages", () => {
  let server: http.Server;
  let baseUrl: string;
  let chatId: string;
  let cronId: string;

  const search = (params: Record<string, string>) =>
    fetch(`${baseUrl}/api/search/messages?${new URLSearchParams(params)}`);

  beforeAll(async () => {
    const registry = await import("../../sessions/registry.js");
    const { handleApiRequest } = await import("../api.js");
    chatId = registry.createSession({ engine: "claude", source: "slack", sourceRef: "slack:C1:1" }).id;
    cronId = registry.createSession({ engine: "claude", source: "cron", sourceRef: "cron:weekly:1" }).id;
    registry.insertMessage(chatId, "user", "来週の請求書の宛名を変えておいて");
    registry.insertMessage(cronId, "user", "【週次】請求書の未送付を確認する");

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

  it("finds a Japanese word inside a sentence, in every kind of session by default", async () => {
    const response = await search({ q: "請求書" });
    expect(response.status).toBe(200);
    const body = await response.json() as SearchBody;
    expect(body.results.map((result) => result.sessionId).sort()).toEqual([chatId, cronId].sort());
    expect(body.results[0].snippet).toContain("«請求書»");
  });

  it("narrows to conversations or to named sources", async () => {
    const conversations = await (await search({ q: "請求書", scope: "conversations" })).json() as SearchBody;
    expect(conversations.results.map((result) => [result.sessionId, result.source])).toEqual([[chatId, "slack"]]);
    const cronOnly = await (await search({ q: "請求書", source: "cron" })).json() as SearchBody;
    expect(cronOnly.results.map((result) => result.sessionId)).toEqual([cronId]);
  });

  it("rejects a scope or source it does not understand", async () => {
    expect((await search({ q: "請求書", scope: "everything" })).status).toBe(400);
    expect((await search({ q: "請求書", source: "slack;drop" })).status).toBe(400);
  });
});

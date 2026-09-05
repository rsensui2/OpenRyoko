import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiContext } from "../api.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-auth-api-"));
process.env.RYOKO_HOME = path.join(root, "home");

describe("pairing API", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { handleApiRequest } = await import("../api.js");
    const queue = { getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status };
    const context = {
      getConfig: () => ({ gateway: { host: "0.0.0.0", port: 7777 } }),
      sessionManager: { getQueue: () => queue },
      startTime: 0,
      emit: () => {},
      connectors: new Map(),
      authHome: path.join(root, "home"),
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

  it("rejects an oversized unauthenticated redemption body", async () => {
    const response = await fetch(`${baseUrl}/api/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "A".repeat(2_048) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Payload too large" });
  });

  it("exposes only a metadata-free liveness response", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rate-limits repeated invalid pairing codes", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "INVALID" }),
      });
      expect(response.status).toBe(401);
    }
    const blocked = await fetch(`${baseUrl}/api/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "INVALID" }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("300");
  });
});

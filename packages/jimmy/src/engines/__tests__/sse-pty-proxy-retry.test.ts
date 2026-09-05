import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { SsePtyProxy } from "../sse-pty-proxy.js";

// These tests target the "stale pooled socket" failure mode: the keep-alive pool
// occasionally hands the proxy a connection the server already half-closed, which
// errors with ECONNRESET / "socket hang up" before any response — and surfaced to
// the CLI as a bare 502. The proxy retries transient pre-response failures on
// fresh sockets with a bounded attempt count.

interface Upstream {
  port: number;
  attempts: () => number;
  close: () => Promise<void>;
}

/** Spin up a local HTTP server whose behavior per-attempt is decided by `onAttempt`.
 *  `onAttempt(n, req, res)` runs for the n-th (1-based) request; return nothing. */
function startUpstream(onAttempt: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Upstream> {
  let n = 0;
  const server = http.createServer((req, res) => {
    n += 1;
    // Drain the request body so the socket is fully consumed before we act.
    req.resume();
    onAttempt(n, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        attempts: () => n,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** POST to the proxy and resolve with the status code + collected body. */
function callProxy(port: number, body = '{"hello":"world"}'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("SsePtyProxy upstream retry (stale keep-alive socket → 502 fix)", () => {
  const proxies: SsePtyProxy[] = [];
  const upstreams: Upstream[] = [];
  const newProxy = (u: Upstream) => {
    const p = new SsePtyProxy("test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: u.port },
      primaryAgent: false,
    });
    proxies.push(p);
    return p;
  };

  afterEach(async () => {
    for (const p of proxies.splice(0)) p.stop();
    for (const u of upstreams.splice(0)) await u.close();
  });

  it("retries once on a fresh socket when the first upstream connection is reset before any response", async () => {
    const upstream = await startUpstream((n, _req, res) => {
      if (n === 1) {
        // Simulate a dead pooled socket: reset the connection before responding.
        res.socket?.destroy();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("ok");
      }
    });
    upstreams.push(upstream);
    const proxy = newProxy(upstream);
    const port = await proxy.start();

    const out = await callProxy(port);

    expect(out.status).toBe(200);
    expect(out.body).toBe("ok");
    expect(upstream.attempts()).toBe(2); // one failed attempt + one retry
  });

  it("retries at most three total attempts — a persistently dead upstream ends as 502", async () => {
    const upstream = await startUpstream((_n, _req, res) => {
      res.socket?.destroy(); // every attempt resets
    });
    upstreams.push(upstream);
    const proxy = newProxy(upstream);
    const port = await proxy.start();

    const out = await callProxy(port);

    expect(out.status).toBe(502);
    expect(upstream.attempts()).toBe(3); // original + two bounded retries
  });

  it("does NOT retry a real HTTP error response — 500 is forwarded unchanged", async () => {
    const upstream = await startUpstream((_n, _req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"boom"}');
    });
    upstreams.push(upstream);
    const proxy = newProxy(upstream);
    const port = await proxy.start();

    const out = await callProxy(port);

    expect(out.status).toBe(500);
    expect(out.body).toBe('{"error":"boom"}');
    expect(upstream.attempts()).toBe(1); // forwarded, never retried
  });

  it("destroys the keep-alive pool owned by a PTY when the proxy stops", () => {
    const proxy = new SsePtyProxy("pool-cleanup", () => {});
    proxies.push(proxy);
    const pool = (proxy as any).primaryAgent;
    const destroy = vi.spyOn(pool, "destroy");
    proxy.stop();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

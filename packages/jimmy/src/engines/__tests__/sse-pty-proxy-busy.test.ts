import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { SsePtyProxy } from "../sse-pty-proxy.js";

// isBusy() feeds the PTY lifecycle's reaper guard: a PTY whose claude is
// mid-API-call (or was within the recent-activity window) must never be
// reaped/evicted — that's what silently killed background sub-agent work.

interface Upstream {
  port: number;
  /** Resolve the response that is currently being held open. */
  release: () => void;
  close: () => Promise<void>;
}

/** Upstream that holds every response open until release() is called. */
function startHoldingUpstream(): Promise<Upstream> {
  const pending: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    pending.push(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        release: () => {
          for (const res of pending.splice(0)) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          }
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function callProxy(port: number): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode || 0 }));
      },
    );
    req.on("error", reject);
    req.end('{"messages":[]}');
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SsePtyProxy.isBusy (background-work liveness for the PTY reaper)", () => {
  const proxies: SsePtyProxy[] = [];
  const upstreams: Upstream[] = [];
  afterEach(async () => {
    while (proxies.length > 0) proxies.pop()!.stop();
    while (upstreams.length > 0) await upstreams.pop()!.close();
  });

  it("is false before any request, true while one is in flight, and false once the window elapses", async () => {
    const up = await startHoldingUpstream();
    upstreams.push(up);
    const proxy = new SsePtyProxy("busy-test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: up.port },
      primaryAgent: false,
    });
    proxies.push(proxy);
    const port = await proxy.start();

    expect(proxy.isBusy(60_000)).toBe(false); // nothing has happened yet

    const call = callProxy(port);
    await sleep(50); // request reaches the upstream and is held open
    expect(proxy.isBusy(60_000)).toBe(true); // in flight → busy regardless of window

    up.release();
    await call;
    await sleep(30);
    expect(proxy.isBusy(60_000)).toBe(true); // finished recently → inside window
    expect(proxy.isBusy(1)).toBe(false); // window elapsed → idle
  });
});

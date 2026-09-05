import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertLoopbackGatewayUrl,
  buildJobNotification,
  readLogTail,
  sendJobNotification,
} from "../notify.js";
import type { JobState } from "../state.js";

function makeState(overrides: Partial<JobState> = {}): JobState {
  return {
    id: "pdf-build-1",
    name: "pdf-build",
    sessionId: "sess-1",
    gatewayUrl: "http://127.0.0.1:7777",
    command: "make pdf",
    logFile: "/tmp/pdf-build-1.log",
    monitorPid: 1234,
    startedAt: "2026-08-04T01:00:00.000Z",
    finishedAt: "2026-08-04T01:03:12.000Z",
    status: "exited",
    exitCode: 0,
    signal: null,
    ...overrides,
  };
}

describe("buildJobNotification", () => {
  it("success: includes name, exit code, duration, log path, tail and follow-up", () => {
    const msg = buildJobNotification(makeState(), "line1\nline2");
    expect(msg).toContain('✅ Detached job "pdf-build" completed successfully (exit 0, 3m12s)');
    expect(msg).toContain("Log file: /tmp/pdf-build-1.log");
    expect(msg).toContain("line1\nline2");
    expect(msg).toContain("Continue the work you deferred");
    expect(msg).toContain("reply to the original conversation");
  });

  it("failure: distinct wording with recovery instructions", () => {
    const msg = buildJobNotification(makeState({ exitCode: 3 }), "boom");
    expect(msg).toContain('❌ Detached job "pdf-build" FAILED — exited with code 3');
    expect(msg).toContain("Recover now");
    expect(msg).toContain("do NOT leave the original conversation waiting silently");
    expect(msg).not.toContain("✅");
  });

  it("timeout: reported as timed out, not as a plain exit", () => {
    const msg = buildJobNotification(makeState({ exitCode: null, signal: "SIGTERM", timedOut: true, timeoutSec: 600 }), "");
    expect(msg).toContain("timed out after 600s");
    expect(msg).toContain("❌");
  });

  it("signal kill: reported with the signal name", () => {
    const msg = buildJobNotification(makeState({ exitCode: null, signal: "SIGKILL" }), "");
    expect(msg).toContain("was killed by signal SIGKILL");
  });
});

describe("readLogTail", () => {
  it("returns the last N lines of the log", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tail-")), "x.log");
    fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"));
    const tail = readLogTail(file, 5);
    expect(tail).toBe("line95\nline96\nline97\nline98\nline99");
  });

  it("reports a missing log instead of throwing", () => {
    expect(readLogTail("/nonexistent/x.log")).toContain("missing");
  });
});

describe("assertLoopbackGatewayUrl", () => {
  it("accepts loopback hosts", () => {
    expect(() => assertLoopbackGatewayUrl("http://127.0.0.1:7777")).not.toThrow();
    expect(() => assertLoopbackGatewayUrl("http://localhost:7777")).not.toThrow();
    expect(() => assertLoopbackGatewayUrl("http://[::1]:7777")).not.toThrow();
  });

  it("rejects non-loopback hosts (no remote wake route)", () => {
    expect(() => assertLoopbackGatewayUrl("http://10.0.0.5:7777")).toThrow(/loopback/);
    expect(() => assertLoopbackGatewayUrl("http://example.com")).toThrow(/loopback/);
    expect(() => assertLoopbackGatewayUrl("not a url")).toThrow(/Invalid/);
  });
});

describe("sendJobNotification", () => {
  const sleep = vi.fn(async () => {});

  it("posts the notification to the session message route", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await sendJobNotification(makeState(), "msg", {
      fetchFn,
      sleep,
      readAuthToken: () => "test-gateway-token",
    });
    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/sess-1/message");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-gateway-token");
    expect(JSON.parse(String(init.body))).toEqual({ message: "msg", role: "notification", dedupeKey: "job:pdf-build-1" });
  });

  it("omits authorization when gateway auth has not been initialized", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await sendJobNotification(makeState(), "msg", { fetchFn, sleep, readAuthToken: () => null });

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("reloads the gateway token for each retry", async () => {
    const tokens = ["stale-token", "current-token"];
    const readAuthToken = vi.fn(() => tokens.shift() ?? null);
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return new Response("{}", { status: authorization === "Bearer current-token" ? 200 : 401 });
    });

    const result = await sendJobNotification(makeState(), "msg", {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep,
      readAuthToken,
      retryDelaysMs: [1],
    });

    expect(result.ok).toBe(true);
    expect(readAuthToken).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries through gateway downtime and succeeds exactly once", async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await sendJobNotification(makeState(), "msg", {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep,
      retryDelaysMs: [1, 1, 1],
    });
    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("gives up with the last error after exhausting retries", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await sendJobNotification(makeState(), "msg", {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep,
      retryDelaysMs: [1, 1],
    });
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("stops immediately on 404 — the session no longer exists", async () => {
    const fetchFn = vi.fn(async () => new Response("nf", { status: 404 }));
    const result = await sendJobNotification(makeState(), "msg", {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep,
      retryDelaysMs: [1, 1, 1],
    });
    expect(result.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-loopback gateway URL", async () => {
    await expect(
      sendJobNotification(makeState({ gatewayUrl: "http://evil.example:7777" }), "msg", { sleep }),
    ).rejects.toThrow(/loopback/);
  });
});

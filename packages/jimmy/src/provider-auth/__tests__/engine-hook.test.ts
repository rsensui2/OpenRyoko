import { afterEach, describe, expect, it, vi } from "vitest";
import { runEngineWithResponseTimeout } from "../../sessions/engine-fallback.js";
import type { Engine, EngineResult, JinnConfig } from "../../shared/types.js";
import { onProviderAuthFailure } from "../failure-signal.js";
import { getProviderAuthService } from "../index.js";
import type { AuthFailureNotifier } from "../types.js";
import { settle } from "./support.js";

const config = { engines: { default: "claude" }, sessions: {}, connectors: {} } as unknown as JinnConfig;
const AUTH_FAILED = "Interactive turn failed: authentication_failed";

function engine(name: Engine["name"], outcome: EngineResult | Error): Engine {
  return { name, run: vi.fn(async () => { if (outcome instanceof Error) throw outcome; return outcome; }) };
}

describe("engine run path → provider auth failure signal", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const undo of cleanup.splice(0)) undo(); });
  function observe() {
    const seen = vi.fn();
    cleanup.push(onProviderAuthFailure(seen));
    return seen;
  }

  it("reports a turn that failed on a lost login, and returns the result untouched", async () => {
    const seen = observe();
    const failed = { sessionId: "s", result: "", error: AUTH_FAILED };

    const result = await runEngineWithResponseTimeout(engine("claude", failed), { prompt: "task", cwd: "/tmp", sessionId: "s" }, config);
    await settle();

    expect(result).toEqual(failed);
    expect(seen).toHaveBeenCalledExactlyOnceWith("claude");
  });

  it("reports an engine that threw", async () => {
    const seen = observe();
    const thrown = new Error("unexpected status 401 Unauthorized: token_expired");

    const result = await runEngineWithResponseTimeout(engine("codex", thrown), { prompt: "task", cwd: "/tmp" }, config);
    await settle();

    expect(result.error).toBe(thrown.message);
    expect(seen).toHaveBeenCalledExactlyOnceWith("codex");
  });

  it("says nothing for a turn that succeeded, failed for another reason, or ran on another host", async () => {
    const seen = observe();
    const opts = { prompt: "task", cwd: "/tmp" };

    await runEngineWithResponseTimeout(engine("claude", { sessionId: "s", result: "done" }), opts, config);
    await runEngineWithResponseTimeout(engine("claude", { sessionId: "s", result: "", error: "Interactive turn failed: rate_limit" }), opts, config);
    await runEngineWithResponseTimeout(engine("claude", { sessionId: "s", result: "", error: AUTH_FAILED }), { ...opts, sshHost: "build-box" }, config);
    await settle();

    expect(seen).not.toHaveBeenCalled();
  });

  it("reaches the notifiers of the shared service", async () => {
    const service = getProviderAuthService();
    expect(getProviderAuthService()).toBe(service);
    const notifier = vi.fn<AuthFailureNotifier>(async () => true);
    cleanup.push(service.addNotifier(notifier));

    await runEngineWithResponseTimeout(engine("claude", { sessionId: "s", result: "", error: AUTH_FAILED }), { prompt: "task", cwd: "/tmp" }, config);
    await settle();

    expect(notifier).toHaveBeenCalledExactlyOnceWith("claude");
  });
});

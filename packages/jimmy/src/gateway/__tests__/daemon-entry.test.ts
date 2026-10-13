import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// daemon-entry.ts runs on import: it is the whole program of the forked daemon.
// The daemon's stdio is ignored, so a fault that escapes every handler would
// end it without a trace unless the safety net is in place before the gateway
// starts.

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  loadConfig: vi.fn(),
  startForeground: vi.fn(),
  installProcessSafetyNet: vi.fn(),
}));

vi.mock("../../shared/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../lifecycle.js", () => ({ startForeground: mocks.startForeground }));
vi.mock("../../shared/process-safety-net.js", () => ({
  installProcessSafetyNet: mocks.installProcessSafetyNet,
}));

const CONFIG = { gateway: { host: "127.0.0.1", port: 7788 } };

describe("daemon entry", () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mocks.calls.length = 0;
    mocks.loadConfig.mockReset().mockImplementation(() => { mocks.calls.push("config"); return CONFIG; });
    mocks.installProcessSafetyNet.mockReset().mockImplementation(() => { mocks.calls.push("safety-net"); return true; });
    mocks.startForeground.mockReset().mockImplementation(async () => { mocks.calls.push("gateway"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs the safety net before the gateway starts", async () => {
    await import("../daemon-entry.js");

    expect(mocks.calls).toEqual(["config", "safety-net", "gateway"]);
    expect(mocks.startForeground).toHaveBeenCalledWith(CONFIG);
    expect(exit).not.toHaveBeenCalled();
  });

  it("still exits when the gateway fails to boot", async () => {
    mocks.startForeground.mockRejectedValue(new Error("port in use"));

    await import("../daemon-entry.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(exit).toHaveBeenCalledWith(1);
  });
});

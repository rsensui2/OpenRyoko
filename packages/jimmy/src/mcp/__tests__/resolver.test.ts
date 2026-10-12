import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpServers } from "../resolver.js";
import { loadConfig } from "../../shared/config.js";
import type { JinnConfig, McpServerStdioConfig } from "../../shared/types.js";

vi.mock("../../shared/config.js", () => ({ loadConfig: vi.fn() }));

const config = {
  gateway: { enabled: true },
  browser: { enabled: false },
  fetch: { enabled: false },
  search: { enabled: false },
} satisfies JinnConfig["mcp"];

function gatewayEnv(): Record<string, string> {
  const gateway = resolveMcpServers(config, undefined, {}).mcpServers.gateway as McpServerStdioConfig;
  return gateway.env ?? {};
}

describe("resolveMcpServers", () => {
  it("passes current conversation context to the gateway MCP server", () => {
    const resolved = resolveMcpServers(config, undefined, {
      connector: "slack",
      channel: "C123",
      thread: "1700000000.000100",
    });

    const gateway = resolved.mcpServers.gateway as McpServerStdioConfig;
    expect(gateway.env).toMatchObject({
      JINN_CURRENT_CONNECTOR: "slack",
      JINN_CURRENT_CHANNEL: "C123",
      JINN_CURRENT_THREAD: "1700000000.000100",
    });
  });
});

// The built-in gateway MCP server calls back into this instance's gateway. Its
// address was pinned to port 7777 (JINN_PORT, the only override, is set by
// nothing), so on an instance listening anywhere else the agent's tools talked
// to whatever answered on 7777 — another instance, or nothing at all.
describe("resolveMcpServers — gateway MCP server address", () => {
  const saved = { JINN_PORT: process.env.JINN_PORT, RYOKO_GATEWAY_URL: process.env.RYOKO_GATEWAY_URL };

  beforeEach(() => {
    delete process.env.JINN_PORT;
    delete process.env.RYOKO_GATEWAY_URL;
    // No readable config.yaml unless a test provides one.
    vi.mocked(loadConfig).mockReset().mockImplementation(() => { throw new Error("config not found"); });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses the URL the running gateway published for the port it listens on", () => {
    process.env.RYOKO_GATEWAY_URL = "http://127.0.0.1:8899";

    expect(gatewayEnv().JINN_GATEWAY_URL).toBe("http://127.0.0.1:8899");
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("reads gateway.port from config.yaml before the gateway has published its URL", () => {
    vi.mocked(loadConfig).mockReturnValue({ gateway: { host: "127.0.0.1", port: 8123 } } as JinnConfig);

    expect(gatewayEnv().JINN_GATEWAY_URL).toBe("http://127.0.0.1:8123");
  });

  it("never hands out a wildcard bind address as the destination", () => {
    vi.mocked(loadConfig).mockReturnValue({ gateway: { host: "0.0.0.0", port: 8123 } } as JinnConfig);

    // Host: 0.0.0.0 is rejected by the gateway's own Host allowlist (421).
    expect(gatewayEnv().JINN_GATEWAY_URL).toBe("http://127.0.0.1:8123");
  });

  it("still honors JINN_PORT ahead of everything else", () => {
    process.env.JINN_PORT = "9001";
    process.env.RYOKO_GATEWAY_URL = "http://127.0.0.1:8899";

    expect(gatewayEnv().JINN_GATEWAY_URL).toBe("http://127.0.0.1:9001");
  });

  it.each(["", "  ", "abc", "0", "70000", "0x1F", "1e3", "8899; rm -rf /"])("ignores a JINN_PORT that is not a port (%j)", (value) => {
    process.env.JINN_PORT = value;
    process.env.RYOKO_GATEWAY_URL = "http://127.0.0.1:8899";

    expect(gatewayEnv().JINN_GATEWAY_URL).toBe("http://127.0.0.1:8899");
  });

  it.each(["not a url", "file:///etc/passwd", "ftp://127.0.0.1:8899"])("ignores a published value that is not an http URL (%j)", (value) => {
    process.env.RYOKO_GATEWAY_URL = value;
    vi.mocked(loadConfig).mockReturnValue({ gateway: { host: "127.0.0.1", port: 8123 } } as JinnConfig);

    expect(gatewayEnv().JINN_GATEWAY_URL).toBe("http://127.0.0.1:8123");
  });

  it("drops a trailing slash so request paths join cleanly", () => {
    process.env.RYOKO_GATEWAY_URL = "http://127.0.0.1:8899/";

    expect(gatewayEnv().JINN_GATEWAY_URL).toBe("http://127.0.0.1:8899");
  });

  it("falls back to the default port when nothing else is known", () => {
    expect(gatewayEnv().JINN_GATEWAY_URL).toBe("http://127.0.0.1:7777");
  });
});

import { describe, expect, it } from "vitest";
import { gatewayUrlFromConfig, isWildcardBindHost, localGatewayUrl } from "../gateway-url.js";

describe("localGatewayUrl", () => {
  it("collapses a wildcard bind to loopback", () => {
    expect(localGatewayUrl("0.0.0.0", 7777)).toBe("http://127.0.0.1:7777");
    expect(localGatewayUrl("::", 7777)).toBe("http://[::1]:7777");
    expect(localGatewayUrl("[::]", 7777)).toBe("http://[::1]:7777");
  });

  it("keeps a specific bind address as the connect host", () => {
    expect(localGatewayUrl("127.0.0.1", 7777)).toBe("http://127.0.0.1:7777");
    expect(localGatewayUrl("192.168.1.5", 8080)).toBe("http://192.168.1.5:8080");
    expect(localGatewayUrl("ryoko.example.com", 443)).toBe("http://ryoko.example.com:443");
  });

  it("brackets a bare IPv6 address so the result stays a valid URL", () => {
    expect(localGatewayUrl("fd00::1", 7777)).toBe("http://[fd00::1]:7777");
    expect(new URL(localGatewayUrl("fd00::1", 7777)).hostname).toBe("[fd00::1]");
  });

  it("falls back to loopback and the default port", () => {
    expect(localGatewayUrl(undefined, undefined)).toBe("http://127.0.0.1:7777");
    expect(localGatewayUrl("  ", 0)).toBe("http://127.0.0.1:7777");
    expect(gatewayUrlFromConfig(undefined)).toBe("http://127.0.0.1:7777");
    expect(gatewayUrlFromConfig({ gateway: { host: "0.0.0.0", port: 9000 } })).toBe("http://127.0.0.1:9000");
  });

  it("identifies wildcard binds", () => {
    expect(isWildcardBindHost("0.0.0.0")).toBe(true);
    expect(isWildcardBindHost("::")).toBe(true);
    expect(isWildcardBindHost("[::]")).toBe(true);
    expect(isWildcardBindHost("127.0.0.1")).toBe(false);
    expect(isWildcardBindHost(undefined)).toBe(false);
  });
});

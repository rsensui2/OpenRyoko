import { describe, expect, it } from "vitest";
import { buildContext } from "../context.js";

const config = {
  jinn: { version: "2026.8.20" },
  gateway: { host: "0.0.0.0", port: 7777 },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "" },
    codex: { bin: "codex", model: "" },
  },
  connectors: {},
  logging: { level: "info", stdout: false, file: "" },
};

describe("buildContext gateway instructions", () => {
  it("never turns a wildcard bind into a client URL", () => {
    const context = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      config: config as never,
    });

    expect(context).toContain("Gateway: http://127.0.0.1:7777");
    expect(context).not.toContain("http://0.0.0.0:7777");
  });

  it("uses the authenticated CLI helper in delegation examples", () => {
    const context = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      config: config as never,
    });

    expect(context).toContain("ryoko api POST /api/sessions");
    expect(context).toContain("ryoko api GET /api/sessions/<your-session-id>/children");
    expect(context).toContain("adds the instance's bearer token");
  });
});

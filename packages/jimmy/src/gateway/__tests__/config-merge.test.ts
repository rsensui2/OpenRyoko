import { describe, it, expect } from "vitest";
import { deepMerge, sanitizeChannelRouting } from "../api.js";

/**
 * PUT /api/config deep-merges the incoming partial config into the on-disk one
 * before writing. The Settings UI's interactive-PTY toggle relies on this: a
 * partial `{ engines: { claude: { interactive } } }` must set the flag WITHOUT
 * dropping connector secrets or sibling engine fields.
 */
describe("deepMerge (PUT /api/config)", () => {
  const existing = {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", effortLevel: "medium" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    connectors: {
      slack: { botToken: "xoxb-secret", appToken: "xapp-secret", signingSecret: "sig" },
    },
  };

  it("sets engines.claude.interactive while preserving connectors + sibling fields", () => {
    const merged = deepMerge(existing as Record<string, unknown>, {
      engines: { claude: { interactive: true } },
    });
    const m = merged as typeof existing & { engines: { claude: { interactive?: boolean } } };

    expect(m.engines.claude.interactive).toBe(true);
    // sibling claude fields preserved
    expect(m.engines.claude.bin).toBe("claude");
    expect(m.engines.claude.model).toBe("opus");
    expect(m.engines.claude.effortLevel).toBe("medium");
    // other engines preserved
    expect(m.engines.codex.model).toBe("gpt-5.5");
    // connector secrets NOT dropped by a partial engines update
    expect(m.connectors.slack.botToken).toBe("xoxb-secret");
    expect(m.connectors.slack.appToken).toBe("xapp-secret");
  });

  it("flips interactive back to false without touching the rest", () => {
    const on = deepMerge(existing as Record<string, unknown>, { engines: { claude: { interactive: true } } });
    const off = deepMerge(on, { engines: { claude: { interactive: false } } }) as typeof existing & {
      engines: { claude: { interactive?: boolean } };
    };
    expect(off.engines.claude.interactive).toBe(false);
    expect((off as typeof existing).connectors.slack.botToken).toBe("xoxb-secret");
  });

  it("removes an optional key when the update explicitly sends null", () => {
    const withTriageModel = {
      ...existing,
      connectors: {
        slack: {
          ...existing.connectors.slack,
          triage: { enabled: true, engine: "codex", model: "gpt-5-nano" },
        },
      },
    };

    const merged = deepMerge(withTriageModel as Record<string, unknown>, {
      connectors: { slack: { triage: { model: null } } },
    }) as typeof withTriageModel;

    expect(merged.connectors.slack.triage).toEqual({ enabled: true, engine: "codex" });
  });
});

describe("cross-instance token redaction", () => {
  it("masks channelRouting tokens and proxyViaToken for GET /api/config", () => {
    expect(
      sanitizeChannelRouting({
        C1: { url: "http://remote:7777", token: "sekret" },
        C2: "http://other:7777",
      }),
    ).toEqual({
      C1: { url: "http://remote:7777", token: "***" },
      C2: "http://other:7777",
    });
  });

  it("round-trips '***' placeholders through PUT /api/config without losing the stored token", () => {
    const stored = {
      connectors: {
        discord: {
          proxyViaToken: "primary-secret",
          channelRouting: { C1: { url: "http://remote:7777", token: "sekret" } },
        },
      },
    };
    const put = {
      connectors: {
        discord: {
          proxyViaToken: "***",
          channelRouting: { C1: { url: "http://remote:7777", token: "***" } },
        },
      },
    };
    const merged = deepMerge(stored, put) as typeof stored;
    expect(merged.connectors.discord.proxyViaToken).toBe("primary-secret");
    expect(merged.connectors.discord.channelRouting.C1.token).toBe("sekret");
  });
});

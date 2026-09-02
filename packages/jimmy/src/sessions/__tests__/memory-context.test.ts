import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(),
      // paths.ts runs migrateLegacyHome() at module load — never let a
      // per-path existsSync mock reach the real renameSync.
      renameSync: vi.fn(),
    },
  };
});
vi.mock("../../gateway/org.js", () => ({ scanOrg: vi.fn(() => ({ departments: [] })) }));
vi.mock("../../gateway/services.js", () => ({ buildServiceRegistry: vi.fn(() => new Map()) }));
vi.mock("../../jobs/state.js", () => ({ findJobsNeedingAttention: vi.fn(() => []) }));

import fs from "node:fs";
import type { JinnConfig } from "../../shared/types.js";
import { buildMemoryContext, isMemoryEligible, resolveOperatorIdentity } from "../context.js";

const mockReadFileSync = vi.mocked(fs.readFileSync);

const CONFIG = {
  portal: { trustedSpeakers: ["U0AAAAAAA"], operatorName: "太郎" },
} as unknown as JinnConfig;

function setMemoryFile(content: string | null) {
  mockReadFileSync.mockImplementation((p) => {
    if (String(p).endsWith("MEMORY.md")) {
      if (content === null) throw new Error("ENOENT");
      return content;
    }
    throw new Error("ENOENT");
  });
}

describe("isMemoryEligible", () => {
  it("allows web sessions and trusted-ID Slack DMs", () => {
    expect(isMemoryEligible({ source: "web", config: CONFIG })).toBe(true);
    expect(
      isMemoryEligible({ source: "slack", channel: "D0123456", speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBe(true);
  });

  it("denies untrusted DMs, missing speaker IDs, and empty config", () => {
    expect(
      isMemoryEligible({ source: "slack", channel: "D0123456", speakerSlackId: "U0BBBBBBB", config: CONFIG }),
    ).toBe(false);
    expect(isMemoryEligible({ source: "slack", channel: "D0123456", config: CONFIG })).toBe(false);
    expect(
      isMemoryEligible({ source: "slack", channel: "D0123456", speakerSlackId: "U0AAAAAAA", config: undefined }),
    ).toBe(false);
  });

  it("denies SHARED channels even for trusted speakers (session history is reused across participants)", () => {
    expect(
      isMemoryEligible({ source: "slack", channel: "C0123456", speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBe(false);
  });

  it("is keyed on immutable IDs only — a speaker impersonating the operator's display name gains nothing", () => {
    // The gate takes no name inputs at all; an untrusted ID with any display
    // name is still denied.
    expect(
      isMemoryEligible({ source: "slack", channel: "C0123456", speakerSlackId: "U0EVIL0000", config: CONFIG }),
    ).toBe(false);
    expect(
      isMemoryEligible({ source: "slack", channel: "D0123456", speakerSlackId: "U0EVIL0000", config: CONFIG }),
    ).toBe(false);
  });

  it("denies non-Slack sources with DM-looking channels and cron-like sessions", () => {
    expect(
      isMemoryEligible({ source: "telegram", channel: "D0123456", speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBe(false);
    expect(isMemoryEligible({ source: "cron", channel: "cron:daily", config: CONFIG })).toBe(false);
  });

  describe("Discord DMs", () => {
    const DISCORD_CONFIG = {
      portal: { trustedSpeakers: ["U0AAAAAAA", "1543864208750542941"], operatorName: "太郎" },
    } as unknown as JinnConfig;

    it("allows trusted-ID Discord DMs (isDM flag, not channel prefix)", () => {
      expect(
        isMemoryEligible({
          source: "discord",
          channel: "9990001112223334445",
          speakerDiscordId: "1543864208750542941",
          isDM: true,
          config: DISCORD_CONFIG,
        }),
      ).toBe(true);
    });

    it("ignores non-string trustedSpeakers entries — an unquoted snowflake has already lost precision", () => {
      const numeric = {
        portal: { trustedSpeakers: [1543864208750542941] },
      } as unknown as JinnConfig;
      // Even the value that WOULD result from stringifying the mangled number
      // must not open the gate: numbers are rejected outright.
      expect(
        isMemoryEligible({
          source: "discord",
          speakerDiscordId: String(1543864208750542941),
          isDM: true,
          config: numeric,
        }),
      ).toBe(false);
    });

    it("denies Discord group DMs even for trusted IDs (1:1 only, mirroring Slack im/mpim)", () => {
      expect(
        isMemoryEligible({
          source: "discord",
          speakerDiscordId: "1543864208750542941",
          isDM: true,
          isGroupDM: true,
          config: DISCORD_CONFIG,
        }),
      ).toBe(false);
    });

    it("denies Discord guild channels, untrusted IDs, and missing isDM", () => {
      expect(
        isMemoryEligible({
          source: "discord",
          speakerDiscordId: "1543864208750542941",
          isDM: false,
          config: DISCORD_CONFIG,
        }),
      ).toBe(false);
      expect(
        isMemoryEligible({ source: "discord", speakerDiscordId: "42", isDM: true, config: DISCORD_CONFIG }),
      ).toBe(false);
      expect(
        isMemoryEligible({ source: "discord", speakerDiscordId: "1543864208750542941", config: DISCORD_CONFIG }),
      ).toBe(false);
    });
  });
});

describe("resolveOperatorIdentity", () => {
  const STRICT = {
    portal: { operatorName: "太郎", operatorSlackId: "U0OPERATOR" },
  } as unknown as JinnConfig;

  it("with operatorSlackId configured, only the exact ID is the operator — name spoofing gains nothing", () => {
    expect(
      resolveOperatorIdentity({ speakerNames: ["太郎"], speakerSlackId: "U0EVIL0000", operatorName: "太郎", config: STRICT }),
    ).toEqual({ speakerIsOperator: false, operatorIdVerified: false });
    expect(
      resolveOperatorIdentity({ speakerNames: ["別名"], speakerSlackId: "U0OPERATOR", operatorName: "太郎", config: STRICT }),
    ).toEqual({ speakerIsOperator: true, operatorIdVerified: true });
  });

  it("without operatorSlackId, name matching still works but is reported as unverified", () => {
    const r = resolveOperatorIdentity({ speakerNames: ["太郎"], operatorName: "太郎", config: CONFIG });
    expect(r.speakerIsOperator).toBe(true);
    expect(r.operatorIdVerified).toBe(false);
  });

  describe("operatorDiscordId", () => {
    const BOTH = {
      portal: {
        operatorName: "太郎",
        operatorSlackId: "U0OPERATOR",
        operatorDiscordId: "1543864208750542941",
      },
    } as unknown as JinnConfig;

    it("verifies a Discord speaker by exact snowflake equality", () => {
      expect(
        resolveOperatorIdentity({
          speakerNames: ["rsensui_18737"],
          speakerDiscordId: "1543864208750542941",
          operatorName: "太郎",
          config: BOTH,
        }),
      ).toEqual({ speakerIsOperator: true, operatorIdVerified: true });
      expect(
        resolveOperatorIdentity({
          speakerNames: ["太郎"],
          speakerDiscordId: "42",
          operatorName: "太郎",
          config: BOTH,
        }),
      ).toEqual({ speakerIsOperator: false, operatorIdVerified: false });
    });

    it("fails closed for a platform with no configured operator ID", () => {
      const slackOnly = {
        portal: { operatorName: "太郎", operatorSlackId: "U0OPERATOR" },
      } as unknown as JinnConfig;
      // Discord speaker named exactly like the operator, but Slack-only strict
      // config: never the operator (configure operatorDiscordId instead).
      expect(
        resolveOperatorIdentity({
          speakerNames: ["太郎"],
          speakerDiscordId: "1543864208750542941",
          operatorName: "太郎",
          config: slackOnly,
        }),
      ).toEqual({ speakerIsOperator: false, operatorIdVerified: false });
      const discordOnly = {
        portal: { operatorName: "太郎", operatorDiscordId: "1543864208750542941" },
      } as unknown as JinnConfig;
      expect(
        resolveOperatorIdentity({
          speakerNames: ["太郎"],
          speakerSlackId: "U0OPERATOR",
          operatorName: "太郎",
          config: discordOnly,
        }),
      ).toEqual({ speakerIsOperator: false, operatorIdVerified: false });
    });

    it("ignores a YAML-numeric operatorDiscordId but keeps strict mode engaged", () => {
      const numeric = {
        portal: { operatorName: "太郎", operatorDiscordId: 12345678901234 },
      } as unknown as JinnConfig;
      // The mangled value can never match…
      expect(
        resolveOperatorIdentity({
          speakerNames: [],
          speakerDiscordId: "12345678901234",
          operatorName: "太郎",
          config: numeric,
        }),
      ).toEqual({ speakerIsOperator: false, operatorIdVerified: false });
      // …and the config mistake must NOT degrade to name matching — that
      // would reopen the spoofing hole strict mode exists to close.
      expect(
        resolveOperatorIdentity({
          speakerNames: ["太郎"],
          operatorName: "太郎",
          config: numeric,
        }),
      ).toEqual({ speakerIsOperator: false, operatorIdVerified: false });
    });

    it("binds verification to the platform the message came from", () => {
      // A Slack operator ID smuggled into a Discord-source payload must not
      // verify, and vice versa. Without a source, both platforms remain
      // eligible (backward compatibility for callers that can't know).
      expect(
        resolveOperatorIdentity({
          speakerNames: [],
          speakerSlackId: "U0OPERATOR",
          source: "discord",
          operatorName: "太郎",
          config: BOTH,
        }),
      ).toEqual({ speakerIsOperator: false, operatorIdVerified: false });
      expect(
        resolveOperatorIdentity({
          speakerNames: [],
          speakerDiscordId: "1543864208750542941",
          source: "slack",
          operatorName: "太郎",
          config: BOTH,
        }),
      ).toEqual({ speakerIsOperator: false, operatorIdVerified: false });
      expect(
        resolveOperatorIdentity({
          speakerNames: [],
          speakerDiscordId: "1543864208750542941",
          source: "discord",
          operatorName: "太郎",
          config: BOTH,
        }),
      ).toEqual({ speakerIsOperator: true, operatorIdVerified: true });
    });

    it("either configured platform ID verifies its own platform's speaker", () => {
      expect(
        resolveOperatorIdentity({
          speakerNames: [],
          speakerSlackId: "U0OPERATOR",
          operatorName: "太郎",
          config: BOTH,
        }),
      ).toEqual({ speakerIsOperator: true, operatorIdVerified: true });
    });
  });
});

describe("buildMemoryContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects MEMORY.md for an eligible session, with the privacy instruction", () => {
    setMemoryFile("## Facts\n- オーナーはA社の代表");
    const out = buildMemoryContext({ source: "web", config: CONFIG });
    expect(out).toContain("オーナーはA社の代表");
    expect(out).toContain("Never reveal");
  });

  it("returns null for ineligible sessions even when MEMORY.md exists", () => {
    setMemoryFile("secret facts");
    expect(
      buildMemoryContext({ source: "slack", channel: "C0123456", speakerSlackId: "U0AAAAAAA", config: CONFIG }),
    ).toBeNull();
  });

  it("returns null when MEMORY.md is missing or empty", () => {
    setMemoryFile(null);
    expect(buildMemoryContext({ source: "web", config: CONFIG })).toBeNull();
    setMemoryFile("   \n  ");
    expect(buildMemoryContext({ source: "web", config: CONFIG })).toBeNull();
  });

  it("caps oversized MEMORY.md by UTF-8 BYTES (Japanese text cannot balloon the prompt)", () => {
    // 12,000 Japanese chars ≈ 36,000 bytes — over the 24,000B cap while being
    // well under it in JS string length.
    setMemoryFile("あ".repeat(12_000));
    const out = buildMemoryContext({ source: "web", config: CONFIG });
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out!, "utf-8")).toBeLessThan(25_000);
    expect(out).toContain("exceeds the injection cap");
    expect(out).not.toContain("�");
  });
});

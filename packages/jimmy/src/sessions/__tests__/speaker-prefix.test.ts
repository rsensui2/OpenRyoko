import { describe, it, expect } from "vitest";
import { buildSpeakerPrefix } from "../speaker-prefix.js";
import type { JinnConfig } from "../../shared/types.js";

// The production incident this guards against: in a multi-user Slack thread,
// non-operator speakers (榎本さん / 大谷内さん) were repeatedly addressed as the
// operator ("亮介") because no per-turn speaker signal reached the model. The
// `[Speaker: …]` prefix fixes that; these tests lock the behavior in — the
// exact identity path had no unit coverage before.

describe("buildSpeakerPrefix", () => {
  const operator = "亮介";
  const operatorAliases = ["泉水亮介", "Ryosuke Sensui", "rsensui"];
  const context = {
    source: "slack",
    operatorName: operator,
    config: { portal: { operatorAliases } } as JinnConfig,
  };

  it("tags a non-operator speaker with an explicit do-not-address warning", () => {
    const prefix = buildSpeakerPrefix(
      { speakerName: "榎本結花里", channelType: "channel" },
      context,
    );
    expect(prefix).toBe(
      `[Speaker: 榎本結花里 — NOT the operator; do not address this person as "亮介"]`,
    );
  });

  it("recognizes the operator (via alias) and marks them as such", () => {
    const prefix = buildSpeakerPrefix(
      { speakerName: "rsensui", speakerRealName: "泉水亮介", channelType: "channel" },
      context,
    );
    expect(prefix).toBe("[Speaker: rsensui (the operator)]");
  });

  // The residual gap this PR closes: Slack sets speakerName from the legacy
  // `users.name`, which can be null while real/display names are present. The
  // old code only read speakerName, silently skipped attribution, and let the
  // operator-default misattribution return.
  it("falls back to realName when speakerName is missing", () => {
    const prefix = buildSpeakerPrefix(
      { speakerName: null, speakerRealName: "大谷内隆輔", channelType: "channel" },
      context,
    );
    expect(prefix).toBe(
      `[Speaker: 大谷内隆輔 — NOT the operator; do not address this person as "亮介"]`,
    );
  });

  it("falls back to displayName, then handle, in order", () => {
    expect(
      buildSpeakerPrefix(
        { speakerName: "", speakerRealName: "  ", speakerDisplayName: "Yuka", channelType: "channel" },
        context,
      ),
    ).toBe(`[Speaker: Yuka — NOT the operator; do not address this person as "亮介"]`);

    expect(
      buildSpeakerPrefix(
        { speakerHandle: "yuka.e", channelType: "channel" },
        context,
      ),
    ).toBe(`[Speaker: yuka.e — NOT the operator; do not address this person as "亮介"]`);
  });

  it("returns null for 1:1 IM channels (unambiguous, no attribution needed)", () => {
    expect(
      buildSpeakerPrefix({ speakerName: "榎本結花里", channelType: "im" }, context),
    ).toBeNull();
  });

  it("omits attribution for Discord DMs identified by isDM", () => {
    expect(
      buildSpeakerPrefix(
        { speakerDisplayName: "Yuka", isDM: true },
        { ...context, source: "discord" },
      ),
    ).toBeNull();
  });

  it.each([
    { source: "slack", idKey: "speakerSlackId", operatorKey: "operatorSlackId", id: "U0OPERATOR" },
    { source: "discord", idKey: "speakerDiscordId", operatorKey: "operatorDiscordId", id: "1543864208750542941" },
  ])("preserves strict $source ID verification when the name falls back", ({ source, idKey, operatorKey, id }) => {
    const strict = {
      ...context,
      source,
      config: { portal: { [operatorKey]: id, operatorAliases } } as unknown as JinnConfig,
    };
    expect(
      buildSpeakerPrefix({ speakerDisplayName: "別名", [idKey]: id }, strict),
    ).toBe("[Speaker: 別名 (the operator)]");
    expect(
      buildSpeakerPrefix({ speakerDisplayName: operator, [idKey]: "someone-else" }, strict),
    ).toBe(`[Speaker: ${operator} — NOT the operator; do not address this person as "${operator}"]`);
    expect(
      buildSpeakerPrefix({ speakerDisplayName: operator }, strict),
    ).toBe(`[Speaker: ${operator} — NOT the operator; do not address this person as "${operator}"]`);
  });

  it("does not verify an ID carried from a different transport", () => {
    expect(
      buildSpeakerPrefix(
        { speakerRealName: operator, speakerSlackId: "U0OPERATOR" },
        {
          ...context,
          source: "discord",
          config: { portal: { operatorSlackId: "U0OPERATOR", operatorAliases } } as JinnConfig,
        },
      ),
    ).toBe(`[Speaker: ${operator} — NOT the operator; do not address this person as "${operator}"]`);
  });

  it("returns null when no identifiable name is present", () => {
    expect(buildSpeakerPrefix({ channelType: "channel" }, context)).toBeNull();
    expect(
      buildSpeakerPrefix(
        { speakerName: null, speakerRealName: "", speakerDisplayName: "   " },
        context,
      ),
    ).toBeNull();
  });

  it("omits the operator tag when no operator is configured", () => {
    expect(buildSpeakerPrefix({ speakerName: "榎本結花里", channelType: "channel" }, { source: "slack" })).toBe(
      "[Speaker: 榎本結花里]",
    );
  });

  it("sanitizes brackets/newlines and caps the name length", () => {
    const prefix = buildSpeakerPrefix(
      { speakerName: "a]b[c\nd", channelType: "channel" },
      context,
    );
    expect(prefix).toBe(`[Speaker: abcd — NOT the operator; do not address this person as "亮介"]`);

    const long = "あ".repeat(80);
    const prefix2 = buildSpeakerPrefix({ speakerName: long, channelType: "channel" }, { source: "slack" });
    expect(prefix2).toBe(`[Speaker: ${"あ".repeat(60)}]`);
  });
});

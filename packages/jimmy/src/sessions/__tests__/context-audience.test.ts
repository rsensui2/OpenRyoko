import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { JINN_HOME } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { audienceFromTransportMeta, audienceOfSession, isExternalAudience, isUntrustedSpeaker } from "../audience.js";
import { buildContext, buildEvolutionContext } from "../context.js";

// vitest.global-setup.ts and vitest.setup.ts isolate the instance home per test
// file. A memory file marks it as an onboarded instance (steady state).
beforeAll(() => {
  fs.mkdirSync(JINN_HOME, { recursive: true });
  fs.writeFileSync(path.join(JINN_HOME, "MEMORY.md"), "# MEMORY\n");
});

const trustConfig = {
  // The operator lists their own ID among the trusted speakers too; that is what makes their DM memory-eligible.
  portal: { trustedSpeakers: ["UOPERATOR", "UTRUSTED", "123456789012345678"], operatorSlackId: "UOPERATOR", operatorName: "太郎" },
  engines: {},
  gateway: { port: 7777 },
  connectors: { slack: { appToken: "xapp-test", botToken: "xoxb-test" } },
} as unknown as JinnConfig;
// The opening of the text an external conversation gets. The ordinary guidance mentions outsiders too,
// so a shorter phrase would not tell the two apart.
const OUTSIDER_NOTICE = "This conversation includes someone outside the trusted speakers";
const noTrustConfig = { portal: {}, engines: {}, gateway: { port: 7777 } } as unknown as JinnConfig;

describe("isExternalAudience", () => {
  it("is false where nobody outside the instance is speaking", () => {
    for (const source of ["web", "cron", "workflow"]) {
      expect(isExternalAudience({ source, config: trustConfig })).toBe(false);
    }
  });

  it("follows the speaker's platform ID once ID-based trust is configured", () => {
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UTRUSTED", config: trustConfig })).toBe(false);
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UOPERATOR", config: trustConfig })).toBe(false);
    expect(isExternalAudience({ source: "slack", speakerSlackId: "USTRANGER", config: trustConfig })).toBe(true);
    expect(isExternalAudience({ source: "slack", config: trustConfig })).toBe(true);
    expect(isExternalAudience({ source: "discord", speakerDiscordId: "123456789012345678", config: trustConfig })).toBe(false);
    expect(isExternalAudience({ source: "discord", speakerDiscordId: "999", config: trustConfig })).toBe(true);
  });

  it("does not accept an ID from the other platform", () => {
    expect(isExternalAudience({ source: "discord", speakerSlackId: "UTRUSTED", config: trustConfig })).toBe(true);
    expect(isExternalAudience({ source: "slack", speakerDiscordId: "123456789012345678", config: trustConfig })).toBe(true);
  });

  it("treats a channel shared beyond the workspace as external whoever speaks", () => {
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UTRUSTED", channelExternal: true, config: trustConfig })).toBe(true);
  });

  it("keeps a thread external once an untrusted speaker has taken part in it", () => {
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UTRUSTED", externalSpeakerSeen: true, config: trustConfig })).toBe(true);
    expect(isUntrustedSpeaker({ source: "slack", speakerSlackId: "UTRUSTED", config: trustConfig })).toBe(false);
  });

  it("lets the current speaker alone decide in a one-to-one direct message", () => {
    const dm = { source: "slack", channel: "D1", config: trustConfig } as const;
    // Nobody else is in it: a mark left on the session (the ID was mistyped when an earlier
    // message arrived, a channel lookup failed) says nothing the speaker's ID does not.
    expect(isExternalAudience({ ...dm, speakerSlackId: "UTRUSTED", externalSpeakerSeen: true, channelExternal: true })).toBe(false);
    expect(isExternalAudience({ ...dm, speakerSlackId: "USTRANGER" })).toBe(true);
    expect(isExternalAudience({ ...dm })).toBe(true);
    const discord = { source: "discord", isDM: true, speakerDiscordId: "123456789012345678", externalSpeakerSeen: true, config: trustConfig } as const;
    expect(isExternalAudience(discord)).toBe(false);
    // A group DM and a private channel have other people in them.
    expect(isExternalAudience({ ...discord, isGroupDM: true })).toBe(true);
    expect(isExternalAudience({ ...dm, channel: "G1", speakerSlackId: "UTRUSTED", externalSpeakerSeen: true })).toBe(true);
    // A caller that holds no raw channel ID says so itself.
    expect(isExternalAudience({ ...dm, channel: "slack:D1", speakerSlackId: "UTRUSTED", externalSpeakerSeen: true })).toBe(true);
    expect(isExternalAudience({ ...dm, channel: "slack:D1", oneToOneDm: true, speakerSlackId: "UTRUSTED", externalSpeakerSeen: true })).toBe(false);
  });

  it("tells a stored one-to-one direct message from a channel", () => {
    const meta = { speakerSlackId: "U1", externalSpeakerSeen: true };
    expect(audienceOfSession({ source: "slack", transportMeta: meta, replyContext: { channel: "D1" } })).toEqual({
      speakerSlackId: "U1", speakerDiscordId: undefined, channelExternal: false, externalSpeakerSeen: true, oneToOneDm: true,
    });
    expect(audienceOfSession({ source: "slack", transportMeta: meta, replyContext: { channel: "C1" } }).oneToOneDm).toBe(false);
    expect(audienceOfSession({ source: "discord", transportMeta: { isDM: true }, replyContext: { channel: "42" } }).oneToOneDm).toBe(true);
    expect(audienceOfSession({ source: "discord", transportMeta: { isDM: true, isGroupDM: true } }).oneToOneDm).toBe(false);
    expect(audienceOfSession({ source: "web", transportMeta: null, replyContext: null }).oneToOneDm).toBe(false);
    expect(audienceOfSession({ source: "slack", transportMeta: meta, replyContext: null }).oneToOneDm).toBe(false);
  });

  it("has nothing to compare against when no IDs are configured, so it stays out of the way", () => {
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UANYONE", config: noTrustConfig })).toBe(false);
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UANYONE" })).toBe(false);
    // Also when the connector could not tell whether the channel is shared (it reports that as external).
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UANYONE", channelExternal: true, config: noTrustConfig })).toBe(false);
  });

  it("takes an operator key left empty as not set", () => {
    // The settings page leaves an empty string behind when its field is cleared; a bare YAML key reads as null.
    for (const blank of ["", "   ", null]) {
      const cleared = { portal: { operatorSlackId: blank, operatorDiscordId: blank, trustedSpeakers: [] } } as unknown as JinnConfig;
      expect(isExternalAudience({ source: "slack", speakerSlackId: "UANYONE", config: cleared }), JSON.stringify(blank)).toBe(false);
      expect(isExternalAudience({ source: "discord", speakerDiscordId: "42", channelExternal: true, config: cleared })).toBe(false);
    }
    // A trusted speaker beside the blank still makes it an instance with ID-based trust.
    const mixed = { portal: { operatorSlackId: "", trustedSpeakers: ["UTRUSTED"] } } as unknown as JinnConfig;
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UANYONE", config: mixed })).toBe(true);
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UTRUSTED", config: mixed })).toBe(false);
  });

  it("fails closed when an ID is configured but unusable, instead of trusting everyone", () => {
    const unquoted = { portal: { operatorDiscordId: 987654321098765400 } } as unknown as JinnConfig;
    expect(isExternalAudience({ source: "discord", speakerDiscordId: "987654321098765400", config: unquoted })).toBe(true);
    const numbersOnly = { portal: { trustedSpeakers: [123456789012345680] } } as unknown as JinnConfig;
    expect(isExternalAudience({ source: "slack", speakerSlackId: "UANYONE", config: numbersOnly })).toBe(true);
  });

  it("reads the same fields back from a stored session", () => {
    expect(audienceFromTransportMeta({ speakerSlackId: "U1", channelExternal: true, externalSpeakerSeen: true })).toEqual({
      speakerSlackId: "U1", speakerDiscordId: undefined, channelExternal: true, externalSpeakerSeen: true,
    });
    expect(audienceFromTransportMeta(null)).toEqual({
      speakerSlackId: undefined, speakerDiscordId: undefined, channelExternal: false, externalSpeakerSeen: false,
    });
  });

  it("leaves connectors without ID-based trust alone", () => {
    expect(isExternalAudience({ source: "telegram", config: trustConfig })).toBe(false);
  });
});

describe("buildEvolutionContext", () => {
  it("says what memory is for and how to keep a note trustworthy", () => {
    const out = buildEvolutionContext("Ryoko", trustConfig);
    expect(out).toContain("could not find out on its own");
    expect(out).toContain("how you know it");
    expect(out).toContain("MEMORY.md");
    expect(out).toContain("knowledge/<topic>.md");
    // MEMORY.md is injected for the operator only; saying "every session" sends
    // rules meant for scheduled jobs or shared channels to a file they never see.
    expect(out).not.toContain("read every session");
  });

  it("tells a conversation with an outsider to leave long-term memory alone", () => {
    const out = buildEvolutionContext("Ryoko", trustConfig, { externalAudience: true });
    expect(out).toContain("## Self-evolution");
    expect(out).toContain(OUTSIDER_NOTICE);
    expect(out).toContain("do not create or change anything");
    // The record can be removed (a reset, a deleted session): no promise that it is kept.
    expect(out).toContain("for as long as the session exists");
    expect(out).not.toContain("You learn and evolve");
    expect(out).not.toContain("Agents View Canvas");
  });

  it("does not hand onboarding to an outsider", () => {
    const bootstrap = path.join(JINN_HOME, "BOOTSTRAP.md");
    fs.writeFileSync(bootstrap, "# first run\n");
    try {
      expect(buildEvolutionContext("Ryoko", trustConfig)).toContain("ONBOARDING MODE");
      const out = buildEvolutionContext("Ryoko", trustConfig, { externalAudience: true });
      expect(out).toContain(OUTSIDER_NOTICE);
      expect(out).not.toContain("ONBOARDING MODE");
    } finally {
      fs.rmSync(bootstrap);
    }
  });

  it("offers the canvas hint only where the operator is present", () => {
    expect(buildEvolutionContext("Ryoko", trustConfig)).not.toContain("Agents View Canvas");
    expect(buildEvolutionContext("Ryoko", trustConfig, { operatorPresent: true })).toContain("Agents View Canvas");
  });
});

describe("buildContext by audience", () => {
  const base = { channel: "C1", user: "someone", config: trustConfig } as const;

  it("gives the operator's own session the history search and the canvas hint", () => {
    const out = buildContext({ ...base, source: "web", channel: "web" });
    expect(out).toContain("/api/search/messages");
    // The turns around a hit come from the message window, not from the session's last N.
    expect(out).toContain("/messages?around=<messageId>");
    expect(out).toContain("Agents View Canvas");
  });

  it("gives a scheduled job the history search but not the canvas hint", () => {
    const out = buildContext({ ...base, source: "cron", channel: "nightly" });
    expect(out).toContain("/api/search/messages");
    expect(out).toContain("could not find out on its own");
    expect(out).not.toContain("Agents View Canvas");
  });

  it("keeps a trusted speaker's shared-channel thread writing memory, without advertising private history", () => {
    const out = buildContext({ ...base, source: "slack", speakerName: "同僚", speakerSlackId: "UTRUSTED" });
    expect(out).toContain("could not find out on its own");
    expect(out).not.toContain("/api/search/messages");
  });

  it("restricts a stranger's conversation", () => {
    const out = buildContext({ ...base, source: "slack", speakerName: "顧客", speakerSlackId: "USTRANGER" });
    expect(out).toContain(OUTSIDER_NOTICE);
    expect(out).not.toContain("/api/search/messages");
    expect(out).not.toContain("could not find out on its own");
  });

  it("restricts a trusted speaker's thread in a channel shared beyond the workspace", () => {
    const out = buildContext({ ...base, source: "slack", speakerSlackId: "UTRUSTED", channelExternal: true });
    expect(out).toContain(OUTSIDER_NOTICE);
  });

  it("restricts a trusted speaker's message in a thread an outsider already spoke in", () => {
    const out = buildContext({ ...base, source: "slack", speakerSlackId: "UTRUSTED", externalSpeakerSeen: true });
    expect(out).toContain(OUTSIDER_NOTICE);
    expect(out).not.toContain("/api/search/messages");
  });

  it("treats the operator's direct message by who is speaking now, whatever the session recorded earlier", () => {
    const out = buildContext({ ...base, source: "slack", channel: "D1", speakerSlackId: "UOPERATOR", externalSpeakerSeen: true, channelExternal: true });
    expect(out).not.toContain(OUTSIDER_NOTICE);
    expect(out).toContain("could not find out on its own");
    // The same session reached through a runner that has no raw channel ID.
    const woken = buildContext({ ...base, source: "slack", channel: "slack:D1", oneToOneDm: true, speakerSlackId: "UOPERATOR", externalSpeakerSeen: true });
    expect(woken).not.toContain(OUTSIDER_NOTICE);
    // Knowing it is a direct message never opens the memory gate by itself.
    expect(woken).not.toContain("## Long-term memory");
  });

  it("points out the history search in the operator's own direct message, not in another trusted speaker's", () => {
    const dm = { ...base, source: "slack", channel: "D1" } as const;
    expect(buildContext({ ...dm, speakerSlackId: "UOPERATOR" })).toContain("/api/search/messages");
    expect(buildContext({ ...dm, speakerSlackId: "UTRUSTED" })).not.toContain("/api/search/messages");
  });

  it("keeps the outsider boundary when the prompt has to be cut down to size", () => {
    const tight = { ...trustConfig, context: { maxChars: 2000 } } as unknown as JinnConfig;
    const out = buildContext({ ...base, config: tight, source: "slack", speakerSlackId: "USTRANGER" });
    expect(out).toContain("do not create or change anything");
  });
});

import { describe, it, expect } from "vitest";
import { RemoteDiscordConnector } from "../remote.js";
import type { DiscordRespondToConfig, IncomingMessage } from "../../../shared/types.js";

function incoming(
  transportMeta: Record<string, unknown> | undefined,
  thread?: string,
): IncomingMessage {
  return {
    connector: "discord",
    source: "discord",
    sessionKey: "discord:C1",
    channel: "C1",
    thread,
    user: "user",
    userId: "U1",
    text: "hello",
    messageId: "M1",
    attachments: [],
    replyContext: {},
    transportMeta,
  } as unknown as IncomingMessage;
}

function deliver(
  respondTo: DiscordRespondToConfig | undefined,
  msg: IncomingMessage,
): IncomingMessage[] {
  const connector = new RemoteDiscordConnector({ proxyVia: "http://127.0.0.1:1", respondTo });
  const received: IncomingMessage[] = [];
  connector.onMessage((m) => received.push(m));
  connector.deliverMessage(msg);
  return received;
}

describe("RemoteDiscordConnector.deliverMessage respondTo gating", () => {
  it("delivers everything with respondTo unset and no addressing metadata (older primary)", () => {
    expect(deliver(undefined, incoming(undefined))).toHaveLength(1);
    expect(deliver(undefined, incoming({ isDM: false }))).toHaveLength(1);
  });

  it("drops channel messages addressed to somebody else, even with respondTo unset", () => {
    expect(deliver(undefined, incoming({ isDM: false, addressesOnlyOthers: true }))).toHaveLength(0);
  });

  it("does not apply the sibling rule in DMs", () => {
    expect(deliver(undefined, incoming({ isDM: true, addressesOnlyOthers: true }))).toHaveLength(1);
  });

  it("drops un-addressed channel messages under channel=mention (fail closed on missing metadata)", () => {
    const respondTo: DiscordRespondToConfig = { channel: "mention" };
    expect(deliver(respondTo, incoming({ isDM: false, wasBotAddressed: false }))).toHaveLength(0);
    expect(deliver(respondTo, incoming(undefined))).toHaveLength(0);
  });

  it("delivers addressed channel messages under channel=mention", () => {
    const respondTo: DiscordRespondToConfig = { channel: "mention" };
    expect(deliver(respondTo, incoming({ isDM: false, wasBotAddressed: true }))).toHaveLength(1);
  });

  it("trusts the primary's engaged-thread flag for the mention continuation", () => {
    const respondTo: DiscordRespondToConfig = { channel: "mention" };
    const engaged = incoming(
      { isDM: false, wasBotAddressed: false, isEngagedThread: true },
      "T1",
    );
    const notEngaged = incoming({ isDM: false, wasBotAddressed: false }, "T1");
    expect(deliver(respondTo, engaged)).toHaveLength(1);
    expect(deliver(respondTo, notEngaged)).toHaveLength(0);
  });

  it("ignores the engaged-thread flag when engagedThreads=false", () => {
    const respondTo: DiscordRespondToConfig = { channel: "mention", engagedThreads: false };
    const engaged = incoming(
      { isDM: false, wasBotAddressed: false, isEngagedThread: true },
      "T1",
    );
    expect(deliver(respondTo, engaged)).toHaveLength(0);
  });

  it("silences a scope entirely under never", () => {
    const respondTo: DiscordRespondToConfig = { channel: "never" };
    expect(deliver(respondTo, incoming({ isDM: false, wasBotAddressed: true }))).toHaveLength(0);
  });
});

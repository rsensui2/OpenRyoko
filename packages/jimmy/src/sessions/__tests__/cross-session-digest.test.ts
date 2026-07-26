import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// paths.ts resolves the home once at import time, so the temp home has to be in
// place before the registry module is pulled in.
const HOME = mkdtempSync(path.join(tmpdir(), "ryoko-digest-"));
process.env.RYOKO_HOME = HOME;

type Registry = typeof import("../registry.js");
let registry: Registry;

const CHANNEL_A = "slack:C_ESCALATION:1785064115.218349";
const CHANNEL_B = "slack:C_EXTERNAL:1785064053.883769";
const DM = "slack:dm:U019S4U3TL4";
const CRON = "cron:human-pending-replies:1785060010461";

function seed(sourceRef: string, reply: string): string {
  const session = registry.createSession({
    engine: "claude",
    source: sourceRef.split(":")[0],
    sourceRef,
    transportMeta: { channelName: sourceRef.split(":")[1] },
  } as Parameters<Registry["createSession"]>[0]);
  registry.insertMessage(session.id, "user", "…");
  registry.insertMessage(session.id, "assistant", reply);
  return session.id;
}

describe("getRecentRepliesAcrossSessions", () => {
  let escalationSessionId: string;

  beforeAll(async () => {
    registry = await import("../registry.js");
    escalationSessionId = seed(CHANNEL_A, "投稿完了したよ。PDF5冊を #external に納品した");
    seed(CHANNEL_B, "西田さん、ありがとうございます");
    seed(DM, "亮介への個人的な連絡");
    seed(CRON, "対象0件のため投稿なし");
  });

  const recent = (extra: Partial<Parameters<Registry["getRecentRepliesAcrossSessions"]>[0]> = {}) =>
    registry.getRecentRepliesAcrossSessions({
      sinceMs: Date.now() - 60 * 60 * 1000,
      limit: 50,
      ...extra,
    });

  it("surfaces work done by a sibling session in another channel", () => {
    const refs = recent({ excludeSessionId: "some-other-session" }).map((r) => r.sourceRef);
    expect(refs).toContain(CHANNEL_A);
    expect(refs).toContain(CHANNEL_B);
  });

  it("excludes cron bookkeeping so real exchanges are not crowded out", () => {
    expect(recent().map((r) => r.sourceRef)).not.toContain(CRON);
  });

  it("excludes the calling session's own replies", () => {
    const refs = recent({ excludeSessionId: escalationSessionId }).map((r) => r.sourceRef);
    expect(refs).not.toContain(CHANNEL_A);
    expect(refs).toContain(CHANNEL_B);
  });

  it("keeps direct messages out of prompts built for untrusted speakers", () => {
    expect(recent({ excludeDirectMessages: true }).map((r) => r.sourceRef)).not.toContain(DM);
    expect(recent({ excludeDirectMessages: false }).map((r) => r.sourceRef)).toContain(DM);
  });

  it("returns replies oldest-first so the digest reads as a timeline", () => {
    const stamps = recent().map((r) => r.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });
});

import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// paths.ts resolves the home once at import time, so the temp home has to be in
// place before the context module (and the registry it pulls in) is imported.
const HOME = mkdtempSync(path.join(tmpdir(), "ryoko-longrun-"));
process.env.RYOKO_HOME = HOME;

type Context = typeof import("../context.js");
let context: Context;

beforeAll(async () => {
  context = await import("../context.js");
});

const build = (extra: Partial<Parameters<Context["buildContext"]>[0]> = {}) =>
  context.buildContext({
    source: "slack",
    channel: "C_TEST",
    user: "U_TEST",
    ...extra,
  });

describe("long-running work section", () => {
  it("warns that background tasks do not survive the turn", () => {
    const prompt = build();
    expect(prompt).toContain("## Long-running work");
    expect(prompt).toContain("Background tasks do NOT survive the end of a turn");
  });

  it("gives a concrete way to detach work that outlives the turn", () => {
    expect(build()).toContain("setsid nohup");
  });

  it("is present for employees too, not just the COO", () => {
    const prompt = build({
      employee: {
        name: "tako",
        displayName: "タコ",
        persona: "advisor",
        department: "advisory",
        rank: "senior",
      } as Parameters<Context["buildContext"]>[0]["employee"],
    });
    expect(prompt).toContain("## Long-running work");
  });

  it("keeps the warning when the budget forces every trimmable section to its summary", () => {
    // maxChars=1 drives trimContext through the full OPTIONAL → STANDARD pass,
    // so the section survives only if its summary carries the warning too.
    const prompt = build({
      config: {
        gateway: { host: "127.0.0.1", port: 7777 },
        engines: { default: "claude" },
        context: { maxChars: 1 },
      } as Parameters<Context["buildContext"]>[0]["config"],
    });
    expect(prompt).toContain("## Long-running work");
    expect(prompt).toContain("killed when the turn ends");
  });
});

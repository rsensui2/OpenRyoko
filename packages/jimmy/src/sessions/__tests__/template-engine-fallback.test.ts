import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reprobeAtMs, type EngineHealthState } from "../../shared/engine-health.js";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { MAX_USAGE_LIMIT_WAIT_MS } from "../../shared/rateLimit.js";
import { LOGIN_REFUSAL_HOLD_MS } from "../engine-login.js";
import { RESTART_LIMIT_RESET_BUFFER_MS } from "../restart-resume.js";

// How long a turn waits for a usage limit, how long a conversation stays on its
// fallback engine, and where a new session starts while an engine is out are
// decided in the session layer. An agent asked to configure fallback reads them
// in the config skill's reference, and an operator in docs/engine-fallback.md.
// Both described the behaviour of two releases ago. These hold the numbers in
// them to the constants the gateway uses.

const REPO = path.resolve(TEMPLATE_DIR, "..", "..", "..");
const reference = (): string => fs.readFileSync(path.join(TEMPLATE_DIR, "skills", "openryoko-config", "references", "engine-fallback.md"), "utf-8");
const rootDoc = (): string => fs.readFileSync(path.join(REPO, "docs", "engine-fallback.md"), "utf-8");
const source = (relative: string): string => fs.readFileSync(path.join(import.meta.dirname, "..", "..", ...relative.split("/")), "utf-8");

const WAIT_HOURS = MAX_USAGE_LIMIT_WAIT_MS / 3_600_000;
const RESUME_SECONDS = RESTART_LIMIT_RESET_BUFFER_MS / 1_000;
const REFUSED_MINUTES = LOGIN_REFUSAL_HOLD_MS / 60_000;
/** How long a stated reset is acted on before the engine is tried for real. */
const REPROBE_HOURS = (() => {
  const now = new Date("2026-10-12T03:00:00.000Z");
  return (reprobeAtMs(now.getTime() + 30 * 24 * 3_600_000, now) - now.getTime()) / 3_600_000;
})();

/** Every state the health record can show. The two lines under it make the
 *  compiler fail when the type changes without this list following. */
const HEALTH_STATES = ["ok", "exhausted", "degraded"] as const;
const everyStateIsListed: Exclude<EngineHealthState, (typeof HEALTH_STATES)[number]> extends never ? true : false = true;
const everyListedIsAState: (typeof HEALTH_STATES)[number] extends EngineHealthState ? true : false = true;

describe.each([
  ["the config skill's reference", reference],
  ["docs/engine-fallback.md", rootDoc],
])("usage limits in %s", (_name, doc) => {
  it("says a limit is waited for only when it resets within the time a turn waits", () => {
    expect(doc()).toContain(`リセットが${WAIT_HOURS}時間以内の場合と、時刻が分からない場合（最長${WAIT_HOURS}時間）`);
    expect(doc()).toMatch(new RegExp(`リセットが${WAIT_HOURS}時間より先と分かっている[^。]*待たずに失敗`));
  });

  it("says a turn that was waiting is carried on after a restart, a moment after the reset", () => {
    expect(doc()).toContain(`リセットの${RESUME_SECONDS}秒後`);
  });

  it("says how long a stated reset keeps a conversation on its fallback engine", () => {
    expect(REPROBE_HOURS).toBe(12);
    expect(doc()).toContain(`${REPROBE_HOURS}時間`);
  });

  it("says a fallback engine that is not signed in is given up, and for how long it is left out", () => {
    expect(doc()).toMatch(new RegExp(`${REFUSED_MINUTES}分のあいだ(切替先|代替)から外`));
  });

  it("says new sessions start on the fallback engine while a limit is on record, and which do not", () => {
    const text = doc();
    expect(text).toContain("`POST /api/sessions`");
    for (const exempt of ["名指しした呼び出し", "`rateLimitStrategy: wait`", "`sshHost` の社員"]) expect(text, exempt).toContain(exempt);
    expect(text).toContain("`engines.<名前>.health`");
  });
});

describe("the config skill's reference on engine fallback", () => {
  it("no longer tells the agent to check whether health-aware starts are wired at all", () => {
    expect(reference()).not.toContain("healthに基づく事前回避も、helperだけでなく呼び出しを確認してから案内する");
    expect(reference()).toContain("`sessions/new-session-engine`");
    expect(fs.existsSync(path.join(import.meta.dirname, "..", "new-session-engine.ts"))).toBe(true);
  });

  it("no longer describes `wait` as waiting for however long the limit lasts", () => {
    expect(reference()).not.toContain("`wait` は利用制限の解除待ち。");
    expect(reference()).toMatch(/`wait` は切り替えないという意味で、いつまでも待つという意味ではない/);
  });

  it("quotes the error a limit too far off to wait for ends with", () => {
    const quoted = "which is too far off to wait for";
    expect(reference()).toContain(quoted);
    expect(source("sessions/engine-fallback.ts")).toContain(quoted);
  });

  it("names the health states /api/status can show", () => {
    expect(everyStateIsListed && everyListedIsAState).toBe(true);
    for (const state of HEALTH_STATES.filter((name) => name !== "ok")) expect(reference()).toContain(`\`${state}\``);
  });
});

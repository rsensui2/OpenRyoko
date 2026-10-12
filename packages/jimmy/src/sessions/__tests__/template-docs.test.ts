import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { COMPLETION_BATCH_MAX_ITEMS } from "../completion-batching.js";
import { createSession, initDb, updateSession } from "../registry.js";
import {
  DEFAULT_RESUME_MAX_AGE_MINUTES,
  MAX_RESTART_RESUMES,
  RESTART_NUDGE_COOLDOWN_MS,
  RESTART_NUDGE_WINDOW_LIMIT,
  RESTART_NUDGE_WINDOW_MS,
  RESTART_RESUME_STAGGER_MS,
  resumeRestartInterruptedSessions,
  withRestartInterruptedMark,
} from "../restart-resume.js";
import { unrequestedStopError } from "../unrequested-stop.js";

// What a session does when a turn does not end the ordinary way — cut off by a
// restart, its engine process gone, its parent busy or in error — is decided by
// the gateway, and is learned from the files that ship with every instance.
// Nothing generates those files from the code. These hold them to it: a setting
// renamed, a default or a limit changed, and the description fails here.

const read = (relative: string): string => fs.readFileSync(path.join(TEMPLATE_DIR, ...relative.split("/")), "utf-8");

const COOLDOWN_MINUTES = RESTART_NUDGE_COOLDOWN_MS / 60_000;
const WINDOW_HOURS = RESTART_NUDGE_WINDOW_MS / 3_600_000;
const STAGGER_SECONDS = RESTART_RESUME_STAGGER_MS / 1_000;

/** The `sessions:` section the default config ships commented out, read as the
 *  config it becomes when the comment marks are taken off. */
function documentedSessions(): Record<string, unknown> {
  const lines = read("config.default.yaml").split("\n");
  const start = lines.indexOf("# sessions:");
  expect(start, "config.default.yaml no longer ships a commented `# sessions:` section").toBeGreaterThan(-1);
  const section = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!/^#\s{2,}\S/.test(line)) break;
    section.push(line);
  }
  return (yaml.load(section.map((line) => line.replace(/^# ?/, "")).join("\n")) as { sessions: Record<string, unknown> }).sessions;
}

describe("the session settings in the default config", () => {
  const NOW = Date.parse("2026-10-12T03:00:00.000Z");
  let sequence = 0;

  beforeEach(() => {
    const db = initDb();
    db.prepare("DELETE FROM queue_items").run();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM sessions").run();
  });

  /** A Slack conversation whose turn a restart cut off `minutesAgo` minutes before this start. */
  function interrupted(minutesAgo: number): void {
    const key = `slack:C_DOCS:${++sequence}`;
    const session = createSession({ engine: "claude", source: "slack", sourceRef: key, connector: "slack", sessionKey: key, replyContext: { channel: "C_DOCS", thread: String(sequence) } });
    const at = new Date(NOW - minutesAgo * 60_000).toISOString();
    updateSession(session.id, { status: "interrupted", lastActivity: at, transportMeta: withRestartInterruptedMark(session.transportMeta, at) });
  }

  /** A gateway start with `sessions` for its config: nothing is posted, nothing sleeps. */
  const start = (sessions: Record<string, unknown>) => resumeRestartInterruptedSessions({
    config: { gateway: { port: 0, host: "127.0.0.1" }, sessions } as unknown as JinnConfig,
    port: 0,
    now: () => NOW,
    post: vi.fn(async () => {}),
    schedule: () => {},
  });

  it("shows both settings with the values the gateway uses when they are not set", () => {
    const documented = documentedSessions();

    expect(documented.resumeInterruptedOnBoot).toBe(true);
    expect(documented.resumeInterruptedMaxAgeMinutes).toBe(DEFAULT_RESUME_MAX_AGE_MINUTES);
  });

  it("names the switch the gateway reads: set to false, nothing is resumed", () => {
    const documented = documentedSessions();

    interrupted(10);
    expect(start(documented)).toMatchObject({ planned: 1 });
    interrupted(10);
    expect(start({ ...documented, resumeInterruptedOnBoot: false })).toMatchObject({ planned: 0, disabled: true });
  });

  it("names the age limit the gateway reads: an interruption older than it is left alone", () => {
    const documented = documentedSessions();

    interrupted(DEFAULT_RESUME_MAX_AGE_MINUTES + 1);
    expect(start(documented)).toMatchObject({ planned: 0, skipped: 1 });
    interrupted(10);
    expect(start({ ...documented, resumeInterruptedMaxAgeMinutes: 5 })).toMatchObject({ planned: 0, skipped: 1 });
    interrupted(10);
    expect(start(documented)).toMatchObject({ planned: 1, skipped: 0 });
  });

  it("says next to them who is left out, how many are woken and how often, and where the rest is written", () => {
    const text = read("config.default.yaml");
    const comment = text.slice(0, text.indexOf("\n# sessions:")).split("\n\n").at(-1)!;

    expect(comment).toMatch(/cron/);
    expect(comment).toMatch(/workflow/);
    expect(comment).toContain(`${MAX_RESTART_RESUMES}件`);
    expect(comment).toContain(`${COOLDOWN_MINUTES}分`);
    expect(comment).toContain(`${WINDOW_HOURS}時間で${RESTART_NUDGE_WINDOW_LIMIT}回`);
    expect(comment).toContain("docs/architecture.md の「Session Lifecycle」");
  });
});

describe("docs/architecture.md — session lifecycle", () => {
  const doc = (): string => {
    const text = read("docs/architecture.md");
    const start = text.indexOf("\n## Session Lifecycle\n");
    expect(start, "docs/architecture.md no longer has a `## Session Lifecycle` section").toBeGreaterThan(-1);
    const next = text.indexOf("\n## ", start + 1);
    return next === -1 ? text.slice(start) : text.slice(start, next);
  };

  it("names both settings and shows them with their defaults", () => {
    expect(doc()).toContain("sessions.resumeInterruptedOnBoot");
    expect(doc()).toContain("sessions.resumeInterruptedMaxAgeMinutes");
    // The example is a config a reader can copy: it has to be the defaults.
    const example = /```yaml\n(sessions:\n[\s\S]*?)```/.exec(doc());
    expect(example, "the section no longer shows the settings as YAML").not.toBeNull();
    expect((yaml.load(example![1]) as { sessions: Record<string, unknown> }).sessions).toEqual({
      resumeInterruptedOnBoot: true,
      resumeInterruptedMaxAgeMinutes: DEFAULT_RESUME_MAX_AGE_MINUTES,
    });
    expect(doc()).toMatch(new RegExp(`default ${DEFAULT_RESUME_MAX_AGE_MINUTES}\\b`));
  });

  it("says which turns are not resumed", () => {
    expect(doc()).toMatch(/cron runs/);
    expect(doc()).toMatch(/workflow attempts/);
    expect(doc()).toMatch(/queue[^.]*re-run/);
  });

  it("gives the limits the gateway applies", () => {
    expect(doc()).toContain(`at most ${MAX_RESTART_RESUMES} sessions`);
    expect(doc()).toContain(`${STAGGER_SECONDS} seconds apart`);
    expect(doc()).toContain(`within ${COOLDOWN_MINUTES} minutes`);
    expect(doc()).toContain(`${RESTART_NUDGE_WINDOW_LIMIT} times in ${WINDOW_HOURS} hours`);
  });

  it("says how to turn it off", () => {
    expect(doc()).toMatch(/`sessions\.resumeInterruptedOnBoot: false`/);
  });

  it("says an engine process that ends without having been stopped is a failed turn, in the words the reply carries", () => {
    expect(doc()).toContain(`\`${unrequestedStopError("<engine>", "<reason>")}\``);
    expect(doc()).toMatch(/gets the error as its reply/);
    expect(doc()).toMatch(/run log as `error`/);
  });

  it("says child completions reach a busy parent as one turn, how many, and that failures do not join", () => {
    expect(doc()).toContain(`up to ${COMPLETION_BATCH_MAX_ITEMS}`);
    expect(doc()).toMatch(/single turn/);
    expect(doc()).toMatch(/failure[^.]*turn of its own/);
  });

  it("says a parent in error is not woken by its children, where their reports go, and the exception", () => {
    expect(doc()).toMatch(/parent in `error` is not woken/);
    expect(doc()).toMatch(/written into its transcript/);
    expect(doc()).toMatch(/stopped unexpectedly[^.]*woken as usual/);
  });
});

describe("the way to that section", () => {
  it("leads there from the settings map an agent follows when asked to change the config", () => {
    const map = read("skills/openryoko-config/references/platform.md");
    const row = map.split("\n").find((line) => line.includes("sessions.resumeInterruptedOnBoot"));

    expect(row, "platform.md no longer lists the restart-resume settings").toBeDefined();
    expect(row).toContain("resumeInterruptedMaxAgeMinutes");
    expect(row).toContain(`${DEFAULT_RESUME_MAX_AGE_MINUTES}分`);
    expect(row).toContain("`docs/architecture.md` の「Session Lifecycle」");
  });

  it("does not put it in the instructions every session reads in full", () => {
    // AGENTS.md was cut down on purpose: it holds the map, and the docs hold the detail.
    expect(read("AGENTS.md")).not.toContain("resumeInterruptedOnBoot");
  });
});

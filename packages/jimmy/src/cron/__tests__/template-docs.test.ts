import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "../../shared/paths.js";

const read = (rel: string) => fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf-8");

// Operators and agents learn the cron settings, and what a run-log status
// means, from these shipped files. Nothing generates them from the code, so
// this pins that what the gateway reads and writes is written down where it is
// looked up.
describe("shipped cron documentation", () => {
  it("lists cron.alertThrottleMinutes with the other alert settings in the default config", () => {
    expect(read("config.default.yaml")).toMatch(/\ncron:\n(?:[ \t]+#.*\n)*[ \t]+# alertThrottleMinutes: 60\b/);
  });

  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("explains the alert throttle and its default in %s", (file) => {
    const text = read(file);
    expect(text).toContain("cron.alertThrottleMinutes");
    expect(text).toMatch(/default 60/);
  });

  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("says in %s which prompt runs are logged as an error", (file) => {
    const text = read(file);
    expect(text).toMatch(/session ended in error/);
    expect(text).toMatch(/not delivered/);
    expect(text).toMatch(/engine the gateway does not have/);
  });

  it("shows the run log with the fields the gateway writes, not ones it never did", () => {
    const text = read("docs/cron.md");
    for (const field of ["timestamp", "sessionKey", "sessionId", "status", "durationMs", "error"]) {
      expect(text).toContain(`"${field}":`);
    }
    for (const stale of ['"runId"', '"completedAt"', '"output"']) expect(text).not.toContain(stale);
  });

  // The inspection an update-notification job runs writes its own lines, and
  // those report a delivered result as `notified`, never as `success`.
  it("names every status a run-log line can carry, including the maintenance lines' own", () => {
    const text = read("docs/cron.md");
    for (const status of ["success", "error", "skipped", "notified"]) expect(text).toContain(`\`${status}\``);
    expect(text).toMatch(/`kind: "maintenance"`[^.]*`notified`/);
  });

  // A fire that is skipped because an earlier one of the same job is parked on
  // a usage limit writes a reason and two fields nothing else does.
  it.each(["docs/cron.md", "skills/cron-manager/SKILL.md"])("says in %s why a prompt run is skipped while an earlier fire waits for a usage limit", (file) => {
    const text = read(file);
    expect(text).toContain("previous-run-waiting-for-usage-limit");
    expect(text).toContain("`waitingSessionId`");
    expect(text).toContain("`resetsAt`");
  });

  // A job naming an unknown engine is failed before any session is started, so
  // that error line has no `sessionId` to follow.
  it("does not promise a sessionId for a run that failed before a session existed", () => {
    const text = read("skills/cron-manager/SKILL.md");
    expect(text).not.toContain("and the session in `sessionId`");
    expect(text).toMatch(/`sessionId`, when present[^.]*\babsent\b[^.]*engine the gateway does not have/);
  });

  it("mentions that the run history can be limited to the newest runs", () => {
    expect(read("docs/cron.md")).toContain("?limit=");
    expect(read("skills/cron-manager/SKILL.md")).toContain("?limit=");
  });
});

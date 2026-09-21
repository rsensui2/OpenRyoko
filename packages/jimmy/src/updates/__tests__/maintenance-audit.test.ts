import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectMaintenance, maintenanceCapabilities, readMaintenanceJobs, type MaintenanceCapabilities } from "../maintenance-audit.js";
import type { JinnConfig } from "../../shared/types.js";
import { CRON_JOBS } from "../../shared/paths.js";

const config = {
  engines: { default: "codex", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-6-astra" } },
  connectors: {},
} as JinnConfig;
const capabilities: MaintenanceCapabilities = { commandCron: true, jev: true, workflows: true, terra: true, bidirectionalFallback: true };

describe("deterministic maintenance audit", () => {
  it("advertises the integrated gateway features and respects an explicit model allowlist", () => {
    expect(maintenanceCapabilities(config)).toMatchObject({ commandCron: true, jev: true, bidirectionalFallback: true, terra: true });
    const restricted = { ...config, models: { codex: { models: [{ id: "gpt-6-astra" }] } } } as JinnConfig;
    expect(maintenanceCapabilities(restricted).terra).toBe(false);
  });

  it("fails closed for malformed Cron data without echoing its contents", () => {
    fs.mkdirSync(path.dirname(CRON_JOBS), { recursive: true });
    try {
      fs.writeFileSync(CRON_JOBS, "private-invalid-json");
      expect(() => readMaintenanceJobs()).toThrow("Cron設定のJSONが不正");
      fs.writeFileSync(CRON_JOBS, "{}");
      expect(() => readMaintenanceJobs()).toThrow("配列");
    } finally { fs.unlinkSync(CRON_JOBS); }
  });

  it("finds enabled prompt jobs without exposing prompts or command arguments", () => {
    const jobs = [
      { id: "private", enabled: true, prompt: "private business text", command: { args: ["secret-value"] } },
      { id: "disabled", enabled: false, prompt: "don't restart" },
      { id: "update", enabled: true, kind: "update-notification" },
    ];
    const audit = inspectMaintenance(config, { jobs, capabilities, version: "2026.9.21" });
    expect(audit.inventory).toEqual({ enabledPromptJobs: 1, commandJobs: 0, disabledJobs: 1 });
    expect(audit.findings.map((finding) => finding.id)).toEqual(["cron-efficiency-v1"]);
    expect(JSON.stringify(audit)).not.toContain("private");
    expect(JSON.stringify(audit)).not.toContain("secret-value");
  });

  it("does not assume a command job's ordinary delivery sends stdout", () => {
    const audit = inspectMaintenance(config, { capabilities, jobs: [{ enabled: true, kind: "command", delivery: { connector: "slack", channel: "C123" } }] });
    expect(audit.findings.map((finding) => finding.id)).toEqual(["command-delivery-v1"]);
  });

  it("gates suggestions on running capabilities, including named Slack instances", () => {
    const instanceConfig = { ...config, connectors: { instances: [{ id: "support", type: "slack", config: { triage: { enabled: true, backend: "cli" } } }] } } as JinnConfig;
    const supported = inspectMaintenance(instanceConfig, { capabilities, jobs: [] });
    expect(supported.findings.map((finding) => finding.id)).toEqual(["jev-triage-v1"]);
    expect(inspectMaintenance(instanceConfig, { capabilities: { ...capabilities, jev: false }, jobs: [] }).findings).toEqual([]);
    const old = inspectMaintenance(config, { capabilities: { ...capabilities, commandCron: false }, jobs: [{ enabled: true, kind: "command" }] });
    expect(old.findings[0].id).toBe("unsupported-command-v1");
  });

  it("changes fingerprints for relevant edits and installed releases, not the notification schedule", () => {
    const jobs = [{ enabled: true, prompt: "check" }, { enabled: true, kind: "update-notification", schedule: "0 9 * * *" }];
    const first = inspectMaintenance(config, { capabilities, jobs, version: "2026.9.21" });
    jobs[1].schedule = "0 10 * * *";
    expect(inspectMaintenance(config, { capabilities, jobs, version: "2026.9.21" }).fingerprint).toBe(first.fingerprint);
    expect(inspectMaintenance(config, { capabilities, jobs, version: "2026.9.22" }).fingerprint).not.toBe(first.fingerprint);
    jobs[0].prompt = "changed";
    expect(inspectMaintenance(config, { capabilities, jobs, version: "2026.9.21" }).fingerprint).not.toBe(first.fingerprint);
  });

  it("returns no work when there are no relevant opportunities", () => {
    expect(inspectMaintenance(config, { capabilities, jobs: [] }).findings).toEqual([]);
  });
});

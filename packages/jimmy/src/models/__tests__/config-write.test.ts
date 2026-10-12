import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JINN_HOME, CONFIG_PATH, ORG_DIR, CRON_JOBS } from "../../shared/paths.js";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import type { JinnConfig } from "../../shared/types.js";
import { ModelManagement } from "../service.js";
import type { DiscoveredModel, ManagedEngine } from "../discovery.js";
import { invalidateModelRegistry, setDiscoveredModels } from "../../shared/models.js";

/* Model management rewrites config.yaml whenever a default model, a policy or
 * a follow setting changes — from Slack, that is often. It goes through the
 * same config writer as the Settings page, so the same guarantees hold: the
 * file keeps its permission bits, a config.yaml that cannot be read is neither
 * written over nor quoted in the error, and a failed write leaves it whole. */

const sol = (id = "gpt-6-sol"): DiscoveredModel => ({ id, label: id, supportsEffort: true, effortLevels: ["low", "medium", "high"], defaultEffort: "medium" });
const followBalanced = { action: "policy", engine: "codex", policy: { mode: "auto", profile: "balanced" } };

let running: JinnConfig;
const discover = vi.fn(async (engine: ManagedEngine): Promise<DiscoveredModel[]> => (engine === "codex" ? [sol()] : []));
const service = () => new ModelManagement({ getConfig: () => running, onConfig: (next) => { running = next; }, discover, notify: async () => true });
const onDisk = () => fs.readFileSync(CONFIG_PATH, "utf-8");
const parsed = () => yaml.load(onDisk()) as JinnConfig;

beforeEach(() => {
  fs.rmSync(path.join(JINN_HOME, "models"), { force: true, recursive: true });
  fs.rmSync(ORG_DIR, { force: true, recursive: true });
  fs.mkdirSync(ORG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CRON_JOBS), { recursive: true });
  fs.writeFileSync(CRON_JOBS, "[]");
  running = {
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high" }, claude: { bin: "claude", model: "claude-opus-5" } },
    gateway: { host: "127.0.0.1", port: 0 }, connectors: { slack: { botToken: "xoxb-STORED-SECRET" } },
    logging: { file: false, stdout: false, level: "error" },
  } as JinnConfig;
  fs.writeFileSync(CONFIG_PATH, yaml.dump(running));
  invalidateModelRegistry();
  setDiscoveredModels("codex", []);
  setDiscoveredModels("claude", []);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("model management writing config.yaml", () => {
  it("applies the change and hands the gateway the config it wrote", async () => {
    await service().act(followBalanced);
    expect(parsed().engines.codex.model).toBe("gpt-6-sol");
    expect(running.engines.codex.model).toBe("gpt-6-sol");
    expect(parsed().connectors.slack?.botToken).toBe("xoxb-STORED-SECRET");
  });

  it.skipIf(!POSIX_MODES_SUPPORTED)("keeps the permission bits config.yaml had", async () => {
    fs.chmodSync(CONFIG_PATH, 0o640);
    await service().act(followBalanced);
    expect(parsed().engines.codex.model).toBe("gpt-6-sol");
    expectPosixMode(CONFIG_PATH, 0o640);
  });

  it("neither writes over nor quotes a config.yaml it cannot read", async () => {
    const broken = "connectors:\n  slack:\n    botToken: xoxb-STORED-SECRET\n   appToken: xapp-STORED-SECRET\n";
    fs.writeFileSync(CONFIG_PATH, broken);
    const failure = await service().act(followBalanced).then(() => null, (error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    // POST /api/models/actions answers with this message.
    expect(failure?.message).not.toContain("STORED-SECRET");
    expect(failure?.message).toContain("config.yaml");
    expect(onDisk()).toBe(broken);
    expect(running.engines.codex.model).toBe("gpt-5.6-sol");
  });

  it("leaves the previous file whole when the write fails part-way", async () => {
    const before = onDisk();
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // Only the swap of config.yaml fails; the model state file still saves.
      if (path.basename(String(to)) !== "config.yaml") return rename(from, to);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    await expect(service().act(followBalanced)).rejects.toThrow(/ENOSPC/);
    expect(onDisk()).toBe(before);
    expect(fs.readdirSync(path.dirname(CONFIG_PATH)).filter((name) => name.includes("config.yaml"))).toEqual(["config.yaml"]);
    expect(running.engines.codex.model).toBe("gpt-5.6-sol");
  });
});

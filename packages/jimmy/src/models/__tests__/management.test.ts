import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JINN_HOME, CONFIG_PATH, ORG_DIR, CRON_JOBS } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { ModelManagement, recommend } from "../service.js";
import { normalizeModels, type DiscoveredModel, type ManagedEngine } from "../discovery.js";
import { createSession, getSession, initDb } from "../../sessions/registry.js";
import { invalidateModelRegistry, getModelRegistry, setDiscoveredModels } from "../../shared/models.js";
import { SlackModelControls } from "../../connectors/slack/model-controls.js";

const sol = (id = "gpt-6-sol"): DiscoveredModel => ({ id, label: id, supportsEffort: true, effortLevels: ["low", "medium", "high"], defaultEffort: "medium" });
let config: JinnConfig;
let discover: ReturnType<typeof vi.fn<(engine: ManagedEngine, bin: string) => Promise<DiscoveredModel[]>>>;
let notify: ReturnType<typeof vi.fn<(text: string, engine: ManagedEngine, candidate?: string) => Promise<boolean>>>;
function make() { return new ModelManagement({ getConfig: () => config, onConfig: c => { config = c; }, discover, notify }); }
beforeEach(() => {
  fs.rmSync(path.join(JINN_HOME, "models"), { force: true, recursive: true });
  fs.rmSync(ORG_DIR, { force: true, recursive: true });
  fs.mkdirSync(ORG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CRON_JOBS), { recursive: true }); fs.writeFileSync(CRON_JOBS, "[]");
  config = { engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high" }, claude: { bin: "claude", model: "claude-opus-5" } }, gateway: { host: "127.0.0.1", port: 0 }, connectors: {}, logging: { file: false, stdout: false, level: "error" }, portal: { operatorSlackId: "UADMIN" } };
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config));
  invalidateModelRegistry(); setDiscoveredModels("codex", []); setDiscoveredModels("claude", []);
  discover = vi.fn(async engine => engine === "codex" ? [sol(), sol("gpt-future-sol")] : [{ ...sol("claude-opus-5-5"), aliases: ["default", "opus"] }]);
  notify = vi.fn(async () => true);
});
afterEach(() => vi.useRealTimers());

describe("catalog normalization", () => {
  it("uses CLI capability metadata, skips hidden models and unsupported efforts", () => {
    expect(normalizeModels("codex", [{ model: "future", displayName: "Future", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "ultra" }] }, { model: "secret", hidden: true }])).toEqual([{ id: "future", label: "Future", isDefault: true, supportsEffort: true, effortLevels: ["medium"] }]);
  });
  it("resolves Claude aliases to real IDs and retains default when deduplicating", () => {
    const result = normalizeModels("claude", [{ value: "default", resolvedModel: "claude-new", displayName: "Default" }, { value: "opus", resolvedModel: "claude-new", displayName: "Opus" }]);
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ id: "claude-new", isDefault: true, aliases: ["default", "opus"] });
  });
  it("never selects expensive Astra for balanced even when provider default", () => {
    expect(recommend("codex", [{ ...sol("gpt-6-astra"), isDefault: true }, sol()], "balanced")?.id).toBe("gpt-6-sol");
    expect(recommend("codex", [sol("gpt-6-astra")], "balanced")).toBeUndefined();
  });
});

describe("model management", () => {
  it("refreshes once without changing legacy defaults; dynamic models reach registry", async () => {
    const service = make(); await Promise.all([service.refresh(), service.refresh(), service.refresh(true)]);
    expect(discover).toHaveBeenCalledTimes(2); expect(config.engines.codex.model).toBe("gpt-5.6-sol");
    expect(getModelRegistry(config).codex.models.some(m => m.id === "gpt-future-sol")).toBe(true);
  });
  it("auto follows balanced and freezes existing conversations without touching pins or secrets", async () => {
    config.connectors = { slack: { botToken: "xoxb-test-private", appToken: "xapp-test-private" } };
    config.models = { codex: { default: "gpt-5.6-sol", models: [{ id: "local-special" }] } };
    fs.writeFileSync(CONFIG_PATH, yaml.dump(config));
    fs.writeFileSync(path.join(ORG_DIR, "writer.yaml"), yaml.dump({ name: "writer", persona: "write", engine: "codex", model: "gpt-6-astra" }));
    const old = createSession({ engine: "codex", source: "web", sourceRef: "web:test" });
    const pinned = createSession({ engine: "codex", source: "web", sourceRef: "web:pinned", model: "local-special" });
    const service = make(); await service.act({ action: "policy", engine: "codex", policy: { mode: "auto", profile: "balanced" } });
    expect(config.engines.codex).toMatchObject({ model: "gpt-6-sol", effortLevel: "medium" });
    expect(config.models?.codex.default).toBe("gpt-6-sol"); expect(config.models?.codex.models[0].id).toBe("local-special");
    expect(getSession(old.id)?.model).toBe("gpt-5.6-sol"); expect(getSession(pinned.id)?.model).toBe("local-special");
    expect(config.connectors.slack!.botToken).toBe("xoxb-test-private");
    expect(service.snapshot().pins[0].model).toBe("gpt-6-astra");
    expect(fs.readFileSync(path.join(JINN_HOME, "models", "state.json"), "utf8")).not.toContain("xoxb");
    await service.act({ action: "rollback", engine: "codex" });
    expect(config.engines.codex.model).toBe("gpt-5.6-sol"); expect(service.policy("codex").mode).toBe("fixed");
    expect(config.engines.codex.effortLevel).toBe("high");
  });
  it("notify waits for acceptance and deduplicates on subsequent checks", async () => {
    const service = make(); await service.act({ action: "policy", engine: "codex", policy: { mode: "notify", profile: "balanced" } });
    expect(config.engines.codex.model).toBe("gpt-5.6-sol"); expect(notify).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 3600_000);
    await service.refresh(); expect(notify).toHaveBeenCalledTimes(1);
    await service.act({ action: "accept", engine: "codex", model: "gpt-6-sol" });
    expect(config.engines.codex.model).toBe("gpt-6-sol"); expect(service.policy("codex").mode).toBe("notify");
    vi.restoreAllMocks();
  });
  it("retries a failed auto-update notification without applying the update twice", async () => {
    notify.mockResolvedValue(false);
    const service = make(); await service.act({ action: "policy", engine: "codex", policy: { mode: "auto", profile: "balanced" } });
    expect(config.engines.codex.model).toBe("gpt-6-sol");
    notify.mockResolvedValue(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 3600_000);
    await service.refresh();
    expect(service.snapshot().engines[0].previous).toBe("gpt-5.6-sol");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("更新しました"), "codex", undefined);
    vi.restoreAllMocks();
  });
  it("does not widen an explicit registry or its effort restrictions during discovery", async () => {
    config.models = { codex: { default: "gpt-6-sol", models: [{ id: "gpt-6-sol", effortLevels: ["low"], supportsEffort: true }] } };
    fs.writeFileSync(CONFIG_PATH, yaml.dump(config));
    const service = make(); await service.refresh();
    expect(getModelRegistry(config).codex.models.map(m => m.id)).toEqual(["gpt-6-sol"]);
    await service.act({ action: "default", engine: "codex", model: "gpt-6-sol" });
    expect(config.engines.codex.effortLevel).toBe("low");
  });
  it("does not overwrite a newer manual default with an old rollback", async () => {
    const service = make(); await service.refresh();
    await service.act({ action: "default", engine: "codex", model: "gpt-6-sol" });
    const external = { ...config, engines: { ...config.engines, codex: { ...config.engines.codex, model: "manual-new" } } };
    fs.writeFileSync(CONFIG_PATH, yaml.dump(external));
    await expect(service.act({ action: "rollback", engine: "codex" })).rejects.toThrow("別の操作");
    expect((yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) as JinnConfig).engines.codex.model).toBe("manual-new");
  });
  it("discovery failure retains previous model; stale cache cannot approve a switch", async () => {
    discover.mockRejectedValue(new Error("private credential must not leak"));
    const service = make(); await service.act({ action: "policy", engine: "codex", policy: { mode: "auto", profile: "balanced" } });
    expect(config.engines.codex.model).toBe("gpt-5.6-sol");
    expect(JSON.stringify(service.snapshot())).not.toContain("private credential");
    await expect(service.act({ action: "default", engine: "codex", model: "gpt-6-sol" })).rejects.toThrow("一覧を更新");
  });
  it("ignores malformed persisted cache and rebuilds it", async () => {
    fs.mkdirSync(path.join(JINN_HOME, "models"), { recursive: true });
    fs.writeFileSync(path.join(JINN_HOME, "models", "state.json"), JSON.stringify({ catalogs: "broken", history: true, notified: {} }));
    const service = make(); await service.refresh();
    expect(service.snapshot().engines[0].models.some(m => m.id === "gpt-6-sol")).toBe(true);
    expect(config.engines.codex.model).toBe("gpt-5.6-sol");
  });
  it("rejects model not returned by CLI and changed executable", async () => {
    const service = make(); await service.refresh();
    await expect(service.act({ action: "default", engine: "codex", model: "shell;touch /tmp/file" })).rejects.toThrow();
    config.engines.codex.bin = "other-account-cli";
    await expect(service.act({ action: "default", engine: "codex", model: "gpt-6-sol" })).rejects.toThrow("一覧を更新");
  });
  it("clears employee and cron pins while preserving other fields and inherited employee model", async () => {
    const file = path.join(ORG_DIR, "writer.yaml");
    fs.writeFileSync(file, yaml.dump({ name: "writer", persona: "write", engine: "codex", model: "gpt-6-astra", effortLevel: "high" }));
    fs.writeFileSync(CRON_JOBS, JSON.stringify([{ id: "news", name: "News", enabled: true, schedule: "0 9 * * *", employee: "writer", model: "old", prompt: "private prompt" }]));
    const service = make();
    await service.act({ action: "pin", kind: "cron", id: "news", model: null });
    expect(service.snapshot().pins.find(p => p.kind === "cron")).toMatchObject({ model: null, effective: "gpt-6-astra", inheritedFrom: "employee:writer" });
    await service.act({ action: "pin", kind: "employee", id: "writer", model: null });
    expect(service.snapshot().pins.every(p => p.model === null && p.effective === "gpt-5.6-sol")).toBe(true);
    expect(yaml.load(fs.readFileSync(file, "utf8"))).toMatchObject({ persona: "write", effortLevel: "high" });
    expect(fs.readFileSync(CRON_JOBS, "utf8")).toContain("private prompt");
    await expect(service.act({ action: "pin", kind: "employee", id: "../../config", model: null })).rejects.toThrow();
  });
});

describe("Slack controls authorization", () => {
  it("requires immutable operator ID and binds one-shot actions to channel/user", async () => {
    const service = make(); await service.refresh();
    const controls = new SlackModelControls(() => service, () => "UADMIN");
    const card = controls.card("C1", "UADMIN");
    const token = (card.find((b: any) => b.type === "actions" && b.elements[0].action_id === "ryoko_models_auto_codex") as any).elements[0].value;
    await expect(controls.execute(token, "UNOTADMIN", "C1")).rejects.toThrow("管理者");
    await expect(controls.execute(token, "UADMIN", "C2")).rejects.toThrow("有効期限");
    await controls.execute(token, "UADMIN", "C1");
    expect(config.engines.codex.model).toBe("gpt-6-sol");
    await expect(controls.execute(token, "UADMIN", "C1")).rejects.toThrow("有効期限");
    expect(new SlackModelControls(() => service, () => undefined).authorized("UADMIN")).toBe(false);
  });
  it("rejects session switch while running", async () => {
    const service = make(); await service.refresh();
    const session = createSession({ engine: "codex", source: "slack", sourceRef: "slack:C1:1", sessionKey: "slack:C1:1" });
    initDb().prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    const controls = new SlackModelControls(() => service, () => "UADMIN");
    const card = controls.card("C1", "UADMIN", session.sessionKey!);
    const token = (card.find((b: any) => b.type === "actions" && b.elements[0].action_id === "ryoko_models_session_codex") as any).elements[0].options[0].value;
    await expect(controls.execute(token, "UADMIN", "C1")).rejects.toThrow("実行中");
  });
});

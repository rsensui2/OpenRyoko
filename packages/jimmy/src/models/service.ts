import { initDb } from "../sessions/registry.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { z } from "zod";
import { CONFIG_PATH, JINN_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { withConfigLock } from "../shared/config-lock.js";
import { getModelRegistry, invalidateModelRegistry, setDiscoveredModels } from "../shared/models.js";
import { scanOrg, updateEmployeeYaml } from "../gateway/org.js";
import { loadJobs, saveJobs } from "../cron/jobs.js";
import { discoverModels, type DiscoveredModel, type ManagedEngine } from "./discovery.js";
import type { JinnConfig } from "../shared/types.js";

export const policySchema = z.object({ mode: z.enum(["auto", "notify", "fixed"]), profile: z.enum(["balanced", "economy", "performance"]) }).strict();
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("policy"), engine: z.enum(["codex", "claude"]), policy: policySchema }).strict(),
  z.object({ action: z.literal("default"), engine: z.enum(["codex", "claude"]), model: z.string().min(1).max(160) }).strict(),
  z.object({ action: z.literal("accept"), engine: z.enum(["codex", "claude"]), model: z.string().min(1).max(160) }).strict(),
  z.object({ action: z.literal("rollback"), engine: z.enum(["codex", "claude"]) }).strict(),
  z.object({ action: z.literal("pin"), kind: z.enum(["employee", "cron"]), id: z.string().min(1).max(200), model: z.string().min(1).max(160).nullable() }).strict(),
  z.object({ action: z.literal("notification"), connector: z.string().min(1).max(100), channel: z.string().max(100) }).strict(),
]);
export type ModelAction = z.infer<typeof actionSchema>;
export type ModelPolicy = z.infer<typeof policySchema>;
const cachedModelSchema = z.object({ id: z.string().min(1).max(160), label: z.string().max(100), supportsEffort: z.boolean(), effortLevels: z.array(z.string()), contextWindow: z.number().optional(), isDefault: z.boolean().optional(), aliases: z.array(z.string()).optional(), defaultEffort: z.string().optional(), upgrade: z.string().optional() });
interface Catalog { models: DiscoveredModel[]; checkedAt: string; bin: string; error?: string }
interface History { from: string; to: string; at: string; effort?: string }
interface PendingNotice { text: string; candidate?: string; fingerprint: string }
interface State { pending: Partial<Record<ManagedEngine, PendingNotice>>; catalogs: Partial<Record<ManagedEngine, Catalog>>; history: Partial<Record<ManagedEngine, History>>; notified: Record<string, string> }
const catalogSchema = z.object({ models: z.array(cachedModelSchema), checkedAt: z.string(), bin: z.string(), error: z.string().optional() });
const historySchema = z.object({ from: z.string().min(1).max(160), to: z.string().min(1).max(160), at: z.string(), effort: z.string().optional() });
const pendingSchema = z.object({ text: z.string().max(1000), fingerprint: z.string().max(1000), candidate: z.string().max(160).optional() });
const stateSchema = z.object({
  catalogs: z.object({ codex: catalogSchema.optional(), claude: catalogSchema.optional() }),
  history: z.object({ codex: historySchema.optional(), claude: historySchema.optional() }),
  pending: z.object({ codex: pendingSchema.optional(), claude: pendingSchema.optional() }).default({}),
  notified: z.record(z.string(), z.string()),
});
const stateFile = path.join(JINN_HOME, "models", "state.json");
export const engines = ["codex", "claude"] as const;
export const defaultPolicy: ModelPolicy = { mode: "fixed", profile: "balanced" };

function atomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

/** Preserve provider ordering within a user-selected family; never sort model
 * IDs lexicographically or jump from balanced to a more expensive family. */
export function recommend(engine: ManagedEngine, models: DiscoveredModel[], profile: ModelPolicy["profile"]): DiscoveredModel | undefined {
  if (engine === "claude") {
    if (profile === "performance") {
      const fable = models.find(m => m.aliases?.includes("fable") || /^claude-fable-/.test(m.id));
      if (fable) return fable;
    }
    const alias = profile === "economy" ? "haiku" : profile === "performance" ? "opus" : "default";
    return models.find(m => m.aliases?.some(a => a === alias || a === `${alias}[1m]`));
  }
  const family = profile === "economy" ? "luna" : profile === "performance" ? "astra" : "sol";
  return models.find(m => new RegExp(`-${family}(?:$|-)`).test(m.id));
}

export class ModelManagement {
  private state: State = { catalogs: {}, history: {}, notified: {}, pending: {} };
  private refreshTask?: Promise<void>;
  private lastAttempt = 0;
  private stopped = false;
  stop(): void { this.stopped = true; }
  constructor(private options: {
    getConfig: () => JinnConfig;
    onConfig: (config: JinnConfig) => void;
    discover?: typeof discoverModels;
    notify?: (text: string, engine: ManagedEngine, candidate?: string) => Promise<boolean>;
  }) {
    try {
      const parsed = stateSchema.parse(JSON.parse(fs.readFileSync(stateFile, "utf8")));
      // Treat disk data as cache, never as authority for automatic changes.
      this.state = parsed;
      for (const engine of engines) {
        const catalog = this.state.catalogs[engine];
        if (!catalog) continue;
        catalog.error = "保存済みの一覧です。更新して利用可否を確認してください。";
        setDiscoveredModels(engine, catalog.models);
      }
    } catch { /* first run or invalid cache — rebuild from the CLI */ }
  }
  private save() { atomic(stateFile, JSON.stringify(this.state, null, 2) + "\n"); }
  private async editConfig(edit: (config: JinnConfig) => void): Promise<void> {
    await withConfigLock(async () => {
      const config = loadConfig();
      edit(config);
      atomic(CONFIG_PATH, yaml.dump(config, { lineWidth: -1 }));
      invalidateModelRegistry();
      this.options.onConfig(config);
    });
  }
  policy(engine: ManagedEngine): ModelPolicy {
    return policySchema.safeParse(this.options.getConfig().modelManagement?.policies?.[engine]).data ?? defaultPolicy;
  }
  private catalogError(engine: ManagedEngine): string | null {
    const catalog = this.state.catalogs[engine];
    if (!catalog) return "一覧を更新すると、この環境の候補を取得できます。";
    if (catalog.error) return catalog.error;
    if (catalog.bin !== (this.options.getConfig().engines[engine].bin || engine) || !Number.isFinite(Date.parse(catalog.checkedAt)) || Date.now() - Date.parse(catalog.checkedAt) > 24 * 3600_000) return "モデル一覧を更新してから選択してください。";
    return null;
  }
  snapshot() {
    const config = this.options.getConfig();
    const registry = getModelRegistry(config);
    return {
      engines: engines.map(engine => {
        const catalog = this.state.catalogs[engine];
        const policy = this.policy(engine);
        return { engine, current: config.engines[engine].model, policy,
          models: catalog?.models.length ? catalog.models : registry[engine]?.models ?? [], checkedAt: catalog?.checkedAt ?? null,
          error: this.catalogError(engine),
          candidate: catalog && !this.catalogError(engine) ? recommend(engine, catalog.models, policy.profile)?.id ?? null : null,
          previous: this.state.history[engine]?.from ?? null,
        };
      }),
      pins: this.pins(),
      notification: config.modelManagement?.notification ?? null,
      slackAdminConfigured: Boolean(config.portal?.operatorSlackId),
    };
  }
  pins() {
    const config = this.options.getConfig();
    const employees = scanOrg();
    const resolve = (engine: string) => (config.engines as any)[engine]?.model ?? "default";
    return [
      ...[...employees.values()].map(e => ({ kind: "employee" as const, id: e.name, name: e.displayName, engine: e.engine, model: e.model ?? null, effective: e.model || resolve(e.engine), remote: Boolean(e.sshHost) })),
      ...loadJobs().filter(j => j.kind !== "command").map(j => {
        const e = j.employee ? employees.get(j.employee) : undefined;
        const engine = j.engine || e?.engine || config.engines.default;
        const employeeModel = e?.engine === engine ? e.model : undefined;
        return { kind: "cron" as const, id: j.id, name: j.name, engine, model: j.model ?? null, effective: j.model || employeeModel || resolve(engine), inheritedFrom: employeeModel ? `employee:${e!.name}` : "default", remote: Boolean(e?.sshHost) };
      }),
    ];
  }
  refresh(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshTask) return this.refreshTask;
    if (Date.now() - this.lastAttempt < (force ? 30_000 : 6 * 3600_000)) return Promise.resolve();
    this.lastAttempt = Date.now();
    this.refreshTask = this.refreshNow().finally(() => { this.refreshTask = undefined; });
    return this.refreshTask;
  }
  private async refreshNow() {
    await Promise.all(engines.map(async engine => {
      const bin = this.options.getConfig().engines[engine].bin || engine;
      try {
        const models = await (this.options.discover ?? discoverModels)(engine, bin);
        if (this.stopped || (this.options.getConfig().engines[engine].bin || engine) !== bin) return;
        this.state.catalogs[engine] = { models, checkedAt: new Date().toISOString(), bin };
        setDiscoveredModels(engine, models);
      } catch {
        if (this.stopped) return;
        this.state.catalogs[engine] = { models: this.state.catalogs[engine]?.models ?? [], checkedAt: this.state.catalogs[engine]?.checkedAt ?? "", bin,
          error: "一覧を取得できませんでした。CLIの更新・ログイン状態を確認してください。以前の設定を維持しています。" };
      }
    }));
    if (this.stopped) return;
    this.save();
    for (const engine of engines) await this.reconcile(engine);
  }
  private async reconcile(engine: ManagedEngine) {
    const policy = this.policy(engine), catalog = this.state.catalogs[engine];
    if (!catalog || catalog.error || policy.mode === "fixed") return;
    const candidate = recommend(engine, catalog.models, policy.profile);
    const current = this.options.getConfig().engines[engine].model;
    if (!candidate) return;
    if (candidate.id !== current) {
      if (policy.mode === "auto" && !await this.select(engine, candidate.id, false, policy)) return;
      const fingerprint = `${policy.mode}:${current}:${candidate.id}`;
      if (this.state.notified[engine] !== fingerprint) this.state.pending[engine] = {
        fingerprint,
        text: policy.mode === "auto" ? `${engine} の既定モデルを ${current} → ${candidate.id} に更新しました。新規会話から適用します。` : `${engine} の新しい推奨モデル ${candidate.id} が利用可能です。現在の既定: ${current}。`,
        candidate: policy.mode === "notify" ? candidate.id : undefined,
      };
      this.save();
    }
    const pending = this.state.pending[engine];
    if (pending && await this.options.notify?.(pending.text, engine, pending.candidate)) {
      this.state.notified[engine] = pending.fingerprint;
      delete this.state.pending[engine]; this.save();
    }
  }
  assertAvailable(engine: ManagedEngine, model: string): void { this.available(engine, model); }
  private available(engine: ManagedEngine, model: string) {
    const c = this.state.catalogs[engine];
    if (!c || this.catalogError(engine)) throw new Error("モデル一覧を更新してから選択してください。");
    const found = c.models.find(m => m.id === model);
    if (!found) throw new Error("この環境のモデル一覧にないモデルです。");
    return found;
  }
  private async select(engine: ManagedEngine, model: string, fixed: boolean, expectedPolicy?: ModelPolicy) {
    let applied = false;
    const selected = this.available(engine, model);
    await this.editConfig(config => {
      if (expectedPolicy && (config.modelManagement?.policies?.[engine]?.mode !== expectedPolicy.mode || config.modelManagement?.policies?.[engine]?.profile !== expectedPolicy.profile)) return;
      this.available(engine, model);
      applied = true;
      const previous = config.engines[engine];
      if (previous.model !== model) this.state.history[engine] = { from: previous.model, to: model, at: new Date().toISOString(), effort: previous.effortLevel };
      if (previous.model !== model) {
        // Existing conversations keep their resolved model, including rows that
        // previously inherited implicitly. Changes apply to future conversations.
        initDb().prepare("UPDATE sessions SET model = ?, effort_level = COALESCE(effort_level, ?) WHERE engine = ? AND model IS NULL").run(previous.model, previous.effortLevel ?? null, engine);
      }
      previous.model = model;
      // Do not carry an expensive or unsupported effort into a new default.
      const explicit = config.models?.[engine];
      const capabilities = explicit?.models.find(m => m.id === model);
      const levels = capabilities?.supportsEffort === false ? [] : capabilities?.effortLevels ?? selected.effortLevels;
      previous.effortLevel = selected.defaultEffort && levels.includes(selected.defaultEffort) ? selected.defaultEffort : levels.includes("medium") ? "medium" : levels[0];
      if (explicit) {
        explicit.default = model;
        if (!capabilities) explicit.models.push({ id: selected.id, label: selected.label, supportsEffort: selected.supportsEffort, effortLevels: [...selected.effortLevels] });
      }
      if (fixed) {
        config.modelManagement ??= {}; config.modelManagement.policies ??= {};
        config.modelManagement.policies[engine] = { ...this.policy(engine), mode: "fixed" };
      }
    });
    this.save();
    return applied;
  }
  async act(input: unknown) {
    const action = actionSchema.parse(input);
    if ("engine" in action && ["policy", "default", "accept", "rollback"].includes(action.action)) delete this.state.pending[action.engine];
    switch (action.action) {
      case "refresh": await this.refresh(true); break;
      case "policy":
        await this.editConfig(config => { config.modelManagement ??= {}; config.modelManagement.policies ??= {}; config.modelManagement.policies[action.engine] = action.policy; });
        await this.refresh(); await this.reconcile(action.engine); break;
      case "default": await this.select(action.engine, action.model, true); break;
      case "accept": {
        const c = this.state.catalogs[action.engine];
        if (!c || recommend(action.engine, c.models, this.policy(action.engine).profile)?.id !== action.model) throw new Error("推奨モデルが変わりました。一覧を更新してください。");
        await this.select(action.engine, action.model, false); break;
      }
      case "rollback": {
        const previous = this.state.history[action.engine];
        if (!previous) throw new Error("戻せる変更履歴がありません。");
        await this.editConfig(config => {
          if (config.engines[action.engine].model !== previous.to) throw new Error("既定モデルは別の操作で変更済みです。一覧から選び直してください。");
          initDb().prepare("UPDATE sessions SET model = ?, effort_level = COALESCE(effort_level, ?) WHERE engine = ? AND model IS NULL").run(config.engines[action.engine].model, config.engines[action.engine].effortLevel ?? null, action.engine);
          config.engines[action.engine].model = previous.from;
          config.engines[action.engine].effortLevel = previous.effort;
          if (config.models?.[action.engine]) config.models[action.engine].default = previous.from;
          config.modelManagement ??= {}; config.modelManagement.policies ??= {};
          config.modelManagement.policies[action.engine] = { ...this.policy(action.engine), mode: "fixed" };
        });
        delete this.state.history[action.engine]; this.save(); break;
      }
      case "pin": {
        const pin = this.pins().find(p => p.kind === action.kind && p.id === action.id);
        if (!pin) throw new Error("対象が見つかりません。");
        if (action.model !== null) {
          if (!engines.includes(pin.engine as ManagedEngine) || pin.remote) throw new Error("この対象のモデルは個別設定で変更してください。");
          this.available(pin.engine as ManagedEngine, action.model);
        }
        // Synchronous read-modify-write: do not await between loading and saving.
        if (action.kind === "employee") {
          if (!updateEmployeeYaml(action.id, { model: action.model })) throw new Error("社員設定を保存できませんでした。");
        } else {
          const jobs = loadJobs({ allowMissing: false }), job = jobs.find(j => j.id === action.id);
          if (!job) throw new Error("定期実行が見つかりません。");
          if (action.model === null) delete job.model; else job.model = action.model;
          saveJobs(jobs);
        }
        break;
      }
      case "notification": await this.editConfig(config => { config.modelManagement ??= {}; config.modelManagement.notification = action.channel ? { connector: action.connector, channel: action.channel } : undefined; }); break;
    }
    return this.snapshot();
  }
}

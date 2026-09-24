import { randomUUID } from "node:crypto";
import type { App } from "@slack/bolt";
type WithBlocks = Extract<Parameters<App["client"]["chat"]["postMessage"]>[0], { blocks?: unknown }>;
type KnownBlock = Exclude<NonNullable<WithBlocks["blocks"]>, string>[number];
import type { ModelManagement, ModelAction } from "../../models/service.js";
import type { ManagedEngine } from "../../models/discovery.js";
import { getSessionBySessionKey, getQueueItems, updateSession } from "../../sessions/registry.js";

type Choice = ModelAction | { action: "session"; engine: ManagedEngine; model: string } | { action: "show" };
const modeLabels = { auto: "自動追従", notify: "通知して選ぶ", fixed: "固定" };
const profileLabels = { economy: "節約", balanced: "バランス", performance: "性能優先" };
interface Grant { choice: Choice; channel: string; user?: string; sessionKey?: string; expires: number }
export class SlackModelControls {
  private grants = new Map<string, Grant>();
  constructor(private service: () => ModelManagement | undefined, private operator: () => string | undefined, private connectorName = "slack") {}
  authorized(user: string): boolean { return Boolean(user && this.operator() && user === this.operator()); }
  private token(choice: Choice, channel: string, user?: string, sessionKey?: string): string {
    for (const [id, grant] of this.grants) if (grant.expires < Date.now()) this.grants.delete(id);
    while (this.grants.size >= 2000) this.grants.delete(this.grants.keys().next().value!);
    const id = randomUUID(); this.grants.set(id, { choice, channel, user, sessionKey, expires: Date.now() + 30 * 60_000 }); return id;
  }
  notice(channel: string, text: string, engine: ManagedEngine, candidate?: string): KnownBlock[] {
    const choice: Choice = candidate ? { action: "accept", engine, model: candidate } : { action: "rollback", engine };
    return [
      { type: "section", text: { type: "plain_text", text } },
      { type: "actions", elements: [
        { type: "button", action_id: "ryoko_models_notice", text: { type: "plain_text", text: candidate ? "今後の既定にする" : "元に戻す" }, value: this.token(choice, channel) },
        { type: "button", action_id: "ryoko_models_show", text: { type: "plain_text", text: "モデル設定" }, value: this.token({ action: "show" }, channel) },
      ] },
    ];
  }
  card(channel: string, user: string, sessionKey?: string): KnownBlock[] {
    const service = this.service();
    if (!service) throw new Error("モデル設定の起動準備中です。");
    const status = service.snapshot();
    const button = (text: string, choice: Choice, key: string) => ({ type: "button" as const, action_id: `ryoko_models_${key}`, text: { type: "plain_text" as const, text }, value: this.token(choice, channel, user, sessionKey) });
    const blocks: KnownBlock[] = [{ type: "section", text: { type: "plain_text", text: "モデル設定 — 既定の変更は新規会話から適用します。" } }];
    for (const entry of status.engines) {
      blocks.push({ type: "section", text: { type: "plain_text", text: `${entry.engine}: ${entry.current}\n方針: ${modeLabels[entry.policy.mode]} / ${profileLabels[entry.policy.profile]}${entry.error ? `\n${entry.error}` : ""}` } });
      const options = entry.models.slice(0, 90).map(m => ({ text: { type: "plain_text" as const, text: m.label.slice(0, 75) }, value: this.token({ action: "default", engine: entry.engine, model: m.id }, channel, user, sessionKey) }));
      if (options.length) blocks.push({ type: "actions", elements: [{ type: "static_select", action_id: `ryoko_models_default_${entry.engine}`, placeholder: { type: "plain_text", text: "今後の既定を固定して選ぶ" }, options }] });
      const session = sessionKey ? getSessionBySessionKey(sessionKey) : undefined;
      if (session?.engine === entry.engine && options.length) blocks.push({ type: "actions", elements: [{ type: "static_select", action_id: `ryoko_models_session_${entry.engine}`, placeholder: { type: "plain_text", text: "この会話だけ切り替える" }, options: entry.models.slice(0, 90).map(m => ({ text: { type: "plain_text", text: m.label.slice(0, 75) }, value: this.token({ action: "session", engine: entry.engine, model: m.id }, channel, user, sessionKey) })) }] });
      blocks.push({ type: "actions", elements: [
        button("自動追従", { action: "policy", engine: entry.engine, policy: { ...entry.policy, mode: "auto" } }, `auto_${entry.engine}`),
        button("通知して選ぶ", { action: "policy", engine: entry.engine, policy: { ...entry.policy, mode: "notify" } }, `notify_${entry.engine}`),
        button("固定する", { action: "policy", engine: entry.engine, policy: { ...entry.policy, mode: "fixed" } }, `fixed_${entry.engine}`),
        ...(entry.previous ? [button("元に戻す", { action: "rollback", engine: entry.engine }, `undo_${entry.engine}`)] : []),
      ] });
      blocks.push({ type: "actions", elements: [{ type: "static_select", action_id: `ryoko_models_profile_${entry.engine}`, placeholder: { type: "plain_text", text: "用途を選ぶ" }, options: ([['economy', '節約'], ['balanced', 'バランス'], ['performance', '性能優先']] as const).map(([profile, text]) => ({ text: { type: "plain_text", text }, value: this.token({ action: "policy", engine: entry.engine, policy: { ...entry.policy, profile } }, channel, user, sessionKey) })) }] });
    }
    const pinned = status.pins.filter(p => p.model);
    blocks.push({ type: "section", text: { type: "plain_text", text: pinned.length ? `固定設定 ${pinned.length}件\n${pinned.slice(0, 15).map(p => `${p.name}: ${p.model}`).join("\n")}${pinned.length > 15 ? "\n全件はWeb設定で確認できます。" : ""}` : "社員・定期実行の固定指定はありません。" } });
    if (pinned.length) blocks.push({ type: "actions", elements: [{ type: "static_select", action_id: "ryoko_models_unpin", placeholder: { type: "plain_text", text: "選んだ対象の固定を解除" }, options: pinned.slice(0, 100).map(p => ({ text: { type: "plain_text", text: `${p.kind === "employee" ? "社員" : "定期実行"}: ${p.name}`.slice(0, 75) }, value: this.token({ action: "pin", kind: p.kind, id: p.id, model: null }, channel, user, sessionKey) })) }] });
    blocks.push({ type: "actions", elements: [button("一覧を更新", { action: "refresh" }, "refresh"), button("このチャンネルで通知", { action: "notification", connector: this.connectorName, channel }, "notifications")] });
    return blocks;
  }
  async execute(token: string, user: string, channel: string): Promise<{ blocks: KnownBlock[]; text: string }> {
    if (!this.authorized(user)) throw new Error("モデル設定の変更は登録済みの管理者だけが行えます。");
    const grant = this.grants.get(token);
    if (!grant || grant.expires < Date.now() || grant.channel !== channel || (grant.user && grant.user !== user)) throw new Error("操作の有効期限が切れました。「モデル設定」を開き直してください。");
    this.grants.delete(token);
    const service = this.service(); if (!service) throw new Error("モデル設定の起動準備中です。");
    const { choice } = grant;
    if (choice.action === "session") {
      const session = grant.sessionKey ? getSessionBySessionKey(grant.sessionKey) : undefined;
      if (!session || session.engine !== choice.engine) throw new Error("この会話のエンジンが変わりました。設定を開き直してください。");
      if (session.status !== "idle" || getQueueItems(session.sessionKey || session.sourceRef).some(q => q.status === "pending" || q.status === "running")) throw new Error("実行中です。処理が終わってから切り替えてください。");
      service.assertAvailable(choice.engine, choice.model);
      updateSession(session.id, { model: choice.model, effortLevel: null });
    } else if (choice.action !== "show") await service.act(choice);
    return { blocks: this.card(channel, user, grant.sessionKey), text: choice.action === "show" ? "モデル設定" : "モデル設定を更新しました。" };
  }
}

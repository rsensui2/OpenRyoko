import { describe, expect, it, vi } from "vitest";
import { SlackConnector } from "../index.js";
import { SlackModelControls } from "../model-controls.js";
import type { ModelManagement } from "../../../models/service.js";

async function fixture() {
  let receive: (args: any) => Promise<void> = async () => {};
  let action: (args: any) => Promise<void> = async () => {};
  const snapshot = vi.fn(() => ({ engines: [], pins: [] }));
  const act = vi.fn(async () => {});
  const controls = new SlackModelControls(() => ({ snapshot, act }) as unknown as ModelManagement, () => "UADMIN", "slack-team");
  const handler = vi.fn(), postEphemeral = vi.fn(async () => ({})), postMessage = vi.fn(async () => ({}));
  const connector = Object.create(SlackConnector.prototype) as SlackConnector;
  Object.assign(connector, { app: {
    action: (_pattern: RegExp, fn: typeof action) => { action = fn; },
    message: (fn: typeof receive) => { receive = fn; }, event: vi.fn(), start: vi.fn(),
    client: { auth: { test: vi.fn(async () => ({ user_id: "UBOT" })) }, chat: { postEphemeral, postMessage } },
  }, modelControls: controls, allowedUsers: new Set(["UADMIN", "UMEMBER"]), handler,
  ignoreOldMessagesOnBoot: false, agentsCanvas: null, respondTo: undefined });
  await connector.start();
  const message = (user: string) => receive({ event: { channel: "C1", user, ts: "123.456", text: "<@UBOT> モデル設定", channel_type: "channel" } });
  return { action: (args: any) => action(args), message, handler, postEphemeral, postMessage, act, controls, connector };
}
describe("Slack model settings integration", () => {
  it("opens an ephemeral card without routing through AI and handles actions after ack", async () => {
    const f = await fixture(); await f.message("UADMIN");
    expect(f.handler).not.toHaveBeenCalled();
    const card = f.postEphemeral.mock.calls[0] as unknown as [{ blocks: any[] }];
    const action = card[0].blocks.at(-1).elements[1];
    const ack = vi.fn(async () => {}), respond = vi.fn(async () => {});
    await f.action({ ack, respond, body: { user: { id: "UADMIN" }, channel: { id: "C1" } }, action });
    expect(ack).toHaveBeenCalledOnce();
    expect(f.act).toHaveBeenCalledWith({ action: "notification", connector: "slack-team", channel: "C1" });
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(f.act.mock.invocationCallOrder[0]);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral", replace_original: false }));
  });
  it("denies non-operators even when allowed to chat; ignores users outside allowFrom", async () => {
    const f = await fixture(); await f.message("UMEMBER");
    expect(f.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("管理者専用") }));
    expect(f.handler).not.toHaveBeenCalled();
    await f.message("UOUTSIDE"); expect(f.postEphemeral).toHaveBeenCalledTimes(1);
    const token = (f.controls.notice("C1", "Notice", "codex", "sol")[1] as any).elements[0].value;
    const respond = vi.fn(async () => {});
    await f.action({ ack: vi.fn(), respond, body: { user: { id: "UMEMBER" }, channel: { id: "C1" } }, action: { value: token } });
    expect(f.act).not.toHaveBeenCalled(); expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("管理者") }));
  });
});

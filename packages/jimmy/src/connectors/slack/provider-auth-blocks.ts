import { NOTICE_INTERVAL_MS } from "../../provider-auth/failure-notices.js";
import { isAuthProvider, PROVIDERS } from "../../provider-auth/index.js";
import type { AuthProvider, FlowOutcome, FlowPrompt, InputResult, StartResult } from "../../provider-auth/index.js";

/**
 * Everything the operator reads during a provider login.
 *
 * Two rules shape these messages:
 *   - The top-level `text` never carries the link or a code. Slack shows it in
 *     push notifications (lock screens), and the connector's own message log
 *     echoes it back for every bot message. Link and code live in `blocks`.
 *   - The link is given as a button `url` and as a plain-text block holding
 *     nothing else. Neither goes through mrkdwn, which would be free to mangle
 *     a long OAuth query string.
 */

type Block = Record<string, unknown>;

export interface SlackAuthMessage {
  text: string;
  blocks: Block[];
}

export type AuthActionKind = "start" | "open" | "input" | "cancel";

export const ACTION_PATTERN = /^ryoko_auth_/;
export const CODE_MODAL = "ryoko_auth_code";
export const CODE_BLOCK = "ryoko_auth_code_block";
export const CODE_INPUT = "ryoko_auth_code_value";
/** Slack rejects a button URL or a text block longer than this. */
const SLACK_TEXT_LIMIT = 3000;

const actionId = (kind: AuthActionKind, provider: AuthProvider) => `ryoko_auth_${kind}_${provider}`;
const label = (provider: AuthProvider) => PROVIDERS[provider].label;
const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: false });
const section = (text: string): Block => ({ type: "section", text: plain(text) });
const note = (text: string): Block => ({ type: "context", elements: [plain(text)] });
const actions = (elements: Block[]): Block => ({ type: "actions", elements });
const say = (text: string): SlackAuthMessage => ({ text, blocks: [section(text)] });

export function parseAuthAction(id: unknown): { kind: AuthActionKind; provider: AuthProvider } | null {
  const match = typeof id === "string" ? /^ryoko_auth_(start|open|input|cancel)_([a-z]+)$/.exec(id) : null;
  if (!match || !isAuthProvider(match[2])) return null;
  return { kind: match[1] as AuthActionKind, provider: match[2] };
}

const startButton = (provider: AuthProvider): Block => ({
  type: "button", action_id: actionId("start", provider), text: plain(`${label(provider)} にログイン`), value: provider,
});

const cancelButton = (provider: AuthProvider, flowId: string): Block => ({
  type: "button", action_id: actionId("cancel", provider), text: plain("キャンセル"), value: flowId,
});

export function menuMessage(): SlackAuthMessage {
  const text = "Claude / Codex のログイン";
  return {
    text,
    blocks: [
      section(`${text}\nログインし直すサービスを選んでください。この DM にログイン用のリンクを送ります。`),
      actions([startButton("claude"), startButton("codex")]),
      note("ボタンを押しても何も起きないときは、Slack アプリの設定で Interactivity を有効にしてください。"),
    ],
  };
}

export function noticeMessage(provider: AuthProvider): SlackAuthMessage {
  const text = `${label(provider)} の認証エラーでターンが失敗しました。ログインの期限が切れている場合は、ここからログインし直せます。`;
  return {
    text,
    blocks: [
      section(text),
      actions([startButton(provider)]),
      note(`この通知は ${NOTICE_INTERVAL_MS / 60_000} 分に 1 回までです。「ログイン」と送ると、いつでもログインのメニューを開けます。`),
    ],
  };
}

export function startingMessage(provider: AuthProvider, flowId: string): SlackAuthMessage {
  const text = `${label(provider)} のログインを始めました。ログイン用のリンクを準備しています…`;
  return { text, blocks: [section(text), actions([cancelButton(provider, flowId)])] };
}

export function stalledMessage(provider: AuthProvider, flowId: string): SlackAuthMessage {
  const text = `${label(provider)} のログイン: CLI の出力からログイン用のリンクを読み取れていません。`;
  return {
    text,
    blocks: [
      section(`${text}\nCLI の表示が変わった可能性があります。キャンセルして、ホスト上で直接ログインしてください。`),
      actions([cancelButton(provider, flowId)]),
    ],
  };
}

function steps(prompt: FlowPrompt): string {
  if (prompt.acceptsInput) {
    return "1. 「ログインページを開く」からサインインして、承認します。\n2. 表示された認証コードをコピーして、「コードを入力」から送ります。";
  }
  return prompt.deviceCode
    ? "1. 「ログインページを開く」からサインインします。\n2. 表示された画面に、下のコードを入力します。承認が済むと自動で完了します。"
    : "1. 「ログインページを開く」からサインインします。\n2. 入力するコードを準備しています…";
}

function promptButtons(prompt: FlowPrompt, url: string | undefined): Block[] {
  const { provider, flowId } = prompt;
  return [
    ...(url ? [{ type: "button", action_id: actionId("open", provider), text: plain("ログインページを開く"), url, style: "primary" }] : []),
    ...(prompt.acceptsInput ? [{ type: "button", action_id: actionId("input", provider), text: plain("コードを入力"), value: flowId }] : []),
    cancelButton(provider, flowId),
  ];
}

export function promptMessage(prompt: FlowPrompt, options: { ttlMinutes: number; submitted: boolean }): SlackAuthMessage {
  const name = label(prompt.provider);
  const url = prompt.url && prompt.url.length <= SLACK_TEXT_LIMIT ? prompt.url : undefined;
  const closing = prompt.acceptsInput
    ? `${options.ttlMinutes} 分で無効になります。認証コードはチャットに貼らず、「コードを入力」から送ってください。`
    : `${options.ttlMinutes} 分で無効になります。このコードは他の人に見せないでください。`;
  return {
    text: options.submitted
      ? `${name} のログイン: 認証コードを受け取りました。確認しています…`
      : `${name} のログイン: リンクを送りました。この DM を開いて続けてください。`,
    blocks: [
      section(`${name} のログイン\n${steps(prompt)}`),
      ...(prompt.deviceCode ? [section(prompt.deviceCode)] : []),
      actions(promptButtons(prompt, url)),
      ...(url ? [note("リンクを開けないときは、次の URL をコピーしてブラウザで開いてください。"), section(url)] : []),
      ...(prompt.url && !url ? [note("ログイン用のリンクが長すぎて表示できません。キャンセルして、ホスト上で直接ログインしてください。")] : []),
      ...(options.submitted ? [note("認証コードを受け取りました。確認しています…（進まないときは、もう一度コードを取得して入力できます）")] : []),
      note(closing),
    ],
  };
}

export function verifyingMessage(provider: AuthProvider): SlackAuthMessage {
  return say(`${label(provider)} のログイン: ログインできたかを確認しています…`);
}

function outcomeText(provider: AuthProvider, outcome: FlowOutcome, ttlMinutes: number): string {
  const name = label(provider);
  if (outcome.status === "succeeded") return `${name} にログインしました。次のメッセージから通常どおり動きます。`;
  if (outcome.status === "expired") return `${name} のログインは ${ttlMinutes} 分以内に完了しなかったため、中止しました。もう一度お試しください。`;
  if (outcome.status === "cancelled") return `${name} のログインをキャンセルしました。`;
  if (outcome.reason === "unverified") return `${name} の CLI は終了しましたが、ログインできたことを確認できませんでした。もう一度お試しください。`;
  if (outcome.reason === "stopped") return `gateway の停止または再読み込みのため、${name} のログインを中断しました。起動後にもう一度お試しください。`;
  return `${name} のログインは完了しませんでした（CLI がエラーで終了しました）。もう一度お試しください。`;
}

/** The final state of a login message: the outcome, and nothing to act on. */
export function settledMessage(provider: AuthProvider, outcome: FlowOutcome, ttlMinutes: number): SlackAuthMessage {
  return say(outcomeText(provider, outcome, ttlMinutes));
}

export function unredactedWarning(message: SlackAuthMessage): SlackAuthMessage {
  return say(`${message.text}\n前のメッセージを伏せられませんでした。ログイン用のリンクやコードが、その中に残っています。`);
}

export function startRefusedMessage(provider: AuthProvider, reason: Extract<StartResult, { ok: false }>["reason"]): SlackAuthMessage {
  const name = label(provider);
  if (reason === "busy") return say(`${name} のログインはすでに進行中です。やり直すときは、進行中のメッセージの「キャンセル」を押してからお試しください。`);
  if (reason === "stopped") return say("gateway を停止しているため、ログインを始められません。");
  return say(`${name} の CLI を起動できませんでした。engines.${provider}.bin の設定と gateway のログを確認してください。`);
}

export function flowEndedMessage(provider: AuthProvider): SlackAuthMessage {
  return say(`この ${label(provider)} のログインは終了しています。「ログイン」と送って、もう一度やり直してください。`);
}

export function modalFailedMessage(slackError: string): SlackAuthMessage {
  return say(`コードを入力する画面を開けませんでした（Slack: ${slackError}）。もう一度押しても開かないときは、Slack アプリの Interactivity と、Bot Token の再インストールを確認してください。`);
}

export function pastedCodeMessage(loginInProgress: boolean): SlackAuthMessage {
  const where = "認証コードはチャットに貼らず、ログインのメッセージにある「コードを入力」ボタンから送ってください。いま貼り付けたメッセージは、ご自身で削除してください。";
  return say(loginInProgress ? where : `進行中のログインはありません。「ログイン」と送ると始められます。\n${where}`);
}

export function inputErrorText(reason: Extract<InputResult, { ok: false }>["reason"]): string {
  if (reason === "invalid") return "コードの形式が正しくありません。ブラウザに表示された認証コード全体（「#」を含む）を貼り付けてください。";
  if (reason === "unsupported") return "このログインでは、コードの入力は必要ありません。";
  if (reason === "no-flow") return "このログインは終了しています。画面を閉じて、もう一度やり直してください。";
  return "コードを CLI に渡せませんでした。画面を閉じて、もう一度やり直してください。";
}

export function codeModal(provider: AuthProvider, flowId: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: CODE_MODAL,
    private_metadata: JSON.stringify({ provider, flowId }),
    title: plain(`${label(provider)} の認証コード`),
    submit: plain("送信"),
    close: plain("閉じる"),
    blocks: [{
      type: "input",
      block_id: CODE_BLOCK,
      label: plain("認証コード"),
      element: { type: "plain_text_input", action_id: CODE_INPUT, focus_on_load: true, max_length: 2048 },
      hint: plain("ブラウザに表示された認証コード全体（「#」を含む）を貼り付けます。localhost の /callback で始まる URL に移動した場合は、その URL 全体でも受け付けます。"),
    }],
  };
}

export function parseModalMetadata(raw: unknown): { provider: AuthProvider; flowId: string } | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { provider?: unknown; flowId?: unknown } | null;
    return parsed && isAuthProvider(parsed.provider) && typeof parsed.flowId === "string"
      ? { provider: parsed.provider, flowId: parsed.flowId }
      : null;
  } catch {
    return null;
  }
}

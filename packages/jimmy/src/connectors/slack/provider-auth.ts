import { containsAuthCode, getProviderAuthService, isOAuthInput, PROVIDERS } from "../../provider-auth/index.js";
import type { AuthProvider, FlowOutcome, FlowPrompt, ProviderAuthPort } from "../../provider-auth/index.js";
import { logger as sharedLogger } from "../../shared/logger.js";
import type { SlackConnectorConfig } from "../../shared/types.js";
import {
  ACTION_PATTERN, CODE_BLOCK, CODE_INPUT, CODE_MODAL, codeModal, flowEndedMessage, inputErrorText, menuMessage,
  modalFailedMessage, noticeMessage, parseAuthAction, parseModalMetadata, pastedCodeMessage, promptMessage,
  settledMessage, stalledMessage, startRefusedMessage, startingMessage, unredactedWarning, verifyingMessage,
  type SlackAuthMessage,
} from "./provider-auth-blocks.js";

/**
 * Re-login to Claude or Codex from the operator's Slack DM.
 *
 * This is the Slack face of `src/provider-auth`: it decides who may use the
 * feature, draws what the flow reports, and takes the code back through a
 * modal. It reacts only to the operator (`portal.operatorSlackId`, strict
 * equality) in their own 1:1 DM with the bot; to anyone else, and anywhere
 * else, it does nothing at all — not even a refusal that would show it exists.
 *
 * A code is never taken from the chat. A bot cannot delete a user's message,
 * so a pasted code would stay in the conversation; the modal keeps it out.
 * Messages the bot itself posted with a link or a device code are rewritten
 * the moment the flow ends, whichever way it ends.
 */

/** The slice of Bolt's web client this module calls. */
export interface SlackAuthClient {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    update(args: Record<string, unknown>): Promise<unknown>;
    delete(args: Record<string, unknown>): Promise<unknown>;
  };
  views: { open(args: Record<string, unknown>): Promise<unknown> };
}

export interface SlackAuthApp {
  // Bolt's listener arguments are payload-specific unions; only a few fields are read here.
  action(pattern: RegExp, listener: (args: any) => Promise<void>): void;
  view(callbackId: string, listener: (args: any) => Promise<void>): void;
}

export interface SlackAuthMessageEvent {
  user?: string;
  bot_id?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SlackProviderAuthOptions {
  client: SlackAuthClient;
  service: ProviderAuthPort;
  getOperatorSlackId: () => string | undefined;
  /** The connector's `allowFrom` gate. The operator has to pass it too. */
  isAllowedUser: (userId: string) => boolean;
  /** A message replayed from before this boot. */
  isStaleEvent: (ts: string | undefined) => boolean;
  logger?: Logger;
}

interface Destination {
  channel: string;
  threadTs?: string;
}

/** One login as this connector shows it: a single message, redrawn in place. */
interface FlowView {
  readonly provider: AuthProvider;
  readonly destination: Destination;
  flowId?: string;
  messageTs?: string;
  prompt?: FlowPrompt;
  stalled: boolean;
  submitted: boolean;
  verifying: boolean;
  outcome?: FlowOutcome;
  lastDrawn?: string;
  /** Draws run one at a time, in order, so an edit never races the post it edits. */
  queue: Promise<void>;
}

const LOGIN_COMMANDS = new Set(["ログイン", "再ログイン", "/login", "login"]);
const STOP_DRAIN_MS = 1_500;
const TAG = "[slack] provider-auth:";

/** Slack's own error code (`missing_scope`, …) — safe to log and to show. */
function slackErrorCode(error: unknown): string {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "request_failed";
}

/** Message text as typed: Slack wraps links in <…> and escapes three characters. */
function typedText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

/** The configured operator, read fresh each time. An unreadable config means nobody is the operator. */
function operatorId(read: () => string | undefined): string | undefined {
  try {
    const id = read();
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export class SlackProviderAuth {
  private readonly client: SlackAuthClient;
  private readonly service: ProviderAuthPort;
  private readonly log: Logger;
  /** Logins this connector is showing, each until its final state has been drawn. */
  private readonly views = new Set<FlowView>();
  private removeNotifier?: () => void;
  private stopped = false;

  constructor(private readonly options: SlackProviderAuthOptions) {
    this.client = options.client;
    this.service = options.service;
    this.log = options.logger ?? sharedLogger;
  }

  register(app: SlackAuthApp): void {
    app.action(ACTION_PATTERN, (args) => this.onAction(args));
    app.view(CODE_MODAL, (args) => this.onCodeSubmitted(args));
    this.removeNotifier = this.service.addNotifier((provider) => this.notify(provider));
  }

  /**
   * Called for every message before the connector logs or routes it. Returns
   * true when the message was a login command or a pasted code and has been
   * dealt with — such a message is never logged, routed, or stored.
   *
   * What counts as a pasted code depends on whether a login is running. With
   * none, only a message that is nothing but an OAuth value: a request that
   * mentions a callback URL stays an ordinary request. With one — ten minutes
   * at most — a code anywhere in the text, in any kind of message (a file
   * upload's caption, a thread reply also sent to the DM).
   */
  async handleMessage(event: SlackAuthMessageEvent): Promise<boolean> {
    if (this.stopped || event.bot_id || !event.channel || event.channel_type !== "im") return false;
    const text = typedText(event.text ?? "");
    const command = !event.subtype && LOGIN_COMMANDS.has(text.toLowerCase());
    const loginInProgress = this.service.hasActiveFlow();
    const pastedCode = !command && (loginInProgress ? containsAuthCode(text) : isOAuthInput(text));
    if ((!command && !pastedCode) || !this.isOperator(event.user)) return false;
    // A replayed command takes the connector's normal old-message drop. A
    // replayed code is swallowed here instead, so that drop never logs it.
    if (this.options.isStaleEvent(event.ts)) return pastedCode;
    const threadTs = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined;
    const destination = { channel: event.channel, threadTs };
    if (command) this.log.info(`${TAG} the operator opened the login menu`);
    else this.log.warn(`${TAG} a login code was pasted into the chat; it was not used and not routed`);
    await this.say(destination, command ? menuMessage() : pastedCodeMessage(loginInProgress));
    return true;
  }

  /** Stop every login this connector is showing and wait briefly for the messages to be blanked. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.removeNotifier?.();
    const views = [...this.views];
    for (const view of views) if (view.flowId) this.service.abort(view.provider, view.flowId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_DRAIN_MS); });
    await Promise.race([Promise.all(views.map((view) => view.queue)), deadline]);
    clearTimeout(timer);
  }

  private isOperator(userId: string | undefined): boolean {
    const operator = operatorId(this.options.getOperatorSlackId);
    return Boolean(userId && operator && userId === operator && this.options.isAllowedUser(userId));
  }

  private async onAction({ ack, body, action }: any): Promise<void> {
    await ack();
    try {
      const parsed = parseAuthAction(action?.action_id);
      const channel: unknown = body?.channel?.id ?? body?.container?.channel_id;
      // Only the operator's own 1:1 DM. Anything else gets the acknowledgement Slack requires, and silence.
      if (!parsed || parsed.kind === "open" || this.stopped) return;
      if (typeof channel !== "string" || !channel.startsWith("D") || !this.isOperator(body?.user?.id)) return;
      const threadTs: unknown = body?.message?.thread_ts ?? body?.container?.thread_ts;
      const destination = { channel, threadTs: typeof threadTs === "string" ? threadTs : undefined };
      if (parsed.kind === "start") await this.startLogin(parsed.provider, destination);
      else if (parsed.kind === "input") await this.openCodeModal(parsed.provider, action?.value, body?.trigger_id, destination);
      else if (!this.service.cancel(parsed.provider, String(action?.value ?? ""))) await this.say(destination, flowEndedMessage(parsed.provider));
    } catch {
      this.log.error(`${TAG} a login action could not be handled`);
    }
  }

  private async startLogin(provider: AuthProvider, destination: Destination): Promise<void> {
    const view: FlowView = { provider, destination, stalled: false, submitted: false, verifying: false, queue: Promise.resolve() };
    const result = await this.service.start(provider, {
      onPrompt: (prompt) => { view.prompt = prompt; this.draw(view); },
      onStalled: () => { view.stalled = true; this.draw(view); },
      onVerifying: () => { view.verifying = true; this.draw(view); },
      // Returning the draw lets the flow engine wait, at shutdown, for the message to be blanked.
      onSettled: (outcome) => { view.outcome = outcome; this.draw(view); return view.queue; },
    });
    if (!result.ok) {
      await this.say(destination, startRefusedMessage(provider, result.reason));
      return;
    }
    view.flowId = result.flowId;
    this.log.info(`${TAG} the operator started a ${PROVIDERS[provider].label} login`);
    if (this.stopped) {
      this.service.abort(provider, result.flowId);
      return;
    }
    this.views.add(view);
    this.draw(view);
  }

  private async openCodeModal(provider: AuthProvider, flowId: unknown, triggerId: unknown, destination: Destination): Promise<void> {
    const active = this.service.activeFlow(provider);
    if (!active || active.flowId !== flowId || !active.acceptsInput) {
      await this.say(destination, flowEndedMessage(provider));
      return;
    }
    try {
      await this.client.views.open({ trigger_id: triggerId, view: codeModal(provider, active.flowId) });
    } catch (error) {
      const code = slackErrorCode(error);
      this.log.warn(`${TAG} Slack refused to open the code dialog (${code})`);
      await this.say(destination, modalFailedMessage(code));
    }
  }

  private async onCodeSubmitted({ ack, body, view }: any): Promise<void> {
    const target = parseModalMetadata(view?.private_metadata);
    const value: unknown = view?.state?.values?.[CODE_BLOCK]?.[CODE_INPUT]?.value;
    if (this.stopped || !target || typeof value !== "string" || !this.isOperator(body?.user?.id)) {
      await ack();
      return;
    }
    const result = this.service.submitInput(target.provider, target.flowId, value);
    if (!result.ok) {
      await ack({ response_action: "errors", errors: { [CODE_BLOCK]: inputErrorText(result.reason) } });
      return;
    }
    await ack();
    const shown = [...this.views].find((candidate) => candidate.provider === target.provider && candidate.flowId === target.flowId);
    if (!shown) return;
    shown.submitted = true;
    this.draw(shown);
  }

  /** Tell the operator a provider's login looks expired. True once Slack has the message. */
  private async notify(provider: AuthProvider): Promise<boolean> {
    const operator = operatorId(this.options.getOperatorSlackId);
    if (this.stopped || !operator || !this.options.isAllowedUser(operator)) return false;
    try {
      // A user ID as the channel posts to that user's DM with the app.
      const message = noticeMessage(provider);
      await this.client.chat.postMessage({ channel: operator, text: message.text, blocks: message.blocks });
    } catch (error) {
      this.log.warn(`${TAG} could not DM the operator about the ${PROVIDERS[provider].label} login (${slackErrorCode(error)})`);
      return false;
    }
    this.log.info(`${TAG} told the operator the ${PROVIDERS[provider].label} login looks expired`);
    return true;
  }

  private messageFor(view: FlowView): SlackAuthMessage {
    const ttlMinutes = Math.round(this.service.flowTtlMs / 60_000);
    if (view.outcome) return settledMessage(view.provider, view.outcome, ttlMinutes);
    if (view.verifying) return verifyingMessage(view.provider);
    if (view.prompt) return promptMessage(view.prompt, { ttlMinutes, submitted: view.submitted });
    return view.stalled ? stalledMessage(view.provider, view.flowId ?? "") : startingMessage(view.provider, view.flowId ?? "");
  }

  /** Queue a redraw of the flow's message from its current state. */
  private draw(view: FlowView): void {
    if (!view.flowId) return;
    view.queue = view.queue
      .then(() => this.redraw(view))
      .catch(() => this.log.warn(`${TAG} a login message could not be shown`));
  }

  private async redraw(view: FlowView): Promise<void> {
    // Decided before drawing: an outcome that arrives while this draw is on
    // its way to Slack belongs to the next one, which `stop()` must still wait for.
    const final = view.outcome !== undefined;
    try {
      const message = this.messageFor(view);
      const drawn = JSON.stringify(message);
      if (drawn === view.lastDrawn) return;
      view.lastDrawn = drawn;
      await this.show(view, message, final);
    } finally {
      if (final) this.views.delete(view);
    }
  }

  private async show(view: FlowView, message: SlackAuthMessage, final: boolean): Promise<void> {
    if (!view.messageTs) {
      view.messageTs = await this.post(view.destination, message);
      return;
    }
    const at = { channel: view.destination.channel, ts: view.messageTs };
    try {
      await this.client.chat.update({ ...at, text: message.text, blocks: message.blocks });
    } catch (error) {
      this.log.warn(`${TAG} a login message could not be edited (${slackErrorCode(error)})`);
      // Only the draw of the outcome may replace the message. An earlier draw
      // that fails after the login has ended still holds the prompt — link,
      // device code, buttons — and posting that would leave it up for good.
      // The outcome's own draw is queued right behind and does the blanking.
      if (final) await this.replaceUneditable(view, at, message);
    }
  }

  /** The message holding the link could not be rewritten: remove it, or say plainly that it is still there.
   *  `outcome` is always the settled message — nothing with a link or a code is ever posted here. */
  private async replaceUneditable(view: FlowView, at: { channel: string; ts: string }, outcome: SlackAuthMessage): Promise<void> {
    let removed = true;
    try {
      await this.client.chat.delete(at);
    } catch (error) {
      removed = false;
      this.log.error(`${TAG} a login message could be neither edited nor removed (${slackErrorCode(error)})`);
    }
    await this.post(view.destination, removed ? outcome : unredactedWarning(outcome));
  }

  private async post(destination: Destination, message: SlackAuthMessage): Promise<string | undefined> {
    const response = await this.client.chat.postMessage({
      channel: destination.channel,
      ...(destination.threadTs ? { thread_ts: destination.threadTs } : {}),
      text: message.text,
      blocks: message.blocks,
    });
    return response.ts;
  }

  /** A one-off reply. A failure to send it is logged and otherwise ignored. */
  private async say(destination: Destination, message: SlackAuthMessage): Promise<void> {
    try {
      await this.post(destination, message);
    } catch (error) {
      this.log.warn(`${TAG} a reply to the operator could not be sent (${slackErrorCode(error)})`);
    }
  }
}

/**
 * Opt-in, per Slack connector: `providerAuth.enabled: true`. Without it — or
 * without a way to tell who the operator is — nothing is created, no listener
 * is registered, and the connector behaves exactly as before.
 */
export function createSlackProviderAuth(
  client: unknown,
  config: Pick<SlackConnectorConfig, "providerAuth">,
  gates: Pick<SlackProviderAuthOptions, "isAllowedUser" | "isStaleEvent"> & { getOperatorSlackId?: () => string | undefined },
): SlackProviderAuth | undefined {
  if (config.providerAuth?.enabled !== true) return undefined;
  if (!gates.getOperatorSlackId) {
    sharedLogger.warn(`${TAG} providerAuth is enabled but this connector cannot identify the operator; it stays off`);
    return undefined;
  }
  if (operatorId(gates.getOperatorSlackId)) {
    sharedLogger.info(`${TAG} enabled — the operator can log in to Claude / Codex again from their DM`);
  } else {
    sharedLogger.warn(`${TAG} providerAuth is enabled but portal.operatorSlackId is not set; it does nothing until it is`);
  }
  return new SlackProviderAuth({
    client: client as SlackAuthClient,
    service: getProviderAuthService(),
    getOperatorSlackId: gates.getOperatorSlackId,
    isAllowedUser: gates.isAllowedUser,
    isStaleEvent: gates.isStaleEvent,
  });
}

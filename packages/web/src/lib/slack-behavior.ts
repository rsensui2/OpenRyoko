/**
 * How the bot behaves in Slack, as plain answers, and the config those answers
 * stand for. The gateway's knobs are `respondTo` (a deterministic gate per DM /
 * group DM / channel, plus per-channel exceptions) and `triage.enabled`
 * (air-reading: decide per message whether to reply, react or stay quiet).
 */

export type RespondMode = "always" | "mention" | "never"

/** "auto" = pass every message to air-reading; "always" = answer everything. */
export type ChannelChoice = "mention" | "auto" | "always" | "never"
export type GroupDmChoice = "same" | RespondMode

export interface SlackBehavior {
  dm: "always" | "never"
  channel: ChannelChoice
  groupDm: GroupDmChoice
  /** Keep replying without a mention in threads the bot already joined. */
  engagedThreads: boolean
  /** Channel id → its own mode. */
  exceptions: Record<string, RespondMode>
}

export interface SlackBehaviorConfig {
  respondTo?: {
    im?: string
    mpim?: string
    channel?: string
    engagedThreads?: boolean
    channels?: Record<string, string | null>
  }
  triage?: { enabled?: boolean }
}

/** What saving writes: every gate field, removed exceptions as null. */
export interface SlackBehaviorPatch {
  respondTo: { im: string; mpim: string; channel: string; engagedThreads: boolean; channels: Record<string, string | null> }
  triage?: { enabled: boolean }
}

function mode(raw: unknown): RespondMode {
  return raw === "mention" || raw === "never" ? raw : "always"
}

function channelChoice(respond: RespondMode, triageOn: boolean): ChannelChoice {
  if (respond === "always") return triageOn ? "auto" : "always"
  return respond
}

/** The gate mode a channel choice writes. */
function channelGate(choice: ChannelChoice): RespondMode {
  return choice === "auto" ? "always" : choice
}

export function behaviorFromConfig(slack: SlackBehaviorConfig | undefined): SlackBehavior {
  const respondTo = slack?.respondTo ?? {}
  const triageOn = slack?.triage?.enabled === true
  const channel = channelChoice(mode(respondTo.channel), triageOn)
  const groupMode = mode(respondTo.mpim)
  const exceptions: Record<string, RespondMode> = {}
  for (const [id, value] of Object.entries(respondTo.channels ?? {})) {
    if (value === "always" || value === "mention" || value === "never") exceptions[id] = value
  }
  return {
    dm: mode(respondTo.im) === "never" ? "never" : "always",
    channel,
    groupDm: groupMode === channelGate(channel) ? "same" : groupMode,
    engagedThreads: respondTo.engagedThreads !== false,
    exceptions,
  }
}

/**
 * The partial config to save. Exceptions removed since loading are sent as
 * null, because the gateway deep-merges and would otherwise keep them.
 * Air-reading is only switched by the choices that decide it: "auto" turns it
 * on, "always" turns it off; "mention" and "never" leave it as it was.
 */
export function behaviorToConfigPatch(behavior: SlackBehavior, loaded: SlackBehavior): SlackBehaviorPatch {
  const gate = channelGate(behavior.channel)
  const channels: Record<string, string | null> = {}
  for (const id of Object.keys(loaded.exceptions)) {
    if (!(id in behavior.exceptions)) channels[id] = null
  }
  Object.assign(channels, behavior.exceptions)
  const patch: SlackBehaviorPatch = {
    respondTo: {
      im: behavior.dm,
      mpim: behavior.groupDm === "same" ? gate : behavior.groupDm,
      channel: gate,
      engagedThreads: behavior.engagedThreads,
      channels,
    },
  }
  if (behavior.channel === "auto") return { ...patch, triage: { enabled: true } }
  if (behavior.channel === "always") return { ...patch, triage: { enabled: false } }
  return patch
}

/** True when some answer makes a mention matter (the thread question applies). */
export function usesMentions(behavior: SlackBehavior): boolean {
  return behavior.channel === "mention" || behavior.groupDm === "mention" || Object.values(behavior.exceptions).includes("mention")
}

const MODE_TEXT: Record<RespondMode, string> = {
  always: "すべてのメッセージに返事します",
  mention: "@メンションされたときだけ返事します",
  never: "話しません",
}

const CHANNEL_TEXT: Record<ChannelChoice, string> = {
  mention: "@メンションされたときだけ返事します",
  auto: "会話を読んで、自分に向けた話や手伝えそうな話にだけ加わります（空気読み）",
  always: "すべてのメッセージに返事します",
  never: "話しません",
}

/** "What will happen", one line per kind of place. */
export function describeBehavior(behavior: SlackBehavior, channelName: (id: string) => string = (id) => id): string[] {
  const lines = [
    `1対1の DM: ${behavior.dm === "always" ? "いつも返事します" : "返事しません"}`,
    `チャンネル: ${CHANNEL_TEXT[behavior.channel]}`,
    `グループ DM: ${behavior.groupDm === "same" ? CHANNEL_TEXT[behavior.channel] : MODE_TEXT[behavior.groupDm]}`,
  ]
  if (usesMentions(behavior)) {
    lines.push(behavior.engagedThreads
      ? "一度返事したスレッドでは、メンションがなくても続けて返事します"
      : "スレッドでも、毎回メンションが必要です")
  }
  for (const [id, value] of Object.entries(behavior.exceptions)) {
    lines.push(`#${channelName(id)} だけは: ${MODE_TEXT[value]}`)
  }
  return lines
}

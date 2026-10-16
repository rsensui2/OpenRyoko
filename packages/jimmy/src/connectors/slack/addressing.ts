/**
 * Who a Slack message can be addressed to, from facts Slack records.
 *
 * Pure helpers for the connector's routing gates. The air-reading gate is for
 * deciding whether a message is meant for the bot; when the thread itself shows
 * that nobody but the speaker and the bot are present, there is nothing to read.
 */
import type { ThreadSpeaker } from "./triage-context.js";

/** Slack's own system user, which posts notices into threads. */
export const SLACKBOT_USER_ID = "USLACKBOT";

const USER_MENTION = /<@([UW][A-Z0-9]+)>/g;
const OPENING_USER_MENTION = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/;
// @here, @channel, @everyone and user groups address people other than the bot.
const OPENING_GROUP_MENTION = /^<!(?:here|channel|everyone|subteam\^[A-Z0-9]+)(?:\|[^>]*)?>/;
// Quote markers (Slack escapes ">" as "&gt;"), bullets and emphasis can
// precede an opening mention.
const LEADING_DECORATION = /^(?:[\s>*_~•・-]|&gt;)+/u;
// A short greeting can come before the mention that addresses someone.
const LEADING_GREETING = /^(?:お疲れ様です|お疲れさまです|おつかれさまです|お疲れ様|お疲れさま|おつかれさま|お世話になっております|おはようございます|おはよう|こんにちは|こんばんは|hi|hello|hey)(?=[\s!！。、,.<]|$)[\s!！。、,.]*/iu;
// A message an app sends on a person's behalf carries this footer, seen in a
// Japanese workspace as "*使用して送信されました* <@app>"; "Sent using" is the
// assumed English wording. The mention names the app, not an addressee.
const SENT_USING_FOOTER = /\*(?:Sent using|使用して送信されました)\*\s*<@[UW][A-Z0-9]+>/gu;

/** The user IDs @-mentioned in a message, other than the bot and an app's footer. */
export function mentionsOfOthers(text: string, botUserId: string): string[] {
  const body = text.replace(SENT_USING_FOOTER, " ");
  return Array.from(body.matchAll(USER_MENTION), (match) => match[1])
    .filter((id) => id !== botUserId);
}

/**
 * True when a message opens by @-mentioning someone other than the bot, or a
 * group, after any formatting and a short greeting: the usual way to address
 * them. A mention further into the message does not count.
 */
export function opensByAddressingOthers(text: string, botUserId: string): boolean {
  const opening = text.replace(LEADING_DECORATION, "")
    .replace(LEADING_GREETING, "")
    .replace(LEADING_DECORATION, "");
  if (OPENING_GROUP_MENTION.test(opening)) return true;
  const user = OPENING_USER_MENTION.exec(opening);
  return user !== null && user[1] !== botUserId;
}

/**
 * True when a thread's complete history shows that the bot has posted in it
 * and that nobody but this person has spoken otherwise (Slackbot notices
 * aside). Anything less certain — a partial history, an unknown bot ID, an
 * unattributed message, another person, bot or app — is not a solo thread.
 */
export function isSoloThread(input: {
  speakers: readonly ThreadSpeaker[] | undefined;
  incomplete: boolean;
  botUserId: string | null | undefined;
  userId: string;
}): boolean {
  const { speakers, botUserId, userId } = input;
  if (input.incomplete || !speakers || !botUserId) return false;
  let botSpoke = false;
  for (const speaker of speakers) {
    if (speaker.user === botUserId) {
      botSpoke = true;
    } else if (speaker.user !== SLACKBOT_USER_ID && (speaker.botId || speaker.user !== userId)) {
      return false;
    }
  }
  return botSpoke;
}

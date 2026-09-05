/**
 * Pure prompt builder for Slack air-reading triage.
 *
 * The triage LLM is given the incoming message plus light context and
 * must respond with a single JSON decision: silent / react / reply.
 *
 * Kept pure (no I/O) so it can be snapshot-tested without spawning
 * a subprocess.
 */

export interface TriagePromptInput {
  /** Display name of the bot itself (e.g. "Ryoko", "Jinn") */
  botName: string;
  /** Short persona description — what this bot is good at */
  persona?: string;
  /** Name of the operator who owns this Jinn instance */
  operatorName?: string;
  /** Channel type: "im" (DM), "channel", "group", "mpim" etc. */
  channelType: string;
  /** Human-readable channel identifier (e.g. "#general" or "DM") */
  channelDescription: string;
  /** Display name of the speaker */
  speakerName: string;
  /** Whether the speaker is the operator of this Jinn */
  speakerIsOperator: boolean;
  /** Whether the bot was explicitly @-mentioned in the message */
  wasMentioned: boolean;
  /** Recent messages in the thread for context — oldest first */
  recentThread: Array<{ speaker: string; text: string; isBot?: boolean }>;
  /** The message being triaged */
  messageText: string;
  /** True when this is an established 1:1 conversation with the bot (DM-equivalent):
   *  the message IS implicitly addressed to the bot, so the decision space is
   *  react-vs-reply — "silent" (ghosting) is not acceptable here. */
  dmEquivalent?: boolean;
}

export interface TriageDecision {
  action: "silent" | "react" | "reply";
  emoji?: string;
  reason?: string;
}

const MAX_MESSAGE_CHARS = 2000;
const MAX_THREAD_ITEM_CHARS = 300;
const MAX_THREAD_ITEMS = 10;

/** Upper bound (code points) for a message to qualify as a short-ack candidate. */
export const SHORT_ACK_MAX_CHARS = 30;

// Keep the react-only fast path deliberately narrow. Assents such as "はい",
// "OK", and "了解" are not safe here: when the bot has asked for approval,
// they are task-continuation messages and must reach the session engine.
const SAFE_SHORT_ACK_RE = /^(?:ありがと(?:う(?:ございます|ございました)?)?|どうもありがとう(?:ございます|ございました)?|助かりました|助かります|感謝(?:です|します)?|なるほど|たしかに|確かに|thanks?|thank\s+you|thx|ty|got\s+it|understood|noted|makes\s+sense)$/iu;
const EMOJI_ONLY_ACK_RE = /^(?::[a-z0-9_+\-]+:|[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\s]+)$/iu;

// These emoji commonly mean "approved / proceed", so treating them as a
// terminal acknowledgment can strand a task after the bot asks permission.
const TASK_CONTINUATION_EMOJI_RE = /^(?:(?::(?:ok_hand|white_check_mark|heavy_check_mark|ballot_box_with_check|thumbsup|raised_hands|raising_hand|o2):)|[ \t]|👌|✅|☑️?|✔️?|🆗|🙆(?:‍[♀♂]️?)?|🙋(?:‍[♀♂]️?)?|🙌|👍[\p{Emoji_Modifier}]?)+$/iu;

const TASK_CONTINUATION_TEXT_RE = /^(?:go|go\s+ahead|continue|proceed|do\s+it|ship\s+it|run\s+it|resume|start|yes|yep|yeah|ok(?:ay)?|sure|please|はい|うん|了解(?:です)?|承知(?:しました)?|お願い(?:します)?|続けて|進めて|やって|実行して|再開して|対応して|修正して|作って|調べて|確認して|送って|公開して|投稿して|コミットして|プッシュして|リリースして|デプロイして)$/iu;

function normalizeShortAck(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    // Decoration around an otherwise unambiguous thank-you must not turn it
    // into an instruction candidate. Emoji-only messages are checked first.
    .replace(/[!！。.,、〜~\s\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]+$/gu, "")
    .trim();
}

function normalizeTaskContinuation(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[!！。.,、〜~\s]+$/gu, "")
    .trim();
}

/** True when a short message can authorize or continue pending work. */
export function isTaskContinuationCandidate(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || [...t].length > SHORT_ACK_MAX_CHARS) return false;
  if (TASK_CONTINUATION_EMOJI_RE.test(t)) return true;

  const normalized = normalizeTaskContinuation(t);
  if (TASK_CONTINUATION_TEXT_RE.test(normalized)) return true;

  // Allow a trailing celebratory emoji without hiding the actionable text.
  const withoutEmojiDecoration = normalized
    .replace(/[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]+$/gu, "")
    .trim();
  return TASK_CONTINUATION_TEXT_RE.test(withoutEmojiDecoration);
}

/** Pure routing rule used by the connector before invoking react-only triage. */
export function shouldRunReactOnlyTriage(input: {
  channelType: string;
  isDmEquivalent: boolean;
  wasMentioned: boolean;
  attachmentCount: number;
  text: string;
}): boolean {
  return (
    (input.channelType === "im" || input.isDmEquivalent) &&
    !input.wasMentioned &&
    input.attachmentCount === 0 &&
    isShortAckCandidate(input.text)
  );
}

/** Safety net for stale conversation tracking or an over-eager LLM decision. */
export function shouldForceTaskContinuationReply(input: {
  text: string;
  dmEquivalent: boolean;
  previousWasBot?: boolean;
}): boolean {
  return (
    isTaskContinuationCandidate(input.text) &&
    (input.dmEquivalent || input.previousWasBot === true)
  );
}

/**
 * Cheap lexical pre-filter for the DM-equivalent short-ack exception. Only
 * messages that unambiguously close the exchange (thanks, appreciation, or an
 * emoji by itself) may enter react-only triage. Assents and go-aheads are
 * intentionally excluded: "はい" / "OK" / "了解" can answer a question the
 * bot asked and must reach the session so the task can continue.
 */
export function isShortAckCandidate(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if ([...t].length > SHORT_ACK_MAX_CHARS) return false;
  if (/[?？]/.test(t)) return false;
  if (/https?:\/\//.test(t)) return false;
  if (/<[@#!]/.test(t)) return false; // user/channel/special mentions
  if (t.startsWith("/")) return false; // control slash commands
  if (isTaskContinuationCandidate(t)) return false;
  if (EMOJI_ONLY_ACK_RE.test(t)) return true;
  return SAFE_SHORT_ACK_RE.test(normalizeShortAck(t));
}

export function buildTriagePrompt(input: TriagePromptInput): string {
  const {
    botName,
    persona,
    operatorName,
    channelType,
    channelDescription,
    speakerName,
    speakerIsOperator,
    wasMentioned,
    recentThread,
    messageText,
    dmEquivalent,
  } = input;

  const personaBlock = persona?.trim()
    ? persona.trim()
    : `${botName} is a helpful AI assistant embedded in Slack.`;

  const operatorBlock = operatorName?.trim()
    ? `The operator (who runs this Jinn instance) is **${operatorName.trim()}**.`
    : `No operator has been configured.`;

  const speakerRole = speakerIsOperator
    ? "the operator of this Jinn instance"
    : "NOT the operator — a different person";

  const threadItems = recentThread
    .slice(-MAX_THREAD_ITEMS)
    .map((m) => {
      const text = (m.text ?? "").trim().slice(0, MAX_THREAD_ITEM_CHARS);
      return `- [${m.speaker}] ${text}`;
    })
    .join("\n");
  const threadBlock = threadItems.length > 0 ? threadItems : "(no prior messages in this thread)";

  const truncatedMessage = messageText.length > MAX_MESSAGE_CHARS
    ? messageText.slice(0, MAX_MESSAGE_CHARS) + "\n…(truncated)"
    : messageText;

  return `You are a TRIAGE classifier for ${botName}, an AI assistant on Slack.
You decide whether ${botName} should respond to a specific incoming message.

# Output format (STRICT)
Output EXACTLY ONE JSON object, nothing else. No markdown, no prose, no code fences.
Schema:
  {"action": "silent" | "react" | "reply", "emoji": "<slack-emoji-name>", "reason": "<=30 chars"}

- "silent" — do absolutely nothing. No reply, no reaction. The bot stays invisible.
- "react"  — add ONE emoji reaction and nothing else (no text reply). Choose a Slack emoji name without colons (e.g. "eyes", "thumbsup", "pray", "ok_hand", "dog", "white_check_mark").
- "reply"  — ${botName} should write a real text response.

"emoji" is required only when action = "react". Omit or leave empty otherwise.

# About ${botName}
${personaBlock}

# Operator
${operatorBlock}

# Current context
- Channel: ${channelDescription} (type: ${channelType})
- Speaker: ${speakerName} — ${speakerRole}
- Was ${botName} explicitly @-mentioned in this message? ${wasMentioned ? "YES" : "no"}${dmEquivalent ? `
- Established 1:1 conversation: YES — ${botName} has been engaged here and no third party has joined. The message IS implicitly addressed to ${botName}.` : ""}

# Recent thread (for context only — not the message to triage)
${threadBlock}

# The message to triage
"""
${truncatedMessage}
"""

${dmEquivalent ? `# Decision rules (1:1 conversation — the message IS addressed to ${botName}; NEVER choose "silent")
1. If the message is ONLY appreciation that CLOSES the exchange and cannot authorize work
   (e.g. "ありがとう", "thanks", "なるほど", "助かりました", "🙏") → "react" with a fitting emoji.
2. ANYTHING else → "reply". This includes questions, instructions, go-aheads and continuations
   ("GO", "続けて", "お願いします", "やって"), a "はい"/"OK" that answers a question ${botName} asked
   (check the recent thread — if ${botName}'s last message asked something or offered to proceed,
   the acknowledgment is a go-ahead → "reply"), corrections, feedback expecting action, or new information.

# Principles (these override the rules when in tension)
- A missed request is far worse than a redundant reply here. When unsure → "reply".
- Choose "react" only when a single emoji FULLY satisfies the message and no action is expected.` : `# Decision rules (apply in order, stop at first match)
1. If the message approves, authorizes, or continues work ${botName} proposed
   (e.g. "GO", "はい", "OK", "了解", "続けて", "お願いします", "👌", "✅") → "reply".
2. If the message is pure appreciation directed at ${botName}'s prior reply and expects no action
   (e.g. "ありがとう", "thanks", "なるほど", "助かりました", "🙏") → "react" with a fitting emoji.
3. If the message is clearly addressed to ${botName} (called by name, imperative aimed at the bot,
   continuation of a 1:1 exchange) → "reply".
4. If the topic clearly matches ${botName}'s expertise AND ${botName} can contribute concrete,
   wanted value (not just chitchat) → "reply".
5. If the message is a natural social moment a present, attentive teammate would acknowledge with a
   light touch — a shared win or good news, a milestone, a greeting to the room, a bit of warmth or
   humor — and a full text reply would be too much → "react" with a fitting emoji
   (e.g. "tada", "raised_hands", "eyes", "fire", "pray", "clap"). Read the room like a human who is
   *around* and paying attention, not interrupting.
6. Otherwise → "silent".

# Principles (these override the rules when in tension)
- Asymmetry is the whole game: be CONSERVATIVE with "reply" (text), but GENEROUS with "react" (one emoji).
  An uninvited text reply is an intrusion; a well-timed emoji is just presence — the cost is near zero.
- Never write a text reply just to be polite or to say "I see" / "interesting" — add real value, or
  "react" instead, or stay silent.
- Never barge into a private or serious exchange between other people with text. A single quiet emoji
  may still fit; if even that feels intrusive, choose "silent".
- For "reply": if your confidence that a *text* response is actually wanted is below ~60%, do not reply —
  downgrade to "react" when a light acknowledgment fits, otherwise "silent".
- For "react": when a human teammate who had been reading along would naturally drop an emoji, do it.
  Lightweight warmth and presence are the point here, not suppression.`}

# Output
Produce the JSON object now. Do not explain. Do not wrap in a code block. JSON only.`;
}

/**
 * Parse the triage LLM output into a TriageDecision.
 * Tolerates:
 *   - whitespace / leading/trailing prose
 *   - markdown code fences (```json ... ```)
 *   - emoji written with surrounding colons (":eyes:" → "eyes")
 * Returns null if no valid decision can be extracted.
 */
export function parseTriageDecision(raw: string): TriageDecision | null {
  if (!raw) return null;

  // Strip markdown code fences if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;

  // Find the first {...} block
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const action = obj.action;
  if (action !== "silent" && action !== "react" && action !== "reply") return null;

  const rawEmoji = typeof obj.emoji === "string" ? obj.emoji.trim() : "";
  const emoji = rawEmoji.replace(/^:+|:+$/g, "") || undefined;
  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 120) : undefined;

  // Action "react" requires an emoji; default to eyes if missing
  if (action === "react" && !emoji) {
    return { action, emoji: "eyes", reason };
  }

  return { action, emoji, reason };
}

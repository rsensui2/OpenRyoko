/**
 * Reply disposition — audience separation for engine output.
 *
 * Problem: an engine's final answer is delivered verbatim to the originating
 * conversation. When the model writes an operator-facing status report (drafts,
 * file IDs, approval waits) as its final answer, that internal content leaks to
 * an external channel. See docs/plans/2026-06-18-reply-disposition-design.md.
 *
 * This module is the single, engine-agnostic chokepoint: every engine converges
 * on `EngineResult.result` (a plain string), so parsing/sanitizing here covers
 * claude-interactive, claude-print, codex, gemini and mock uniformly.
 *
 * Wire format (opt-in, fail-closed): the model MAY append a trailer whose last
 * non-empty line is an HTML-comment sentinel carrying base64url-encoded JSON:
 *
 *   <public-facing reply>
 *
 *   <!--RYOKO-DISPOSITION:v1:eyJpbnRlcm5hbCI6Ii4uLiJ9-->
 *
 * - No sentinel → the whole text is the public reply (backward compatible).
 * - Sentinel present but undecodable → fail CLOSED: post only the text before
 *   the sentinel; never restore the whole text, never expose internal.
 */

import type { Target } from "../shared/types.js";

export interface DispositionPayload {
  /** Operator-facing note. Never posted to the originating channel. */
  internal?: string;
  /** Emoji name (with or without surrounding colons) for a react-only reply. */
  react?: string;
  /** Suppress the public body, leaving only a react/ack. */
  suppressPublic?: boolean;
}

export interface ParsedDisposition {
  /** Text before the sentinel (or the whole text when no sentinel). */
  publicText: string;
  payload: DispositionPayload;
  hadSentinel: boolean;
  decodeError: boolean;
}

export interface DeliveryContext {
  /** True when @-mentioned or triage decided "reply" — i.e. we owe a response. */
  addressed: boolean;
  /** True for externally-shared/org-shared channels, or when unknown (safe). */
  channelExternal: boolean;
  /** True for 1:1 DM with the operator — audience separation is OFF here. */
  isDM: boolean;
  /** True when the connector supports emoji reactions. */
  canReact: boolean;
}

export type PublicAction =
  | { kind: "reply"; text: string }
  | { kind: "react"; emoji: string }
  | { kind: "none" };

export interface Delivery {
  publicAction: PublicAction;
  /** Operator-facing note to persist (session log), never posted publicly. */
  internal?: string;
}

/** Safe acknowledgment used to honor "addressed ⇒ never silent". */
export const SAFE_ACK = "確認しました。追って対応します。";

// Match the sentinel by SHAPE (permissive payload capture), so a malformed
// payload is still recognized as a sentinel and stripped — never posted whole.
// base64url has no ">", so `[^>]*` cannot over-run the closing "-->".
const SENTINEL_RE = /^<!--RYOKO-DISPOSITION:v1:([^>]*)-->$/;

function normalizeEmoji(name: string): string {
  return name.trim().replace(/^:+|:+$/g, "");
}

/**
 * Parse the trailer convention. Pure; performs no side effects.
 */
export function parseDisposition(text: string): ParsedDisposition {
  const raw = text ?? "";
  const lines = raw.split("\n");

  // Find the last non-empty line.
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === "") lastIdx--;

  if (lastIdx < 0) {
    return { publicText: "", payload: {}, hadSentinel: false, decodeError: false };
  }

  const match = SENTINEL_RE.exec(lines[lastIdx].trim());
  if (!match) {
    return { publicText: raw.trimEnd(), payload: {}, hadSentinel: false, decodeError: false };
  }

  // Everything before the sentinel line is the public body.
  const publicText = lines.slice(0, lastIdx).join("\n").trimEnd();

  let payload: DispositionPayload = {};
  let decodeError = false;
  try {
    const json = Buffer.from(match[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const p = parsed as Record<string, unknown>;
      payload = {
        internal: typeof p.internal === "string" ? p.internal : undefined,
        react: typeof p.react === "string" ? p.react : undefined,
        suppressPublic: p.suppressPublic === true,
      };
    } else {
      decodeError = true;
    }
  } catch {
    // fail-closed: drop the sentinel, keep only the pre-sentinel public body,
    // and do NOT surface any internal content.
    decodeError = true;
  }

  return { publicText, payload, hadSentinel: true, decodeError };
}

/**
 * Resolve a single engine output string into a public action + internal note,
 * enforcing the invariants. Pure; the caller performs the actual side effects.
 */
export function normalizeDelivery(rawText: string, ctx: DeliveryContext): Delivery {
  const parsed = parseDisposition(rawText);

  // DM with the operator: audience separation is OFF. Show everything
  // (public body + internal note), dropping only the sentinel syntax.
  if (ctx.isDM) {
    const merged = [parsed.publicText, parsed.payload.internal]
      .filter((s): s is string => Boolean(s && s.trim()))
      .join("\n\n");
    const text = merged.trim() || rawText.trim();
    if (text) return { publicAction: { kind: "reply", text } };
    return ctx.addressed
      ? { publicAction: { kind: "reply", text: SAFE_ACK } }
      : { publicAction: { kind: "none" } };
  }

  const internal = parsed.payload.internal?.trim() || undefined;
  const hasBody = parsed.publicText.trim().length > 0;
  const wantsReactOnly =
    parsed.payload.suppressPublic === true || (!hasBody && Boolean(parsed.payload.react));

  let publicAction: PublicAction;
  if (wantsReactOnly) {
    publicAction = parsed.payload.react
      ? { kind: "react", emoji: normalizeEmoji(parsed.payload.react) }
      : { kind: "none" };
  } else if (hasBody) {
    publicAction = { kind: "reply", text: parsed.publicText.trim() };
  } else if (parsed.payload.react) {
    publicAction = { kind: "react", emoji: normalizeEmoji(parsed.payload.react) };
  } else {
    publicAction = { kind: "none" };
  }

  // Invariant: a react on a connector that can't react degrades to a reply.
  if (publicAction.kind === "react" && !ctx.canReact) {
    publicAction = { kind: "reply", text: SAFE_ACK };
  }

  // Invariant: addressed ⇒ never silent.
  if (ctx.addressed && publicAction.kind === "none") {
    publicAction = { kind: "reply", text: SAFE_ACK };
  }

  return internal ? { publicAction, internal } : { publicAction };
}

/** Minimal connector surface needed to perform a public action. */
export interface PublicDeliverer {
  replyMessage(target: Target, text: string): Promise<string | void>;
  addReaction(target: Target, emoji: string): Promise<void>;
}

/**
 * Perform a single resolved public action. Reply errors propagate (callers that
 * want best-effort wrap with `.catch`); reaction errors are swallowed.
 */
export async function deliverPublic(
  connector: PublicDeliverer,
  target: Target,
  action: PublicAction,
): Promise<void> {
  if (action.kind === "reply") {
    await connector.replyMessage(target, action.text);
  } else if (action.kind === "react") {
    await connector.addReaction(target, action.emoji).catch(() => {});
  }
  // kind === "none" → intentionally post nothing
}

export interface TurnsDelivery {
  /** Public actions to perform in order (internal stripped from each). */
  actions: PublicAction[];
  /** Collected internal notes to persist. */
  internals: string[];
}

/**
 * Batch-normalize multi-turn (`/goal`) output. Internal notes are stripped from
 * every turn. We do NOT ack per turn; if no turn yields a public reply/react and
 * we're addressed, a single safe ack is appended (avoids ack multiplication).
 */
export function normalizeTurns(turns: string[], ctx: DeliveryContext): TurnsDelivery {
  const actions: PublicAction[] = [];
  const internals: string[] = [];
  // Per-turn we must not auto-ack: pass addressed=false so empties become "none".
  const perTurnCtx: DeliveryContext = { ...ctx, addressed: false };

  for (const turn of turns) {
    if (!turn || !turn.trim()) continue;
    const d = normalizeDelivery(turn, perTurnCtx);
    if (d.internal) internals.push(d.internal);
    if (d.publicAction.kind !== "none") actions.push(d.publicAction);
  }

  if (ctx.addressed && actions.length === 0) {
    actions.push({ kind: "reply", text: SAFE_ACK });
  }

  return { actions, internals };
}

import type { SessionPageCursor } from "../sessions/registry.js";

export function encodeSessionCursor(cursor: SessionPageCursor | null): string | null {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

export function decodeSessionCursor(raw: string | null): SessionPageCursor | undefined {
  if (!raw) return undefined;
  if (raw.length > 2048) throw new Error("cursor is too long");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    throw new Error("cursor is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("cursor is invalid");
  const value = parsed as Record<string, unknown>;
  if (typeof value.lastActivity !== "string" || !value.lastActivity || typeof value.id !== "string" || !value.id) {
    throw new Error("cursor is invalid");
  }
  return { lastActivity: value.lastActivity, id: value.id };
}

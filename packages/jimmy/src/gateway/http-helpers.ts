/**
 * Shared HTTP request-body helpers used by gateway/api.ts and the per-domain
 * router modules. Error responses written here are tiny
 * (well under the compression threshold), so plain uncompressed JSON writes
 * are behaviour-identical to route-helpers.ts's compressing json() helper.
 */
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";

/** Signals that a request body exceeded the per-handler size cap. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds maximum allowed size");
    this.name = "BodyTooLargeError";
  }
}

export interface ReadBodyOpts {
  /** Hard cap on bytes accepted from the stream; rejects with BodyTooLargeError when exceeded. */
  maxBytes?: number;
}

export interface ReadJsonBodyOpts extends ReadBodyOpts {
  /** Treat an empty/whitespace-only body as `{ ok: true, body: null }` instead of a 400. */
  allowEmpty?: boolean;
  /** Route-specific fixed body for JSON syntax/duplicate-key rejection. */
  invalidJsonResponse?: unknown;
  invalidJsonStatus?: number;
  /** Reject ambiguous duplicate top-level object members. */
  rejectDuplicateTopLevelKeys?: boolean;
  /** Route-specific fixed body for an exceeded maxBytes limit. */
  tooLargeResponse?: unknown;
}

function hasDuplicateTopLevelObjectKeys(raw: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let stringStart = -1;
  let expectingTopLevelKey = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (stringStart >= 0) {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char !== '"') continue;
      if (depth === 1 && expectingTopLevelKey) {
        const key = JSON.parse(raw.slice(stringStart, i + 1)) as string;
        if (seen.has(key)) return true;
        seen.add(key);
        expectingTopLevelKey = false;
      }
      stringStart = -1;
      continue;
    }
    if (char === '"') {
      stringStart = i;
    } else if (char === "{" || char === "[") {
      depth++;
      if (depth === 1 && char === "{") expectingTopLevelKey = true;
    } else if (char === "}" || char === "]") {
      depth--;
    } else if (char === "," && depth === 1) {
      expectingTopLevelKey = true;
    }
  }
  return false;
}

export function readBody(req: HttpRequest, opts: ReadBodyOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const max = opts.maxBytes;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (max !== undefined && total > max) {
        // Over the cap: reject WITHOUT touching the socket. Destroying here tore
        // down the connection before the caller's 413 could reach the wire, so
        // real HTTP clients saw a bare "fetch failed" instead of the structured
        // error (Codex GRS-015 finding 2). Instead, stop BUFFERING but keep
        // DISCARDING inbound chunks so the exchange completes and the response is
        // deliverable; a hard ceiling (8× the cap) still cuts off a sender that
        // never stops (local-machine threat model — compatibility first, with a
        // bounded worst case).
        req.off("data", onData);
        chunks.length = 0;
        req.on("data", (later: Buffer) => {
          total += later.length;
          if (total > max * 8) req.destroy();
        });
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function readBodyRaw(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function errorJson(res: ServerResponse, data: unknown, status: number): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function readJsonBody(
  req: HttpRequest,
  res: ServerResponse,
  opts: ReadJsonBodyOpts = {},
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let raw: string;
  try {
    raw = await readBody(req, opts);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // The 413 is written while the client may still be uploading (readBody now
      // drains instead of destroying — the response must actually reach the wire).
      // Connection: close tells the client not to reuse the exchange.
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify(opts.tooLargeResponse ?? { error: "Payload too large" }));
      return { ok: false };
    }
    throw err;
  }
  if (opts.allowEmpty && !raw.trim()) return { ok: true, body: null };
  try {
    const body: unknown = JSON.parse(raw);
    if (opts.rejectDuplicateTopLevelKeys && hasDuplicateTopLevelObjectKeys(raw)) {
      errorJson(res, opts.invalidJsonResponse ?? { error: "Invalid JSON in request body" }, opts.invalidJsonStatus ?? 400);
      return { ok: false };
    }
    return { ok: true, body };
  } catch {
    errorJson(res, opts.invalidJsonResponse ?? { error: "Invalid JSON in request body" }, opts.invalidJsonStatus ?? 400);
    return { ok: false };
  }
}

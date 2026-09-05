import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { logger } from "../shared/logger.js";

const MAX_UPSTREAM_ATTEMPTS = 3;

function retryBackoffMs(attempt: number): number {
  return attempt === 0 ? 100 : 300;
}

/** Kill an upstream connection that goes silent this long (no bytes). Generous so
 *  long extended-thinking pauses and slow first-token never trip it; only a truly
 *  hung/half-open socket is reaped. */
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** A parsed Anthropic SSE event's `data:` JSON payload (already JSON.parsed). */
export interface SseDataEvent {
  type?: string;
  [k: string]: unknown;
}

/** Per-request stream context handed to onEvent. `subAgent` is set when the request
 *  is a Task sub-agent (so the chat pane can route its deltas into a card); absent
 *  for the main agent. */
export interface StreamCtx {
  subAgent?: { id: string; label?: string };
}

/** A per-agent-identity signature for the request's `system`, using ONLY the first
 *  system content block (the static role/instruction prompt). Claude Code appends a
 *  DYNAMIC env/date block to `system` that changes per request — hashing the whole
 *  thing would mint a new id every turn (→ a flood of duplicate sub-agent cards) and
 *  could even drift the main agent's fingerprint. The first block is byte-stable
 *  across an agent's turns and distinct per agent type. Fail-open: unknown shape →
 *  stringify the whole value. */
function stableSystemSignature(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const first = system.find(
      (b): b is { type?: string; text?: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: string }).text === "string",
    );
    if (first?.text) return first.text;
  }
  return JSON.stringify(system);
}

/** Extract the first user message's text from a request body's `messages`. For a
 *  sub-agent this is its task prompt — constant across the sub-agent's turns, so it
 *  yields a STABLE per-sub-agent id and a human-readable card label. */
function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const txt = msg.content
        .filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object")
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join(" ");
      return txt;
    }
    return ""; // first user message located but not text — its position is the anchor
  }
  return "";
}

/** Signature of `https.request`/`http.request` — the seam we inject in tests so
 *  the proxy can target a local fake upstream instead of api.anthropic.com. */
type UpstreamRequestFn = (
  options: https.RequestOptions,
  cb: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

/** Test/override hooks. All optional; defaults reproduce production behavior
 *  (https → api.anthropic.com:443 over the shared keep-alive pool). */
export interface SsePtyProxyOpts {
  requestFn?: UpstreamRequestFn;
  upstream?: { hostname: string; port: number };
  /** Agent for the FIRST attempt. Default: the shared keep-alive pool. */
  primaryAgent?: https.Agent | http.Agent | false;
}

/** Is this upstream error the "stale pooled socket" symptom — a connection that
 *  was reset/torn before we got any response? Those are safe to retry on a fresh
 *  socket (request body fully buffered, nothing streamed to the client yet). We
 *  deliberately do NOT retry idle-timeouts or post-response errors. */
function isRetriableUpstreamError(err: NodeJS.ErrnoException): boolean {
  return (
    err.code === "ECONNRESET" ||
    err.code === "EPIPE" ||
    /socket hang up/i.test(err.message)
  );
}

/**
 * Per-PTY forward proxy. The genuine `claude` CLI is pointed at this proxy via
 * ANTHROPIC_BASE_URL; every request is forwarded UNCHANGED to api.anthropic.com
 * (same method/path/headers/body, subscription OAuth token preserved → still
 * cc_entrypoint=cli, subsidy-safe — verified in Item A) and the response is
 * streamed back to the client byte-for-byte. The ONLY mutation is stripping the
 * client's `accept-encoding` so the SSE body comes back as plaintext we can
 * parse; the (now-uncompressed) response headers are forwarded as-is.
 *
 * When the upstream response is text/event-stream we tee a parsed copy of each
 * SSE `data:` event to `onEvent` — this is the live streaming source for the web
 * chat pane (word-by-word text, tool markers in true order, live context tokens).
 *
 * Sub-agent tagging: Claude Code runs Task sub-agents IN-PROCESS, so their nested
 * /v1/messages streams inherit ANTHROPIC_BASE_URL and flow through this same proxy.
 * We distinguish the main agent from sub-agents by the request's `system` prompt:
 * Claude Code keeps the top-level agent's system prompt byte-stable across the whole
 * session (required for prompt-cache hits), while each sub-agent carries its own
 * distinct system prompt. We fingerprint the first TOOL-BEARING request's system
 * as "main"; every other tool-bearing system is a sub-agent. Auxiliary requests
 * (no tools — e.g. haiku topic/title detection, quota checks) are ignored entirely
 * so they can neither poison the main fingerprint nor spawn a card. Sub-agent
 * events are still teed, but TAGGED with a stable per-sub-agent id (from its system
 * fp + task prompt) via `StreamCtx`, so the chat pane routes them into a collapsible
 * card instead of the main transcript. Fail-open: unparseable body / missing
 * system / no tools => main (untagged).
 */
export class SsePtyProxy {
  private server: http.Server;
  /** Resolved listening port (0 until start() completes). */
  port = 0;
  /** Fingerprint of the top-level (main) agent's system prompt, captured from the
   *  first classifiable request. Streams whose system prompt differs are sub-agents. */
  private mainSystemFp: string | null = null;
  /** Upstream requests currently streaming through this proxy. Non-zero means the
   *  claude behind this PTY is mid-API-call (main agent OR a sub-agent). */
  private inflightCount = 0;
  /** Epoch ms of the most recent upstream activity (request start, response
   *  bytes, or completion). 0 until the first request. */
  private lastUpstreamActivityAt = 0;

  private readonly requestFn: UpstreamRequestFn;
  private readonly upstreamHost: string;
  private readonly upstreamPort: number;
  private readonly primaryAgent: https.Agent | http.Agent | false;
  private readonly ownsPool: boolean;

  constructor(
    private readonly label: string,
    private readonly onEvent: (e: SseDataEvent, ctx: StreamCtx) => void,
    opts: SsePtyProxyOpts = {},
  ) {
    this.requestFn = opts.requestFn ?? https.request;
    this.upstreamHost = opts.upstream?.hostname ?? "api.anthropic.com";
    this.upstreamPort = opts.upstream?.port ?? 443;
    this.ownsPool = opts.primaryAgent === undefined;
    this.primaryAgent = opts.primaryAgent ?? new https.Agent({ keepAlive: true, maxSockets: 64 });
    this.server = http.createServer((req, res) => this.handle(req, res));
    // node http servers throw on unhandled 'clientError'; swallow so a flaky
    // client socket can never crash the daemon.
    this.server.on("clientError", (err, socket) => {
      logger.warn(`SsePtyProxy[${this.label}] clientError: ${err.message}`);
      try { socket.destroy(); } catch { /* already gone */ }
    });
  }

  /** Bind to an ephemeral 127.0.0.1 port; resolves with the chosen port. */
  start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      this.server.once("error", onErr);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onErr);
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(this.port);
      });
    });
  }

  /** Tear down the proxy. Safe to call multiple times. */
  stop(): void {
    try { this.server.close(); } catch { /* already closed */ }
    if (this.ownsPool && this.primaryAgent !== false) this.primaryAgent.destroy();
  }

  /** True while the claude behind this PTY is demonstrably working: an upstream
   *  request is in flight, or one finished within `recentMs`. Used by the PTY
   *  lifecycle so the keep-warm reaper never kills a PTY mid-background-work
   *  (tool executions between API calls produce short gaps — `recentMs` bridges
   *  them). */
  isBusy(recentMs: number): boolean {
    if (this.inflightCount > 0) return true;
    return this.lastUpstreamActivityAt > 0 && Date.now() - this.lastUpstreamActivityAt < recentMs;
  }

  /** Strictly in-flight (no recency window): an upstream request is streaming
   *  through this proxy right now. */
  hasInflight(): boolean {
    return this.inflightCount > 0;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    // Holder (not a plain `let`) so the req-close handler always destroys the
    // CURRENT in-flight upstream even after a retry swapped it out.
    const inflight: { current?: http.ClientRequest } = {};
    // True from req 'end' (in-flight count incremented) until res 'close'.
    let counted = false;
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
    // Client (the claude CLI) hung up mid-turn — abort the in-flight upstream so
    // we don't keep streaming to a dead socket (resource leak per interrupted
    // turn). We listen on `res` 'close', NOT `req` 'close': req 'close' fires as
    // soon as the request body is fully read — which is BEFORE we've even sent
    // the response — and would destroy a perfectly healthy upstream (and silently
    // kill the retry). `res` 'close' with `!writableFinished` is the real
    // "client went away before we finished" signal.
    res.on("close", () => {
      if (!res.writableFinished) { try { inflight.current?.destroy(); } catch { /* ignore */ } }
      // 'close' fires exactly once per response (finished or aborted) — the
      // symmetric end of the in-flight window opened at req 'end'.
      if (counted) {
        counted = false;
        this.inflightCount = Math.max(0, this.inflightCount - 1);
        this.lastUpstreamActivityAt = Date.now();
      }
    });
    req.on("end", () => {
      counted = true;
      this.inflightCount += 1;
      this.lastUpstreamActivityAt = Date.now();
      const body = Buffer.concat(chunks);
      // Classify once per request: main agent (untagged) vs Task sub-agent (tagged
      // with a stable id so the chat pane routes it into a card). Decided from the
      // body's system prompt; the events are teed either way.
      const ctx = this.classifyRequest(body);
      const headers: Record<string, unknown> = { ...req.headers, host: this.upstreamHost };
      // Plaintext SSE so we can parse it; we then forward the (uncompressed)
      // upstream response headers as-is, so the client sees consistent framing.
      delete headers["accept-encoding"];

      this.sendUpstream(req, res, body, ctx, headers, inflight, 0);
    });
  }

  /** Forward one buffered request upstream and stream the response back. On a
   *  "stale pooled socket" error before any response bytes, retry on a
   *  guaranteed-fresh socket (agent:false). A short backoff avoids landing every
   *  retry in the same transient reset burst. */
  private sendUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    ctx: StreamCtx,
    headers: Record<string, unknown>,
    inflight: { current?: http.ClientRequest },
    attempt: number,
  ): void {
    // First try over this PTY's pool; retries force brand-new sockets.
    const agent = attempt === 0 ? this.primaryAgent : false;
    const upstream = this.requestFn(
      {
        hostname: this.upstreamHost,
        port: this.upstreamPort,
        path: req.url,
        method: req.method,
        headers: headers as http.OutgoingHttpHeaders,
        agent,
      },
      (uRes) => {
        if (inflight.current !== upstream || res.destroyed) {
          uRes.resume();
          return;
        }
        res.writeHead(uRes.statusCode || 502, uRes.headers);
        const isSSE = String(uRes.headers["content-type"] || "").includes("text/event-stream");
        let sseBuf = "";
        uRes.on("data", (chunk: Buffer) => {
          this.lastUpstreamActivityAt = Date.now();
          // Forward UNCHANGED to the client first (never let parsing affect the stream).
          try { res.write(chunk); } catch { /* client gone */ }
          if (isSSE) sseBuf = this.parseSse(sseBuf + chunk.toString("utf-8"), ctx);
        });
        uRes.on("end", () => { try { res.end(); } catch { /* already ended */ } });
        uRes.on("error", () => { try { res.end(); } catch { /* ignore */ } });
      },
    );
    inflight.current = upstream;
    let terminal = false;
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      if (terminal || inflight.current !== upstream || res.destroyed) return;
      terminal = true;
      if (attempt + 1 < MAX_UPSTREAM_ATTEMPTS && !res.headersSent && isRetriableUpstreamError(err)) {
        logger.warn(`SsePtyProxy[${this.label}] upstream ${err.message} — retrying on fresh socket (attempt ${attempt + 2}/${MAX_UPSTREAM_ATTEMPTS})`);
        const timer = setTimeout(() => {
          if (inflight.current !== upstream || res.destroyed || res.headersSent) return;
          this.sendUpstream(req, res, body, ctx, headers, inflight, attempt + 1);
        }, retryBackoffMs(attempt));
        timer.unref?.();
        return;
      }
      logger.warn(`SsePtyProxy[${this.label}] upstream error: ${err.message}`);
      try { if (!res.headersSent) res.writeHead(502); res.end(); } catch { /* ignore */ }
    });
    upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
      logger.warn(`SsePtyProxy[${this.label}] upstream idle-timeout — destroying`);
      try { upstream.destroy(new Error("upstream idle timeout")); } catch { /* ignore */ }
    });
    if (body.length) upstream.write(body);
    upstream.end();
  }

  /** Classify a request as main agent vs Task sub-agent by comparing its system-
   *  prompt fingerprint to the first-seen (main) one. Sub-agents get a StreamCtx
   *  with a stable id (system fp + first user message) + a short label (the task).
   *  Fail-open: unparseable body / no system prompt => {} (treated as main). */
  private classifyRequest(body: Buffer): StreamCtx {
    let json: { system?: unknown; messages?: unknown; tools?: unknown } | null = null;
    try { json = JSON.parse(body.toString("utf-8")) as { system?: unknown; messages?: unknown; tools?: unknown }; }
    catch { return {}; }
    if (!json || json.system == null) return {};                 // can't classify → main
    // Only genuine AGENT turns (main agent + Task sub-agents) carry a tool set.
    // Claude Code also fires AUXILIARY requests through this same proxy — topic/
    // title detection on haiku, quota checks — which have no tools and a small,
    // varying system. Those must never set the main fingerprint (a poisoned
    // baseline tags every real turn as a "sub-agent" → a card per message/tool
    // call) nor be tagged themselves. Skip them entirely.
    if (!Array.isArray(json.tools) || json.tools.length === 0) return {};
    const fp = createHash("sha1").update(stableSystemSignature(json.system)).digest("hex");
    if (this.mainSystemFp == null) { this.mainSystemFp = fp; return {}; } // first = main
    if (fp === this.mainSystemFp) return {};                     // main agent
    // Sub-agent. Stable id from system fp + its task prompt: distinct tasks → distinct
    // ids (separates same-type parallel agents), constant across the sub-agent's turns.
    const task = firstUserText(json.messages);
    const id = createHash("sha1").update(`${fp} ${task}`).digest("hex").slice(0, 12);
    const label = task.slice(0, 80).trim() || undefined;
    return { subAgent: { id, label } };
  }

  /** Consume complete SSE frames (separated by a blank line) from `buf`,
   *  JSON.parse each event's `data:` payload, fire onEvent (with the request's
   *  StreamCtx), and return the trailing incomplete remainder for the next chunk. */
  private parseSse(buf: string, ctx: StreamCtx): string {
    let idx: number;
    // Frames are delimited by a blank line. Handle both \n\n and \r\n\r\n.
    while ((idx = indexOfFrameEnd(buf)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + frameDelimLen(buf, idx));
      let dataStr = "";
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataStr += line.slice(5).trimStart();
      }
      if (!dataStr || dataStr === "[DONE]") continue;
      let parsed: SseDataEvent;
      try { parsed = JSON.parse(dataStr) as SseDataEvent; } catch { continue; }
      try { this.onEvent(parsed, ctx); } catch (err) {
        logger.warn(`SsePtyProxy[${this.label}] onEvent threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return buf;
  }
}

/** Index of the first blank-line frame delimiter (\n\n or \r\n\r\n), or -1. */
function indexOfFrameEnd(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function frameDelimLen(buf: string, idx: number): number {
  return buf.startsWith("\r\n\r\n", idx) ? 4 : 2;
}

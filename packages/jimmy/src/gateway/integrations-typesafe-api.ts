import type { IncomingMessage, ServerResponse } from "node:http";
import type { JinnConfig } from "../shared/types.js";
import {
  deleteTypeSafeApiKey, getTypeSafeCredentialStatus, resolveTypeSafeApiKey,
  saveTypeSafeApiKey, TypeSafeCredentialError,
} from "../shared/typesafe-credentials.js";
import { shouldRequireGatewayAuth, verifyGatewayAuth } from "./auth.js";
import { requestOriginAllowed } from "./request-origin.js";
import { isJsonMediaType } from "./media-type.js";
import { BodyTooLargeError, readBody, readJsonBody } from "./http-helpers.js";
import { json, type ParsedRoute } from "./route-helpers.js";

const ROOT = "/api/integrations/typesafe";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_RESPONSE_BYTES = 8192;
const TEST_TIMEOUT_MS = 3000;
let testing = false;
type TestFailure = "missing_key" | "unauthorized" | "rate_limited" | "provider_error"
  | "network_error" | "timeout" | "invalid_response" | "busy";
class TestError extends Error {
  constructor(readonly code: TestFailure) { super(code); }
}
export interface TypeSafeTestResult { ok: boolean; latencyMs?: number; error?: TestFailure }
interface IntegrationContext {
  config: Pick<JinnConfig, "gateway">;
  authToken?: string;
  authHome?: string;
}

async function readTestResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (!response.body || (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new TestError("invalid_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new TestError("timeout");
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new TestError("invalid_response");
      chunks.push(value);
    }
    if (signal.aborted) throw new TestError("timeout");
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new TestError("invalid_response"); }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fixed-origin connection probe. No Slack data, API key, or provider output is returned. */
export async function testTypeSafeConnection(): Promise<TypeSafeTestResult> {
  const apiKey = resolveTypeSafeApiKey();
  if (!apiKey) return { ok: false, error: "missing_key" };
  if (testing) return { ok: false, error: "busy" };
  testing = true;
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = async () => {
      const response = await fetch(ENDPOINT, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "jev-1.13.0", state: { connection_test: "Noul" },
          questions: { connection: { type: "choice",
            instructions: "Read state.connection_test and select the matching value.",
            criteria: { noul: "The value is Noul.", other: "The value is something else." },
          } },
        }),
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new TestError("timeout");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new TestError(response.status === 401 || response.status === 403 ? "unauthorized"
          : response.status === 429 ? "rate_limited" : "provider_error");
      }
      const raw = await readTestResponse(response, controller.signal) as Record<string, any> | null;
      const answer = raw?.answers?.connection;
      if (!raw || typeof raw.model !== "string" || !answer || answer.type !== "choice" ||
          !["noul", "other"].includes(answer.choice) || !answer.probabilities ||
          !["noul", "other"].every((key) => typeof answer.probabilities[key] === "number" &&
            Number.isFinite(answer.probabilities[key]) && answer.probabilities[key] >= -1e-9 && answer.probabilities[key] <= 1 + 1e-9)) {
        throw new TestError("invalid_response");
      }
    };
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new TestError("timeout")); }, TEST_TIMEOUT_MS);
    });
    await Promise.race([request(), deadline]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error instanceof TestError ? error.code : controller.signal.aborted ? "timeout" : "network_error" };
  } finally {
    if (timer) clearTimeout(timer);
    testing = false;
  }
}

export async function handleTypeSafeIntegrationApi(
  req: IncomingMessage, res: ServerResponse, route: ParsedRoute, context: IntegrationContext,
): Promise<boolean> {
  if (route.pathname !== ROOT && route.pathname !== `${ROOT}/test`) return false;
  res.setHeader("Cache-Control", "no-store");
  // Keep the server's origin/auth policy at this secret boundary as well, so
  // direct router calls and future routing changes cannot bypass either guard.
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (!requestOriginAllowed(origin, req.headers.host, context.config.gateway.host ?? "127.0.0.1")) {
    json(res, { error: "origin_not_allowed" }, 403); return true;
  }
  if (shouldRequireGatewayAuth(context.config) && !(context.authToken && context.authHome &&
      verifyGatewayAuth(req.headers, context.authToken, context.authHome))) {
    json(res, { error: "unauthorized" }, 401); return true;
  }
  try {
    if (route.pathname === ROOT && route.method === "GET") {
      json(res, getTypeSafeCredentialStatus()); return true;
    }
    if (route.pathname === ROOT && route.method === "PUT") {
      if (!isJsonMediaType(req.headers["content-type"])) {
        json(res, { error: "unsupported_media_type" }, 415); return true;
      }
      const parsed = await readJsonBody(req, res, { maxBytes: 8192, rejectDuplicateTopLevelKeys: true,
        invalidJsonResponse: { error: "invalid_request" }, tooLargeResponse: { error: "invalid_request" } });
      if (!parsed.ok) return true;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body) ||
          Object.keys(parsed.body).length !== 1 || !("apiKey" in parsed.body)) {
        json(res, { error: "invalid_request" }, 400); return true;
      }
      json(res, saveTypeSafeApiKey((parsed.body as { apiKey: unknown }).apiKey)); return true;
    }
    if (route.pathname === ROOT && route.method === "DELETE") {
      json(res, deleteTypeSafeApiKey()); return true;
    }
    if (route.pathname === `${ROOT}/test` && route.method === "POST") {
      // The test never accepts user-provided prompts, URLs, or credentials.
      const raw = await readBody(req, { maxBytes: 1024 });
      if (raw.trim() && raw.trim() !== "{}") { json(res, { error: "invalid_request" }, 400); return true; }
      json(res, await testTypeSafeConnection()); return true;
    }
    json(res, { error: "method_not_allowed" }, 405); return true;
  } catch (error) {
    // Never pass key-bearing filesystem/provider/request exceptions to api.ts's
    // generic error handler, which returns the raw exception message.
    if (error instanceof BodyTooLargeError) {
      json(res, { error: "invalid_request" }, 413);
    } else if (error instanceof TypeSafeCredentialError) {
      json(res, { error: error.code }, error.code === "invalid_key" ? 400 : 500);
    } else {
      json(res, { error: "storage_unavailable" }, 500);
    }
    return true;
  }
}

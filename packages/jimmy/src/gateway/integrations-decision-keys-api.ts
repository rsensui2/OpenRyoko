/**
 * Dashboard management of decision-model provider keys (Jev triage):
 *   /api/integrations/decision-keys/:provider       GET status, PUT {apiKey}, DELETE
 *   /api/integrations/decision-keys/:provider/test  POST (empty body) fixed synthetic probe
 * Keys are never returned, logged, or sent anywhere except the provider's own fixed endpoint.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JinnConfig } from "../shared/types.js";
import {
  DecisionCredentialError, deleteDecisionApiKey, getDecisionCredentialStatus, isDecisionProvider,
  resolveDecisionApiKey, saveDecisionApiKey, type DecisionProvider,
} from "../shared/decision-credentials.js";
import { DECISION_PROVIDER_PROFILES, type SystemOneRequest } from "../connectors/slack/decision-providers.js";
import { shouldRequireGatewayAuth, verifyGatewayAuth } from "./auth.js";
import { requestOriginAllowed } from "./request-origin.js";
import { isJsonMediaType } from "./media-type.js";
import { BodyTooLargeError, readBody, readJsonBody } from "./http-helpers.js";
import { json, type ParsedRoute } from "./route-helpers.js";

export const DECISION_KEYS_ROOT = "/api/integrations/decision-keys";
const MAX_RESPONSE_BYTES = 8192;
const TEST_TIMEOUT_MS = 3000;
const testing = new Set<DecisionProvider>();

export type DecisionTestFailure = "missing_key" | "unauthorized" | "rate_limited" | "provider_error"
  | "network_error" | "timeout" | "invalid_response" | "busy";
class TestError extends Error {
  constructor(readonly code: DecisionTestFailure) { super(code); }
}
export interface DecisionTestResult { ok: boolean; latencyMs?: number; error?: DecisionTestFailure }
export interface IntegrationContext {
  config: Pick<JinnConfig, "gateway">;
  authToken?: string;
  authHome?: string;
}

/** Fixed synthetic one-question probe; never contains Slack data. */
const PROBE: Omit<SystemOneRequest, "model"> = {
  state: { connection_test: "Noul" },
  questions: { connection: { type: "choice",
    instructions: "Read state.connection_test and select the matching value.",
    criteria: { noul: "The value is Noul.", other: "The value is something else." },
  } },
};
const PROBE_CHOICES = ["noul", "other"];

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

function validProbeAnswer(converted: unknown, responseModel: RegExp): boolean {
  const raw = converted as Record<string, any> | null | undefined;
  const answer = raw?.answers?.connection;
  return Boolean(raw && typeof raw.model === "string" && responseModel.test(raw.model)
    && answer && answer.type === "choice" && PROBE_CHOICES.includes(answer.choice) && answer.probabilities
    && PROBE_CHOICES.every((key) => typeof answer.probabilities[key] === "number"
      && Number.isFinite(answer.probabilities[key]) && answer.probabilities[key] >= -1e-9 && answer.probabilities[key] <= 1 + 1e-9));
}

/** Fixed-origin connection probe. No Slack data, API key, or provider output is returned. */
export async function testDecisionProvider(provider: DecisionProvider): Promise<DecisionTestResult> {
  const profile = DECISION_PROVIDER_PROFILES[provider];
  const apiKey = resolveDecisionApiKey(profile.credential);
  if (!apiKey) return { ok: false, error: "missing_key" };
  if (testing.has(provider)) return { ok: false, error: "busy" };
  testing.add(provider);
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe: SystemOneRequest = { model: profile.defaultModel, ...PROBE };
    const request = async () => {
      const response = await fetch(profile.endpoint, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(profile.toWire(probe)),
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
      const raw = await readTestResponse(response, controller.signal);
      if (!validProbeAnswer(profile.fromWire(raw, probe), profile.responseModel)) throw new TestError("invalid_response");
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
    testing.delete(provider);
  }
}

/** Origin and gateway-auth guard for secret-bearing routes. Returns true when the request was rejected. */
function rejectedAtSecretBoundary(req: IncomingMessage, res: ServerResponse, context: IntegrationContext): boolean {
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
  return false;
}

async function serveProviderRoute(
  req: IncomingMessage, res: ServerResponse, method: string, provider: DecisionProvider, test: boolean,
): Promise<void> {
  try {
    if (!test && method === "GET") { json(res, getDecisionCredentialStatus(provider)); return; }
    if (!test && method === "PUT") {
      if (!isJsonMediaType(req.headers["content-type"])) { json(res, { error: "unsupported_media_type" }, 415); return; }
      const parsed = await readJsonBody(req, res, { maxBytes: 8192, rejectDuplicateTopLevelKeys: true,
        invalidJsonResponse: { error: "invalid_request" }, tooLargeResponse: { error: "invalid_request" } });
      if (!parsed.ok) return;
      if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body) ||
          Object.keys(parsed.body).length !== 1 || !("apiKey" in parsed.body)) {
        json(res, { error: "invalid_request" }, 400); return;
      }
      json(res, saveDecisionApiKey(provider, (parsed.body as { apiKey: unknown }).apiKey)); return;
    }
    if (!test && method === "DELETE") { json(res, deleteDecisionApiKey(provider)); return; }
    if (test && method === "POST") {
      // The test never accepts user-provided prompts, URLs, or credentials.
      const raw = await readBody(req, { maxBytes: 1024 });
      if (raw.trim() && raw.trim() !== "{}") { json(res, { error: "invalid_request" }, 400); return; }
      json(res, await testDecisionProvider(provider)); return;
    }
    json(res, { error: "method_not_allowed" }, 405);
  } catch (error) {
    // Never pass key-bearing filesystem/provider/request exceptions to api.ts's
    // generic error handler, which returns the raw exception message.
    if (error instanceof BodyTooLargeError) {
      json(res, { error: "invalid_request" }, 413);
    } else if (error instanceof DecisionCredentialError) {
      json(res, { error: error.code }, error.code === "invalid_key" ? 400 : 500);
    } else {
      json(res, { error: "storage_unavailable" }, 500);
    }
  }
}

/** Serves `${root}` (key) and `${root}/test` for one fixed provider. Returns false for other paths. */
export async function handleProviderCredentialApi(
  req: IncomingMessage, res: ServerResponse, route: ParsedRoute, context: IntegrationContext,
  provider: DecisionProvider, root: string,
): Promise<boolean> {
  if (route.pathname !== root && route.pathname !== `${root}/test`) return false;
  if (rejectedAtSecretBoundary(req, res, context)) return true;
  await serveProviderRoute(req, res, route.method, provider, route.pathname !== root);
  return true;
}

export async function handleDecisionKeysIntegrationApi(
  req: IncomingMessage, res: ServerResponse, route: ParsedRoute, context: IntegrationContext,
): Promise<boolean> {
  if (!route.pathname.startsWith(`${DECISION_KEYS_ROOT}/`)) return false;
  if (rejectedAtSecretBoundary(req, res, context)) return true;
  const [provider, action, ...extra] = route.pathname.slice(DECISION_KEYS_ROOT.length + 1).split("/");
  if (!isDecisionProvider(provider) || extra.length > 0 || (action !== undefined && action !== "test")) {
    json(res, { error: "not_found" }, 404); return true;
  }
  await serveProviderRoute(req, res, route.method, provider, action === "test");
  return true;
}

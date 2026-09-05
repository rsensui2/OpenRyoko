import { readGatewayAuthToken } from "../gateway/auth.js";
import { loadConfig } from "../shared/config.js";
import { gatewayUrlFromConfig } from "../shared/gateway-url.js";
import { JINN_HOME } from "../shared/paths.js";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface GatewayApiOptions {
  method: string;
  path: string;
  data?: string;
}

export interface GatewayApiResult {
  ok: boolean;
  status: number;
  body: string;
}

interface GatewayApiDeps {
  fetchImpl?: typeof fetch;
  gatewayUrl?: string;
  token?: string | null;
}

/**
 * Call this instance's own gateway without making callers hand-copy its bind
 * address or bearer token. Only local `/api` paths are accepted so the token
 * can never be redirected or sent to an arbitrary URL.
 */
export async function requestGatewayApi(
  opts: GatewayApiOptions,
  deps: GatewayApiDeps = {},
): Promise<GatewayApiResult> {
  const method = opts.method.trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Unsupported method "${opts.method}". Use GET, POST, PUT, PATCH, or DELETE.`);
  }

  const rawPath = opts.path.trim();
  if (!rawPath.startsWith("/api/") && rawPath !== "/api") {
    throw new Error("Gateway path must start with /api/ (full URLs are not accepted).");
  }

  const gatewayUrl = (deps.gatewayUrl ?? gatewayUrlFromConfig(loadConfig())).replace(/\/$/, "");
  const url = new URL(rawPath, `${gatewayUrl}/`);
  if (url.origin !== new URL(gatewayUrl).origin || (!url.pathname.startsWith("/api/") && url.pathname !== "/api")) {
    throw new Error("Gateway path must stay within this instance's /api/ namespace.");
  }

  let body: string | undefined;
  if (opts.data !== undefined) {
    if (method === "GET") throw new Error("GET requests cannot include --data.");
    try {
      body = JSON.stringify(JSON.parse(opts.data));
    } catch {
      throw new Error("--data must be valid JSON.");
    }
  }

  const token = deps.token === undefined ? readGatewayAuthToken(JINN_HOME) : deps.token;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await (deps.fetchImpl ?? fetch)(url, {
    method,
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

export async function runApi(opts: GatewayApiOptions): Promise<void> {
  try {
    const result = await requestGatewayApi(opts);
    if (result.body) process.stdout.write(`${result.body}${result.body.endsWith("\n") ? "" : "\n"}`);
    if (!result.ok) {
      console.error(`ryoko api: gateway returned HTTP ${result.status}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`ryoko api: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

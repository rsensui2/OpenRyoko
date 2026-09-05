import fs from "node:fs";
import { JINN_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { readGatewayAuthToken } from "../gateway/auth.js";
import { localGatewayUrl } from "../shared/gateway-url.js";

export interface PairingCodeResponse {
  code: string;
  expiresAt: string;
  ttlSeconds: number;
}

export async function requestPairingCode(options?: { fetchImpl?: typeof fetch }): Promise<PairingCodeResponse> {
  const token = readGatewayAuthToken(JINN_HOME);
  if (!token) throw new Error("Gateway auth token not found. Start OpenRyoko once, then retry.");
  const config = loadConfig();
  const response = await (options?.fetchImpl ?? fetch)(
    `${localGatewayUrl(config.gateway.host, config.gateway.port)}/api/auth/pairing-codes`,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" },
  );
  if (!response.ok) {
    let message = `Gateway rejected pairing-code creation (${response.status})`;
    try { message = String(((await response.json()) as { error?: unknown }).error || message); } catch { /* keep fallback */ }
    throw new Error(message);
  }
  return response.json() as Promise<PairingCodeResponse>;
}

export async function runPair(options: { json?: boolean } = {}): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) throw new Error(`OpenRyoko home does not exist: ${JINN_HOME}`);
  const pairing = await requestPairingCode();
  if (options.json) {
    console.log(JSON.stringify(pairing, null, 2));
    return;
  }
  console.log("Pair this browser with OpenRyoko");
  console.log(`\n  ${pairing.code}\n`);
  console.log("This code is single-use and expires in 5 minutes.");
  console.log("Open the remote dashboard and enter it on the pairing screen.");
}

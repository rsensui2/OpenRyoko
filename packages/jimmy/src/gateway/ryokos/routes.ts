/**
 * HTTP surface for peer Ryokos. Returns false for any path it does not own
 * so api.ts can keep routing. Gateway auth and origin checks apply as for
 * every /api/* route (server.ts).
 *
 *   GET    /api/ryokos         { ryokos: RyokoSummary[] } (the main Ryoko first)
 *   POST   /api/ryokos         create a peer → { ok, ryoko }
 *   PATCH  /api/ryokos/:name   change a peer → { ok, ryoko }
 *   DELETE /api/ryokos/:name   remove a peer and its Slack instance, keep its memory → { ok, keptMemory }
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../../shared/logger.js";
import { isPeerName, MAIN_RYOKO, peerSlackInstanceId } from "../../shared/peer-ryoko.js";
import type { JinnConfig } from "../../shared/types.js";
import { readJsonBody } from "../http-helpers.js";
import {
  createPeer, deletePeerYaml, listRyokos, peerSummary, updatePeer, validateRyokoInput, type RyokoFields,
} from "./ryoko-store.js";

export interface RyokoRouteDeps {
  getConfig: () => JinnConfig | undefined;
  /** config.yaml as it is on disk now (connector tokens decide `slack.connected`). */
  readConfigDocument: () => Record<string, unknown>;
  /** Remove a connector instance through the config write + reload path; false when absent. */
  removeConnectorInstance: (id: string) => Promise<boolean>;
  /** Drop what a finished or abandoned Slack setup kept for this peer. */
  forgetSlackSetup?: (name: string) => Promise<void>;
  emit?: (event: string, payload: unknown) => void;
}

const COLLECTION = "/api/ryokos";
const MAX_BODY = 32 * 1024;

function send(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function memberName(pathname: string): string | null {
  if (!pathname.startsWith(`${COLLECTION}/`)) return null;
  const rest = pathname.slice(COLLECTION.length + 1);
  if (!rest || rest.includes("/")) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return "";
  }
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; body: unknown } | { ok: false }> {
  return readJsonBody(req, res, { maxBytes: MAX_BODY });
}

function configDocument(deps: RyokoRouteDeps): Record<string, unknown> {
  try {
    return deps.readConfigDocument();
  } catch {
    return (deps.getConfig() ?? {}) as unknown as Record<string, unknown>;
  }
}

async function handleCreate(req: IncomingMessage, res: ServerResponse, deps: RyokoRouteDeps): Promise<void> {
  const read = await readBody(req, res);
  if (!read.ok) return;
  const checked = validateRyokoInput(read.body, "create");
  if (!checked.ok) return send(res, { error: checked.message }, 400);
  const peer = await createPeer(checked.value as RyokoFields);
  logger.info(`[ryokos] created peer Ryoko ${peer.name} (memory: ${peer.peer?.memory})`);
  deps.emit?.("ryokos:changed", { name: peer.name, action: "created" });
  send(res, { ok: true, ryoko: peerSummary(peer, configDocument(deps)) });
}

/** "main" is not a peer; anything that is not a peer name cannot be one. */
function memberProblem(name: string): { status: number; error: string } | null {
  if (name === MAIN_RYOKO) return { status: 400, error: "the main Ryoko is changed in Settings, not here" };
  if (!isPeerName(name)) return { status: 400, error: "invalid Ryoko name" };
  return null;
}

async function handleUpdate(req: IncomingMessage, res: ServerResponse, name: string, deps: RyokoRouteDeps): Promise<void> {
  const problem = memberProblem(name);
  if (problem) return send(res, { error: problem.error }, problem.status);
  const read = await readBody(req, res);
  if (!read.ok) return;
  const checked = validateRyokoInput(read.body, "update");
  if (!checked.ok) return send(res, { error: checked.message }, 400);
  const peer = await updatePeer(name, checked.value);
  if (!peer) return send(res, { error: `no Ryoko named ${name}` }, 404);
  deps.emit?.("ryokos:changed", { name, action: "updated" });
  send(res, { ok: true, ryoko: peerSummary(peer, configDocument(deps)) });
}

async function handleDelete(res: ServerResponse, name: string, deps: RyokoRouteDeps): Promise<void> {
  const problem = memberProblem(name);
  if (problem) return send(res, { error: problem.error }, problem.status);
  // The definition goes first, then the connector. A Slack /finish or
  // /connect racing this re-checks the peer inside the config lock, so once
  // the YAML is gone it cannot write the instance back; one that already
  // wrote it is removed just below. Meanwhile the gateway drops messages for
  // an instance whose Ryoko no longer exists instead of answering as main.
  const removed = await deletePeerYaml(name);
  if (!removed) return send(res, { error: `no Ryoko named ${name}` }, 404);
  await deps.removeConnectorInstance(peerSlackInstanceId(name));
  await deps.forgetSlackSetup?.(name).catch((err: unknown) => {
    logger.warn(`[ryokos] could not clear Slack setup secrets for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  });
  logger.info(`[ryokos] deleted peer Ryoko ${name} (memory kept: ${removed.keptMemory})`);
  deps.emit?.("ryokos:changed", { name, action: "deleted" });
  send(res, { ok: true, keptMemory: removed.keptMemory });
}

export async function handleRyokosApi(
  req: IncomingMessage, res: ServerResponse, route: { method: string; pathname: string }, deps: RyokoRouteDeps,
): Promise<boolean> {
  const { method, pathname } = route;
  try {
    if (pathname === COLLECTION) {
      if (method === "GET") {
        send(res, { ryokos: listRyokos(deps.getConfig(), configDocument(deps)) });
        return true;
      }
      if (method === "POST") {
        await handleCreate(req, res, deps);
        return true;
      }
      return false;
    }
    const name = memberName(pathname);
    if (name === null) return false;
    if (method === "PATCH") {
      await handleUpdate(req, res, name, deps);
      return true;
    }
    if (method === "DELETE") {
      await handleDelete(res, name, deps);
      return true;
    }
    return false;
  } catch (err) {
    logger.error(`[ryokos] ${method} ${pathname} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    if (!res.headersSent) send(res, { error: "internal_error" }, 500);
    return true;
  }
}

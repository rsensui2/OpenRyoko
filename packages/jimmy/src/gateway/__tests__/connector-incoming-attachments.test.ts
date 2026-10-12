import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JINN_HOME, TMP_DIR } from "../../shared/paths.js";
import type { Connector, IncomingMessage } from "../../shared/types.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* POST /api/connectors/:id/incoming takes a routed Discord message from a
 * primary instance, attachments included: it fetches each attachment's URL and
 * saves it under the name the request gives. Both are caller-controlled, so a
 * request past the auth gate could make the gateway fetch any URL it can reach
 * (SSRF) and write the answer outside the temp directory (path traversal). */

const CDN = "https://cdn.discordapp.com/attachments/1/2/photo.png?ex=1&is=2&hm=3";
const outbound = vi.fn<typeof fetch>();
const delivered: IncomingMessage[] = [];

function remoteConnector(): Connector {
  // What makes a Discord connector "remote mode" for this route: deliverMessage.
  return { name: "discord", deliverMessage: (msg: IncomingMessage) => { delivered.push(msg); } } as unknown as Connector;
}

async function postIncoming(body: unknown) {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as unknown as HttpRequest;
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  req.method = "POST";
  req.url = "/api/connectors/discord/incoming";
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  const context = {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude" } }),
    connectors: new Map([["discord", remoteConnector()]]), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(req, res, context);
  return { status, body: chunks.length ? JSON.parse(chunks.join("")) : null };
}

const message = (attachments: unknown) => ({
  sessionKey: "discord:C1", channel: "C1", user: "user", userId: "U1", text: "see attached", messageId: "M1", attachments,
});

let created: string[];
const filesIn = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  created = [];
  delivered.length = 0;
  outbound.mockReset().mockImplementation(async () => new Response("file-bytes"));
  vi.stubGlobal("fetch", outbound);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const file of created) fs.rmSync(file, { force: true });
});

describe("POST /api/connectors/:id/incoming attachments", () => {
  it("does not write outside the temp directory for a name with ../ in it", async () => {
    const name = `escaped-${randomUUID()}.txt`;
    const outside = path.join(JINN_HOME, name); // TMP_DIR/../<name>
    created.push(outside, path.join(TMP_DIR, name));

    const answer = await postIncoming(message([{ name: `../${name}`, url: CDN, mimeType: "text/plain" }]));

    expect(fs.existsSync(outside)).toBe(false);
    expect(answer).toEqual({ status: 200, body: { status: "delivered" } });
    const [attachment] = delivered[0].attachments;
    if (attachment.localPath) expect(path.dirname(attachment.localPath)).toBe(TMP_DIR);
  });

  it.each([
    ["http://127.0.0.1:7777/api/config"],
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["https://intranet.example/payroll.xlsx"],
    ["http://cdn.discordapp.com/attachments/1/2/photo.png"],
  ])("does not fetch %s on the caller's say-so", async (url) => {
    const before = filesIn(TMP_DIR);

    const answer = await postIncoming(message([{ name: "photo.png", url, mimeType: "image/png" }]));

    expect(outbound).not.toHaveBeenCalled();
    expect(filesIn(TMP_DIR)).toEqual(before);
    // The message itself still arrives, with the attachment as metadata only —
    // what a failed download has always looked like.
    expect(answer).toEqual({ status: 200, body: { status: "delivered" } });
    expect(delivered[0].attachments).toEqual([{ name: "photo.png", url, mimeType: "image/png" }]);
  });

  it("still downloads what a primary instance really forwards: a Discord CDN URL", async () => {
    const name = `photo-${randomUUID()}.png`;
    created.push(path.join(TMP_DIR, name));

    await postIncoming(message([{ name, url: CDN, mimeType: "image/png" }]));

    expect(outbound).toHaveBeenCalledTimes(1);
    expect(String(outbound.mock.calls[0][0])).toBe(CDN);
    expect(delivered[0].attachments).toEqual([{ name, url: CDN, mimeType: "image/png", localPath: path.join(TMP_DIR, name) }]);
    expect(fs.readFileSync(path.join(TMP_DIR, name), "utf-8")).toBe("file-bytes");
  });

  it("accepts the media proxy host as well", async () => {
    const name = `photo-${randomUUID()}.png`;
    created.push(path.join(TMP_DIR, name));
    await postIncoming(message([{ name, url: "https://media.discordapp.net/attachments/1/2/photo.png", mimeType: "image/png" }]));
    expect(delivered[0].attachments[0].localPath).toBe(path.join(TMP_DIR, name));
  });

  it("does not keep a file larger than the limit", async () => {
    const name = `huge-${randomUUID()}.bin`;
    created.push(path.join(TMP_DIR, name));
    const cancel = vi.fn(async () => {});
    outbound.mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ "content-length": String(1024 * 1024 * 1024) }), body: { cancel },
    } as unknown as Response);

    await postIncoming(message([{ name, url: CDN, mimeType: "application/octet-stream" }]));

    expect(fs.existsSync(path.join(TMP_DIR, name))).toBe(false);
    expect(delivered[0].attachments).toEqual([{ name, url: CDN, mimeType: "application/octet-stream" }]);
  });

  it("delivers a message whose attachments field is missing or not a list", async () => {
    expect((await postIncoming(message(undefined))).status).toBe(200);
    expect((await postIncoming(message("not-a-list"))).status).toBe(200);
    expect(delivered.map((msg) => msg.attachments)).toEqual([[], []]);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("passes through an attachment that carries no URL, as before", async () => {
    await postIncoming(message([{ name: "note.txt", mimeType: "text/plain" }]));
    expect(outbound).not.toHaveBeenCalled();
    expect(delivered[0].attachments).toEqual([{ name: "note.txt", mimeType: "text/plain" }]);
  });
});

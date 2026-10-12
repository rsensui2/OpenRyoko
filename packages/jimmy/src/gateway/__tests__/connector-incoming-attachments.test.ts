import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENTS_DIR } from "../../shared/attachments.js";
import { JINN_HOME, TMP_DIR } from "../../shared/paths.js";
import { RemoteDiscordConnector } from "../../connectors/discord/remote.js";
import type { Connector, DiscordRespondToConfig, IncomingMessage } from "../../shared/types.js";
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

/** The connector the route finds under "discord"; the stand-in above unless a test puts the real one there. */
let connector: Connector;

async function postIncoming(body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as unknown as HttpRequest;
  req.headers = { host: "127.0.0.1", "content-type": "application/json", ...headers };
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
    connectors: new Map([["discord", connector]]), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(req, res, context);
  return { status, body: chunks.length ? JSON.parse(chunks.join("")) : null };
}

const message = (attachments: unknown) => ({
  sessionKey: "discord:C1", channel: "C1", user: "user", userId: "U1", text: "see attached", messageId: "M1", attachments,
});

let created: string[];
const filesIn = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
/** Every file saved for attachments, wherever under tmp/attachments/ it is. */
const savedAttachments = () => (fs.existsSync(ATTACHMENTS_DIR)
  ? fs.readdirSync(ATTACHMENTS_DIR, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name))
  : []);
const insideAttachments = (file: string) => file.startsWith(ATTACHMENTS_DIR + path.sep);

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  created = [];
  delivered.length = 0;
  connector = remoteConnector();
  outbound.mockReset().mockImplementation(async () => new Response("file-bytes"));
  vi.stubGlobal("fetch", outbound);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const file of created) fs.rmSync(file, { force: true });
  fs.rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
});

describe("POST /api/connectors/:id/incoming attachments", () => {
  it("does not write outside the temp directory for a name with ../ in it", async () => {
    const name = `escaped-${randomUUID()}.txt`;
    const outside = path.join(JINN_HOME, name);
    created.push(outside, path.join(TMP_DIR, name));

    const answer = await postIncoming(message([{ name: `../../../../${name}`, url: CDN, mimeType: "text/plain" }]));

    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(TMP_DIR, name))).toBe(false);
    expect(answer).toEqual({ status: 200, body: { status: "delivered" } });
    const [attachment] = delivered[0].attachments;
    if (attachment.localPath) expect(insideAttachments(attachment.localPath)).toBe(true);
    expect(savedAttachments().every(insideAttachments)).toBe(true);
  });

  it("does not let an attachment named like a state file replace that file", async () => {
    // tmp/ holds the gateway's own state next to what used to be saved there.
    const stateFile = path.join(TMP_DIR, "engine-health.json");
    created.push(stateFile);
    fs.writeFileSync(stateFile, '{"engines":{}}');

    await postIncoming(message([{ name: "engine-health.json", url: CDN, mimeType: "application/json" }]));

    expect(fs.readFileSync(stateFile, "utf-8")).toBe('{"engines":{}}');
    const saved = delivered[0].attachments[0].localPath!;
    expect(insideAttachments(saved)).toBe(true);
    expect(path.basename(saved)).toBe("engine-health.json");
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

    await postIncoming(message([{ name, url: CDN, mimeType: "image/png" }]));

    expect(outbound).toHaveBeenCalledTimes(1);
    expect(String(outbound.mock.calls[0][0])).toBe(CDN);
    const saved = delivered[0].attachments[0].localPath!;
    expect(delivered[0].attachments).toEqual([{ name, url: CDN, mimeType: "image/png", localPath: saved }]);
    expect(insideAttachments(saved)).toBe(true);
    expect(path.basename(saved)).toBe(name);
    expect(fs.readFileSync(saved, "utf-8")).toBe("file-bytes");
  });

  it("accepts the media proxy host as well", async () => {
    const name = `photo-${randomUUID()}.png`;
    await postIncoming(message([{ name, url: "https://media.discordapp.net/attachments/1/2/photo.png", mimeType: "image/png" }]));
    expect(path.basename(delivered[0].attachments[0].localPath!)).toBe(name);
  });

  it("keeps the attachments of one routed message together, and two with the same name apart", async () => {
    outbound.mockImplementation(async (url) => new Response(`contents of ${String(url)}`));
    await postIncoming(message([
      { name: "image.png", url: "https://cdn.discordapp.com/a/1/first.png", mimeType: "image/png" },
      { name: "image.png", url: "https://cdn.discordapp.com/a/2/second.png", mimeType: "image/png" },
    ]));
    const [first, second] = delivered[0].attachments.map((attachment) => attachment.localPath!);
    expect(first).not.toBe(second);
    expect(fs.readFileSync(first, "utf-8")).toContain("first.png");
    expect(fs.readFileSync(second, "utf-8")).toContain("second.png");
    const messageDir = (file: string) => path.relative(ATTACHMENTS_DIR, file).split(path.sep)[0];
    expect(messageDir(first)).toBe(messageDir(second));
  });

  it("does not keep a file larger than the limit", async () => {
    const name = `huge-${randomUUID()}.bin`;
    const cancel = vi.fn(async () => {});
    outbound.mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ "content-length": String(1024 * 1024 * 1024) }), body: { cancel },
    } as unknown as Response);

    await postIncoming(message([{ name, url: CDN, mimeType: "application/octet-stream" }]));

    expect(savedAttachments()).toEqual([]);
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

  it("never takes a local file path from the request", async () => {
    // The session hands every attachment's localPath to the engine as a file
    // to read, and deletes it when the turn ends. A routed message that could
    // name one would read, and then remove, any file the gateway can reach.
    const victim = path.join(JINN_HOME, `private-${randomUUID()}.txt`);
    created.push(victim);
    fs.writeFileSync(victim, "not for the model");

    await postIncoming(message([
      { name: "note.txt", mimeType: "text/plain", localPath: victim },
      { name: "photo.png", url: "http://127.0.0.1:7777/x", mimeType: "image/png", localPath: victim },
    ]));

    expect(delivered[0].attachments).toEqual([
      { name: "note.txt", mimeType: "text/plain" },
      { name: "photo.png", url: "http://127.0.0.1:7777/x", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(delivered[0].attachments)).not.toContain(victim);
  });

  it("keeps only the fields a primary sends, and only as text", async () => {
    await postIncoming(message([{ name: { toString: "x" }, mimeType: 42, url: ["http://a"], extra: "field", size: 10 }, "not-an-object", null]));
    expect(outbound).not.toHaveBeenCalled();
    expect(delivered[0].attachments).toEqual([{}]);
  });
});

describe("POST /api/connectors/:id/incoming and messages the connector stays silent on", () => {
  /* The route used to fetch and save a routed message's attachments first and
   * hand the message to the connector afterwards — which then dropped it when
   * its respondTo setting said so, files and all. Every message in a channel
   * the primary routes here left its attachments on this instance's disk,
   * answered or not. */
  function realConnector(respondTo: DiscordRespondToConfig) {
    const remote = new RemoteDiscordConnector({ proxyVia: "http://primary.invalid:7777", respondTo });
    remote.onMessage((msg) => { delivered.push(msg); });
    return remote as unknown as Connector;
  }
  const routed = (transportMeta: Record<string, unknown>) => ({
    ...message([{ name: "photo.png", url: CDN, mimeType: "image/png" }]),
    transportMeta,
  });

  it("does not fetch the attachments of a message it will not answer", async () => {
    connector = realConnector({ channel: "mention" });

    const answer = await postIncoming(routed({ isDM: false, wasBotAddressed: false, isEngagedThread: false }));

    expect(answer.status).toBe(200);
    expect(delivered).toEqual([]);
    expect(outbound).not.toHaveBeenCalled();
    expect(fs.existsSync(ATTACHMENTS_DIR) ? fs.readdirSync(ATTACHMENTS_DIR) : []).toEqual([]);
  });

  it("does not fetch them for a message addressed to somebody else either", async () => {
    connector = realConnector({ channel: "always" });

    await postIncoming(routed({ isDM: false, wasBotAddressed: false, isEngagedThread: false, addressesOnlyOthers: true }));

    expect(delivered).toEqual([]);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("fetches them for a message it answers, and hands them over with it", async () => {
    connector = realConnector({ channel: "mention" });

    await postIncoming(routed({ isDM: false, wasBotAddressed: true, isEngagedThread: false }));

    expect(outbound).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
    expect(fs.readFileSync(delivered[0].attachments[0].localPath!, "utf-8")).toBe("file-bytes");
  });

  it("still fetches for a connector that cannot say beforehand (an older build)", async () => {
    await postIncoming(routed({ isDM: false }));
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
  });
});

describe("POST /api/connectors/:id/incoming limits", () => {
  /* What a Discord message can carry is bounded by Discord: ten attachments,
   * a few thousand characters. A request to this route is bounded by nothing
   * but these checks — a body of any size was read into memory, and a list of
   * any length was fetched, every entry at the same time. */
  const attachmentsNumbered = (count: number) =>
    Array.from({ length: count }, (_, n) => ({ name: `file-${n}.png`, url: `https://cdn.discordapp.com/attachments/1/${n}/file.png`, mimeType: "image/png" }));

  it("fetches at most ten attachments of a message — Discord's own limit — and drops the rest", async () => {
    await postIncoming(message(attachmentsNumbered(25)));

    expect(outbound).toHaveBeenCalledTimes(10);
    expect(delivered[0].attachments.map((attachment) => attachment.name)).toEqual(attachmentsNumbered(10).map((attachment) => attachment.name));
    expect(savedAttachments()).toHaveLength(10);
  });

  it("does not let entries that are not attachments use up the ten", async () => {
    await postIncoming(message([null, "text", 42, ...attachmentsNumbered(10)]));
    expect(delivered[0].attachments).toHaveLength(10);
    expect(outbound).toHaveBeenCalledTimes(10);
  });

  it("fetches them a few at a time, not all at once, and keeps them in the order they were sent", async () => {
    let inFlight = 0;
    let most = 0;
    outbound.mockImplementation(async (url) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(`contents of ${String(url)}`);
    });

    await postIncoming(message(attachmentsNumbered(10)));

    expect(most).toBeLessThanOrEqual(3);
    expect(most).toBeGreaterThan(1); // still in parallel, just not ten wide
    delivered[0].attachments.forEach((attachment, n) => {
      expect(attachment.name).toBe(`file-${n}.png`);
      expect(fs.readFileSync(attachment.localPath!, "utf-8")).toBe(`contents of https://cdn.discordapp.com/attachments/1/${n}/file.png`);
    });
  });

  it("refuses a body larger than a forwarded message can be, and fetches nothing for it", async () => {
    const answer = await postIncoming({ ...message(attachmentsNumbered(1)), text: "x".repeat(300 * 1024) });
    expect(answer.status).toBe(413);
    expect(delivered).toEqual([]);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("refuses it by its announced size, before reading it", async () => {
    const answer = await postIncoming(message([]), { "content-length": String(10 * 1024 * 1024) });
    expect(answer.status).toBe(413);
    expect(delivered).toEqual([]);
  });

  it("accepts the largest message Discord sends: 4,000 characters and ten attachments with long signed URLs", async () => {
    const signed = attachmentsNumbered(10).map((attachment) => ({ ...attachment, name: "n".repeat(255), url: `${attachment.url}?ex=${"a".repeat(400)}` }));
    const answer = await postIncoming({ ...message(signed), text: "漢".repeat(4000) });
    expect(answer.status).toBe(200);
    expect(delivered[0].text).toHaveLength(4000);
    expect(delivered[0].attachments).toHaveLength(10);
  });
});

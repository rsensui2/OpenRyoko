import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSlackFiles } from "../attachments.js";
import { downloadAttachment } from "../format.js";

/* The Slack connector fetches the files people post where the bot reads. How
 * large such a file is, is the poster's choice: the download has to stop at a
 * limit while it reads, and a download that stops must leave nothing behind. */

const FILE_URL = "https://files.slack.com/files-pri/T0001-F0001/download/report.pdf";
const TOKEN = "xoxb-TEST-TOKEN";

let root: string;
let dest: string;
const outbound = vi.fn<typeof fetch>();

const everythingUnder = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-slack-attachment-"));
  dest = path.join(root, "message");
  outbound.mockReset().mockImplementation(async () => new Response("file-bytes"));
  vi.stubGlobal("fetch", outbound);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Slack downloadAttachment", () => {
  it("saves the file in the directory it is given, under a name of its own with the URL's extension", async () => {
    const saved = await downloadAttachment(FILE_URL, TOKEN, dest);
    expect(path.dirname(saved)).toBe(dest);
    expect(path.basename(saved)).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(fs.readFileSync(saved, "utf-8")).toBe("file-bytes");
  });

  it("creates nothing for a download that fails", async () => {
    outbound.mockResolvedValue(new Response("nope", { status: 403, statusText: "Forbidden" }));
    await expect(downloadAttachment(FILE_URL, TOKEN, dest)).rejects.toThrow("403");
    expect(everythingUnder(root)).toEqual([]);
  });

  it("refuses a file announced as larger than 200 MB, the limit when none is given, without reading it", async () => {
    const body = { cancel: vi.fn(async () => {}) };
    outbound.mockResolvedValue({
      ok: true, status: 200, statusText: "OK", headers: new Headers({ "content-length": String(200 * 1024 * 1024 + 1) }), body,
    } as unknown as Response);

    await expect(downloadAttachment(FILE_URL, TOKEN, dest)).rejects.toThrow(/too large/i);

    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(everythingUnder(root)).toEqual([]);
  });

  it("cuts off a file that runs past the limit while reading it, and leaves nothing behind", async () => {
    outbound.mockResolvedValue(new Response("x".repeat(4096)));
    await expect(downloadAttachment(FILE_URL, TOKEN, dest, 1024)).rejects.toThrow(/too large/i);
    expect(everythingUnder(root)).toEqual([]);
  });

  it("accepts a file of exactly the limit", async () => {
    outbound.mockResolvedValue(new Response("x".repeat(1024)));
    const saved = await downloadAttachment(FILE_URL, TOKEN, dest, 1024);
    expect(fs.statSync(saved).size).toBe(1024);
  });
});

describe("fetchSlackFiles", () => {
  /* What the connector calls for a message's files. A file that is not
   * fetched is reported, by Slack's ID for it — and with the reason, when the
   * reason is its size — so the session can tell the person who sent it. */
  const file = (id: string) => ({ id, name: `${id}.bin`, mimetype: "application/octet-stream", url_private_download: `https://files.slack.com/files-pri/T0001-${id}/download/${id}.bin` });
  const announcing = (bytes: number) => ({
    ok: true, status: 200, statusText: "OK", headers: new Headers({ "content-length": String(bytes) }), body: { cancel: vi.fn(async () => {}) },
  }) as unknown as Response;
  const client = (maxBytes?: number) => ({ token: TOKEN, filesInfo: vi.fn(), ...(maxBytes === undefined ? {} : { maxBytes }) });
  const MB = 1024 * 1024;

  it("fetches each file into the message's directory", async () => {
    const fetched = await fetchSlackFiles([file("F1"), file("F2")], client(), dest);
    expect(fetched.failed).toEqual([]);
    expect(fetched.attachments.map((attachment) => attachment.name)).toEqual(["F1.bin", "F2.bin"]);
    expect(fetched.attachments.every((attachment) => path.dirname(attachment.localPath!) === dest)).toBe(true);
  });

  it("reports a file over the connector's limit with that limit, and still fetches the others", async () => {
    outbound.mockResolvedValueOnce(announcing(6 * MB));

    const fetched = await fetchSlackFiles([file("F1"), file("F2")], client(5 * MB), dest);

    expect(fetched.failed).toEqual(["Slack file F1 (larger than the 5 MB attachment limit)"]);
    expect(fetched.attachments.map((attachment) => attachment.name)).toEqual(["F2.bin"]);
  });

  it("keeps a 120 MB recording when no limit is configured: the default is 200 MB", async () => {
    outbound.mockResolvedValueOnce(announcing(201 * MB)).mockResolvedValueOnce(new Response("a-recording", { headers: { "content-length": String(120 * MB) } }));
    // (The second answer only announces 120 MB; what it sends is short, and that is what counts.)
    const fetched = await fetchSlackFiles([file("F1"), file("F2")], client(), dest);
    expect(fetched.failed).toEqual(["Slack file F1 (larger than the 200 MB attachment limit)"]);
    expect(fetched.attachments.map((attachment) => attachment.name)).toEqual(["F2.bin"]);
  });

  it("reports any other failure by the file's ID alone", async () => {
    outbound.mockResolvedValueOnce(new Response("nope", { status: 403, statusText: "Forbidden" }));
    const fetched = await fetchSlackFiles([file("F1")], client(), dest);
    expect(fetched.failed).toEqual(["Slack file F1"]);
  });
});

/* Slack serves the files uploaded to it from files.slack.com, and those URLs
 * need the bot token. But a file in a message need not be one of those: a
 * "remote file" (files.remote.add; Google Drive, Dropbox and the like) has a
 * url_private that is whatever external URL was registered for it. The token
 * was sent along to any of them — to any host a workspace app or member could
 * name. It now goes to Slack's file host only, and nothing else is fetched. */
describe("Slack downloadAttachment and the bot token", () => {
  const sentTo = () => outbound.mock.calls.map(([target]) => String(target));
  const authorization = (call: number) => new Headers(outbound.mock.calls[call][1]?.headers).get("authorization");

  it("sends the token to Slack's file host", async () => {
    await downloadAttachment(FILE_URL, TOKEN, dest);
    expect(sentTo()).toEqual([FILE_URL]);
    expect(authorization(0)).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ["a remote file kept on Google Drive", "https://docs.google.com/document/d/1e8LtkvCSe/edit?tab=t.0"],
    ["any other host", "https://attacker.example/files-pri/T0001-F0001/download/report.pdf"],
    ["a host that only starts like Slack's", "https://files.slack.com.attacker.example/report.pdf"],
    ["a host that only ends like Slack's", "https://attacker-files.slack.com.example/report.pdf"],
    ["another Slack host", "https://acme.slack.com/files/U1/F1/report.pdf"],
    ["Slack's public-link host, which takes no token", "https://slack-files.com/T0001-F0001-abcdef"],
    ["Slack's file host named in the user part of the URL", "https://files.slack.com@attacker.example/report.pdf"],
    ["Slack's file host over plain http", "http://files.slack.com/files-pri/T0001-F0001/report.pdf"],
    ["Slack's file host on another port", "https://files.slack.com:8443/files-pri/T0001-F0001/report.pdf"],
    ["an address on the local network", "https://169.254.169.254/latest/meta-data/"],
    ["a local file", "file:///etc/passwd"],
    ["something that is not a URL", "files.slack.com/report.pdf"],
  ])("neither sends the token to nor fetches %s", async (_what, url) => {
    const failure = await downloadAttachment(url, TOKEN, dest).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(outbound).not.toHaveBeenCalled();
    expect(everythingUnder(root)).toEqual([]);
    // What is logged about it names neither the URL (it may carry a secret of its own) nor the token.
    expect((failure as Error).message).not.toContain("attacker");
    expect((failure as Error).message).not.toContain("docs.google.com");
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it("does not follow a redirect that leaves Slack's file host, with or without the token", async () => {
    outbound.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }));

    await expect(downloadAttachment(FILE_URL, TOKEN, dest)).rejects.toThrow(/redirect/i);

    expect(sentTo()).toEqual([FILE_URL]); // one request, to Slack; none to where it pointed
    expect(everythingUnder(root)).toEqual([]);
  });

  it("does not save the sign-in page Slack redirects to when the token may not read files", async () => {
    outbound.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://acme.slack.com/?redir=%2Ffiles-pri%2FT0001-F0001%2Freport.pdf" } }));
    await expect(downloadAttachment(FILE_URL, TOKEN, dest)).rejects.toThrow(/files:read/);
    expect(sentTo()).toEqual([FILE_URL]);
    expect(everythingUnder(root)).toEqual([]);
  });

  it("follows a redirect that stays on Slack's file host", async () => {
    const moved = "https://files.slack.com/files-pri/T0001-F0001/report-v2.pdf";
    outbound
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/files-pri/T0001-F0001/report-v2.pdf" } }))
      .mockResolvedValueOnce(new Response("moved-bytes"));

    const saved = await downloadAttachment(FILE_URL, TOKEN, dest);

    expect(sentTo()).toEqual([FILE_URL, moved]);
    expect(fs.readFileSync(saved, "utf-8")).toBe("moved-bytes");
  });

  it("gives up on a chain of redirects", async () => {
    outbound.mockImplementation(async () => new Response(null, { status: 302, headers: { location: FILE_URL } }));
    await expect(downloadAttachment(FILE_URL, TOKEN, dest)).rejects.toThrow(/redirect/i);
    expect(outbound.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("never lets fetch follow a redirect on its own", async () => {
    await downloadAttachment(FILE_URL, TOKEN, dest);
    expect(outbound.mock.calls[0][1]?.redirect).toBe("manual");
  });
});

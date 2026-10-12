import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAttachment } from "../format.js";

/* An attachment's name and URL arrive from outside: from Discord for the
 * connector's own messages, and from the request body for messages routed in
 * through /api/connectors/:id/incoming. The properties under test: the file is
 * only ever written inside the download directory, and a caller that names
 * the hosts it trusts never fetches anything else. */

const CDN = "https://cdn.discordapp.com/attachments/1/2/photo.png?ex=1&is=2&hm=3";

let root: string;
let dest: string;
const outbound = vi.fn<typeof fetch>();

function everyFileUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-discord-attachment-"));
  dest = path.join(root, "home", "tmp");
  fs.mkdirSync(dest, { recursive: true });
  outbound.mockReset().mockImplementation(async () => new Response("file-bytes"));
  vi.stubGlobal("fetch", outbound);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("downloadAttachment file names", () => {
  it("saves an ordinary attachment under its own name in the download directory", async () => {
    const saved = await downloadAttachment(CDN, dest, "photo.png");
    expect(saved).toBe(path.join(dest, "photo.png"));
    expect(fs.readFileSync(saved, "utf-8")).toBe("file-bytes");
  });

  it("creates the download directory once there is something to save, and not for a download that fails", async () => {
    const slot = path.join(dest, "message", "0");
    outbound.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(downloadAttachment(CDN, slot, "photo.png")).rejects.toThrow(/404/);
    expect(fs.existsSync(path.join(dest, "message"))).toBe(false);

    expect(await downloadAttachment(CDN, slot, "photo.png")).toBe(path.join(slot, "photo.png"));
  });

  it.each([
    ["../escaped.txt"],
    ["../../escaped.txt"],
    ["nested/../../escaped.txt"],
    ["..\\..\\escaped.txt"],
  ])("never writes outside the download directory for the name %j", async (name) => {
    const saved = await downloadAttachment(CDN, dest, name).catch(() => null);
    // Whether the name was reduced to its last segment or refused outright,
    // every file this produced is inside the download directory.
    expect(everyFileUnder(root).every((file) => path.dirname(file) === dest)).toBe(true);
    if (saved !== null) expect(path.dirname(saved)).toBe(dest);
  });

  it("never writes outside the download directory for a name that is an absolute path", async () => {
    // Somewhere else inside this test's own directory: were the name taken as
    // a path, the write would still land in the sandbox.
    const elsewhere = path.join(root, "elsewhere", "absolute-escape.txt");
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });

    const saved = await downloadAttachment(CDN, dest, elsewhere).catch(() => null);

    expect(fs.existsSync(elsewhere)).toBe(false);
    expect(everyFileUnder(root).every((file) => path.dirname(file) === dest)).toBe(true);
    if (saved !== null) expect(saved).toBe(path.join(dest, "absolute-escape.txt"));
  });

  const notFileNames: unknown[][] = [[""], ["."], [".."], ["dir/"], ["dir/.."], ["a\u0000b"], [undefined], [{ toString: (): string => "../x" }]];
  it.each(notFileNames)(
    "refuses %j, which names no file",
    async (name) => {
      await expect(downloadAttachment(CDN, dest, name as string)).rejects.toThrow(/attachment name/i);
      expect(outbound).not.toHaveBeenCalled();
      expect(everyFileUnder(root)).toEqual([]);
    },
  );
});

describe("downloadAttachment with a host allowlist", () => {
  const trusted = { allowedHosts: ["cdn.discordapp.com", "media.discordapp.net"], maxBytes: 1024 };

  it("fetches from an allowed host over https, and refuses to follow it elsewhere", async () => {
    const saved = await downloadAttachment(CDN, dest, "photo.png", trusted);
    expect(fs.readFileSync(saved, "utf-8")).toBe("file-bytes");
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it.each([
    ["http://127.0.0.1:7777/api/config"],
    ["http://169.254.169.254/latest/meta-data/"],
    ["https://internal.example/secret"],
    ["http://cdn.discordapp.com/attachments/1/2/photo.png"], // right host, not https
    ["https://cdn.discordapp.com:8443/attachments/1/2/photo.png"],
    ["https://cdn.discordapp.com.attacker.example/photo.png"],
    ["https://attacker.example/@cdn.discordapp.com/photo.png"],
    ["https://user:pass@cdn.discordapp.com/photo.png"],
    ["file:///etc/passwd"],
    ["not a url"],
  ])("does not fetch %s", async (url) => {
    await expect(downloadAttachment(url, dest, "photo.png", trusted)).rejects.toThrow();
    expect(outbound).not.toHaveBeenCalled();
    expect(everyFileUnder(root)).toEqual([]);
  });

  it("refuses a file the server announces as larger than the limit, without reading it", async () => {
    const body = { cancel: vi.fn(async () => {}) };
    outbound.mockResolvedValue({ ok: true, status: 200, headers: new Headers({ "content-length": "2048" }), body } as unknown as Response);
    await expect(downloadAttachment(CDN, dest, "photo.png", trusted)).rejects.toThrow(/too large/i);
    expect(everyFileUnder(root)).toEqual([]);
  });

  it("stops at the limit when the size was not announced, and leaves nothing behind", async () => {
    outbound.mockResolvedValue(new Response("x".repeat(4096)));
    await expect(downloadAttachment(CDN, dest, "photo.png", trusted)).rejects.toThrow(/too large/i);
    expect(everyFileUnder(root)).toEqual([]);
  });

  it("accepts a file exactly at the limit", async () => {
    outbound.mockResolvedValue(new Response("x".repeat(1024)));
    const saved = await downloadAttachment(CDN, dest, "photo.png", trusted);
    expect(fs.statSync(saved).size).toBe(1024);
  });
});

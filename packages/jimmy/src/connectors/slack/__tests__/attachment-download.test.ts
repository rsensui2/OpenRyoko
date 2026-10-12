import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("refuses a file announced as larger than 50 MB without reading it", async () => {
    const body = { cancel: vi.fn(async () => {}) };
    outbound.mockResolvedValue({
      ok: true, status: 200, statusText: "OK", headers: new Headers({ "content-length": String(50 * 1024 * 1024 + 1) }), body,
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

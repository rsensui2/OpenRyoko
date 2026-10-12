import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFile, insertFile, listFiles } from "../../sessions/registry.js";
import { FILES_DIR, JINN_HOME } from "../../shared/paths.js";
import type { ApiContext } from "../api.js";
import { handleFilesRequest, MAX_UPLOAD_BYTES } from "../files.js";

/* POST /api/files stores a file the chat page attaches to a message. It also
 * took three things nothing in the product sends — a `filename` with a path in
 * it, a `path` to write a second copy to, a `url` to fetch the contents from —
 * and did as told with each: a caller past the auth gate could write a file
 * anywhere the gateway can write, and have the gateway fetch any URL it can
 * reach and hand back the answer.
 *
 * Every path a test sends here is inside the test home, never `~` and never
 * deeper than that home: against the old code these requests really wrote
 * where they pointed. The `open` flag is never sent. */

const outbound = vi.fn<typeof fetch>();
const emit = vi.fn();
const context = { emit } as unknown as ApiContext;

interface Answer { status: number; headers: Record<string, unknown>; text: string; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

function answerOf(): { res: ServerResponse; done: () => Answer } {
  let status = 0;
  let headers: Record<string, unknown> = {};
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }) as unknown as ServerResponse & { writeHead: unknown };
  res.writeHead = ((code: number, given?: Record<string, unknown>) => {
    status = code;
    headers = given ?? {};
    return res;
  }) as never;
  return {
    res,
    done: () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status, headers, text, body };
    },
  };
}

interface SendOptions {
  /** The upload limit to run the route with, instead of its 50 MB. */
  limit?: number;
  headers?: Record<string, string>;
}

async function send(method: string, pathname: string, payload: Buffer | Iterable<Buffer> | null, contentType: string, options: SendOptions = {}): Promise<Answer> {
  const req = Readable.from(payload === null ? [] : Buffer.isBuffer(payload) ? [payload] : payload) as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1", "content-type": contentType, ...options.headers };
  req.method = method;
  req.url = pathname;
  const { res, done } = answerOf();
  const finished = new Promise<void>((resolve) => (res as unknown as Writable).on("finish", () => resolve()));
  const handled = options.limit === undefined
    ? await handleFilesRequest(req, res, pathname, method, context)
    : await handleFilesRequest(req, res, pathname, method, context, options.limit);
  expect(handled).toBe(true);
  await finished;
  return done();
}

const postJson = (body: Record<string, unknown>, options?: SendOptions) =>
  send("POST", "/api/files", Buffer.from(JSON.stringify(body)), "application/json", options);

function postMultipart(filename: string, contents: string, fields: Record<string, string> = {}, options?: SendOptions) {
  const boundary = "----ryoko-test-boundary";
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${contents}\r\n`,
    ...Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    `--${boundary}--\r\n`,
  ];
  return send("POST", "/api/files", Buffer.from(parts.join("")), `multipart/form-data; boundary=${boundary}`, options);
}

const base64 = (text: string) => Buffer.from(text).toString("base64");
const storedFiles = () =>
  fs.existsSync(FILES_DIR)
    ? fs.readdirSync(FILES_DIR, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
    : [];

/** Files a test asked for outside the storage; removed one by one afterwards if the code under test did create them. */
let strays: string[];
let knownIds: Set<string>;

beforeEach(() => {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  strays = [];
  knownIds = new Set(listFiles().map((file) => file.id));
  emit.mockReset();
  outbound.mockReset().mockImplementation(async () => new Response("fetched-bytes"));
  vi.stubGlobal("fetch", outbound);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const stray of strays) {
    if (fs.existsSync(stray)) fs.unlinkSync(stray);
  }
});

const newRows = () => listFiles().filter((file) => !knownIds.has(file.id));

describe("POST /api/files: where the file is written", () => {
  it("stores an upload under its own name in a directory of its own", async () => {
    const answer = await postJson({ filename: "report.txt", content: base64("hello") });

    expect(answer.status).toBe(201);
    expect(answer.body.filename).toBe("report.txt");
    expect(fs.readFileSync(path.join(FILES_DIR, answer.body.id, "report.txt"), "utf-8")).toBe("hello");
  });

  it("does not write outside the storage for a filename with ../ in it", async () => {
    const name = `escaped-${randomUUID()}.txt`;
    const outside = path.join(JINN_HOME, name); // where files/<id>/../../<name> lands
    strays.push(outside);

    const answer = await postJson({ filename: `../../${name}`, content: base64("planted") });

    expect(fs.existsSync(outside)).toBe(false);
    expect(answer.status).toBe(201);
    expect(answer.body.filename).toBe(name); // kept under its last segment
    expect(fs.readFileSync(path.join(FILES_DIR, answer.body.id, name), "utf-8")).toBe("planted");
    expect(getFile(answer.body.id)?.filename).toBe(name);
  });

  it.each([
    ["an absolute path", (name: string) => `/var/empty/${name}`],
    ["a Windows-style path", (name: string) => `..\\..\\${name}`],
    ["a path through a directory", (name: string) => `nested/dir/${name}`],
  ])("keeps only the last segment of %s", async (_what, build) => {
    const name = `segment-${randomUUID()}.txt`;
    const answer = await postJson({ filename: build(name), content: base64("x") });
    expect(answer.status).toBe(201);
    expect(answer.body.filename).toBe(name);
    expect(storedFiles()).toContain(path.join(FILES_DIR, answer.body.id, name));
  });

  it.each([[".."], ["."], ["a/.."], ["trailing/"], ["bad\u0000name.txt"], [""], [42], [{ name: "x" }]])(
    "refuses %j as a filename and stores nothing",
    async (filename) => {
      const before = storedFiles();
      const answer = await postJson({ filename, content: base64("x") });
      expect(answer.status).toBe(400);
      expect(storedFiles()).toEqual(before);
      expect(newRows()).toEqual([]);
    },
  );

  it("treats the name of a multipart upload the same way", async () => {
    const name = `multipart-${randomUUID()}.txt`;
    strays.push(path.join(JINN_HOME, name));

    const answer = await postMultipart(`../../${name}`, "from the chat page");

    expect(answer.status).toBe(201);
    expect(answer.body.filename).toBe(name);
    expect(fs.existsSync(path.join(JINN_HOME, name))).toBe(false);
    expect(fs.readFileSync(path.join(FILES_DIR, answer.body.id, name), "utf-8")).toBe("from the chat page");
  });
});

describe("POST /api/files: the `path` it no longer writes to", () => {
  it("refuses a JSON upload that names a path, and writes nothing there or anywhere", async () => {
    const target = path.join(JINN_HOME, `custom-${randomUUID()}.txt`);
    strays.push(target);
    const before = storedFiles();

    const answer = await postJson({ filename: "report.txt", content: base64("hello"), path: target });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/path/);
    expect(fs.existsSync(target)).toBe(false);
    expect(storedFiles()).toEqual(before);
    expect(newRows()).toEqual([]);
  });

  it("refuses a multipart upload that names a path", async () => {
    const target = path.join(JINN_HOME, `custom-${randomUUID()}.txt`);
    strays.push(target);

    const answer = await postMultipart("report.txt", "hello", { path: target });

    expect(answer.status).toBe(400);
    expect(fs.existsSync(target)).toBe(false);
    expect(newRows()).toEqual([]);
  });

  it("records no path for an upload", async () => {
    const answer = await postMultipart("report.txt", "hello");
    expect(answer.status).toBe(201);
    expect(getFile(answer.body.id)?.path ?? null).toBeNull();
  });
});

describe("POST /api/files: the `url` it no longer fetches", () => {
  it.each([
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["the gateway itself", "http://127.0.0.1:7777/api/config"],
    ["a public https URL", "https://example.com/report.pdf"],
  ])("refuses to fetch %s, and makes no request", async (_what, url) => {
    const answer = await postJson({ filename: "fetched.txt", url });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/url/);
    expect(outbound).not.toHaveBeenCalled();
    expect(newRows()).toEqual([]);
  });

  it("still needs the content", async () => {
    expect((await postJson({ filename: "empty.txt" })).status).toBe(400);
    expect(newRows()).toEqual([]);
  });
});

describe("GET /api/files/:id", () => {
  it("serves an uploaded file", async () => {
    const uploaded = await postJson({ filename: "report.txt", content: base64("hello") });
    const got = await send("GET", `/api/files/${uploaded.body.id}`, null, "");
    expect(got.status).toBe(200);
    expect(got.text).toBe("hello");
  });

  it("does not serve a file outside the storage for a record whose name points out of it", async () => {
    // A record as the old upload code could leave it: the name walks out of files/<id>/.
    const id = randomUUID();
    const name = `outside-${randomUUID()}.txt`;
    const outside = path.join(JINN_HOME, name);
    strays.push(outside);
    fs.writeFileSync(outside, "not an upload");
    insertFile({ id, filename: `../../${name}`, size: 13, mimetype: "text/plain", path: null });

    const got = await send("GET", `/api/files/${id}`, null, "");

    expect(got.status).toBe(404);
    expect(got.text).not.toContain("not an upload");
  });
});

describe("POST /api/files: one size limit for both ways of sending a file", () => {
  /* A multipart upload over 50 MB was refused; the same file sent as base64
   * in a JSON body was stored, whatever its size, after being read into memory
   * in full. The limit is the upload's, not the encoding's. (Run here with a
   * limit of 1,000 bytes, which makes the same point without the megabytes.) */
  const LIMIT = 1000;
  const bytes = (count: number) => "x".repeat(count);

  it("is 50 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });

  it("stores a JSON upload of exactly the limit, and refuses one byte more", async () => {
    const atLimit = await postJson({ filename: "ok.bin", content: base64(bytes(LIMIT)) }, { limit: LIMIT });
    expect(atLimit.status).toBe(201);
    expect(fs.statSync(path.join(FILES_DIR, atLimit.body.id, "ok.bin")).size).toBe(LIMIT);

    const before = storedFiles();
    const over = await postJson({ filename: "big.bin", content: base64(bytes(LIMIT + 1)) }, { limit: LIMIT });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/exceeds/);
    expect(storedFiles()).toEqual(before);
    expect(newRows().map((row) => row.filename)).toEqual(["ok.bin"]);
  });

  it("treats a multipart upload the same", async () => {
    const atLimit = await postMultipart("ok.bin", bytes(LIMIT), {}, { limit: LIMIT });
    expect(atLimit.status).toBe(201);

    const over = await postMultipart("big.bin", bytes(LIMIT + 1), {}, { limit: LIMIT });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/exceeds/);
    expect(newRows().map((row) => row.filename)).toEqual(["ok.bin"]);
  });

  it("gives the same answer for both", async () => {
    const json = await postJson({ filename: "big.bin", content: base64(bytes(LIMIT + 1)) }, { limit: LIMIT });
    const multipart = await postMultipart("big.bin", bytes(LIMIT + 1), {}, { limit: LIMIT });
    expect(json.body).toEqual(multipart.body);
    expect(json.status).toBe(multipart.status);
  });

  it("refuses a JSON body announced as larger than any upload within the limit, without reading it", async () => {
    let pulled = 0;
    function* body() {
      pulled++;
      yield Buffer.from(JSON.stringify({ filename: "small.txt", content: base64("hello") }));
    }
    const answer = await send("POST", "/api/files", body(), "application/json", { headers: { "content-length": String(100 * 1024 * 1024) } });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/exceeds 50 MB/);
    expect(pulled).toBe(0);
    expect(newRows()).toEqual([]);
  });

  it("stops keeping a JSON body that runs past what the limit allows, however much more is sent", async () => {
    function* endless() {
      yield Buffer.from('{"filename":"big.bin","content":"');
      for (let sent = 0; sent < 200; sent++) yield Buffer.alloc(64 * 1024, "A");
      yield Buffer.from('"}');
    }
    const before = storedFiles();

    const answer = await send("POST", "/api/files", endless(), "application/json", { limit: LIMIT });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/exceeds/);
    expect(storedFiles()).toEqual(before);
    expect(newRows()).toEqual([]);
  });
});

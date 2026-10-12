import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Nothing is ever launched from this file: spawn is replaced before any code
// under test is loaded, and each test checks that the replacement is in place
// before it sends a request.
const spawn = vi.hoisted(() => vi.fn(() => ({ unref() {}, on() {} })));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

import { listFiles } from "../../sessions/registry.js";
import { FILES_DIR } from "../../shared/paths.js";
import type { ApiContext } from "../api.js";
import { handleFilesRequest } from "../files.js";

/* POST /api/files took an `open` flag and ran `open <the uploaded file>` on
 * the machine the gateway runs on: on a Mac that hands the upload to whatever
 * application claims its type; where there is no `open` command the spawn
 * fails with nobody listening, which takes the gateway process down. Nothing
 * in the product sends the flag. */

async function post(payload: Buffer, contentType: string) {
  const { spawn: inPlace } = await import("node:child_process");
  if (!vi.isMockFunction(inPlace)) throw new Error("spawn is not replaced: refusing to send a request that could launch something");

  const req = Readable.from([payload]) as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1", "content-type": contentType };
  req.method = "POST";
  req.url = "/api/files";
  let status = 0;
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }) as unknown as ServerResponse & { writeHead: unknown };
  res.writeHead = ((code: number) => {
    status = code;
    return res;
  }) as never;
  const finished = new Promise<void>((resolve) => (res as unknown as Writable).on("finish", () => resolve()));
  await handleFilesRequest(req, res, "/api/files", "POST", { emit: vi.fn() } as unknown as ApiContext);
  await finished;
  const text = Buffer.concat(chunks).toString("utf-8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: (text ? JSON.parse(text) : null) as any };
}

const postJson = (body: Record<string, unknown>) => post(Buffer.from(JSON.stringify(body)), "application/json");

function postMultipart(fields: Record<string, string>) {
  const boundary = "----ryoko-test-boundary";
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n`,
    ...Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    `--${boundary}--\r\n`,
  ];
  return post(Buffer.from(parts.join("")), `multipart/form-data; boundary=${boundary}`);
}

const content = Buffer.from("hello").toString("base64");
let knownIds: Set<string>;

beforeEach(() => {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  spawn.mockClear();
  knownIds = new Set(listFiles().map((file) => file.id));
});

const newRows = () => listFiles().filter((file) => !knownIds.has(file.id));

describe("POST /api/files and the `open` flag", () => {
  it.each([[true], [1], ["true"], ["yes"]])("refuses a JSON upload with open: %j, launches nothing and stores nothing", async (open) => {
    const answer = await postJson({ filename: "note.txt", content, open });

    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/open/);
    expect(spawn).not.toHaveBeenCalled();
    expect(newRows()).toEqual([]);
  });

  it.each([["true"], ["1"]])("refuses a multipart upload with open=%s", async (open) => {
    const answer = await postMultipart({ open });

    expect(answer.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
    expect(newRows()).toEqual([]);
  });

  it("stores an upload that does not ask for it, as before, and launches nothing", async () => {
    const plain = await postJson({ filename: "note.txt", content });
    const explicitOff = await postJson({ filename: "note.txt", content, open: false });
    const multipart = await postMultipart({ open: "false" });

    for (const answer of [plain, explicitOff, multipart]) {
      expect(answer.status).toBe(201);
      expect(fs.readFileSync(path.join(FILES_DIR, answer.body.id, "note.txt"), "utf-8")).toBe("hello");
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});

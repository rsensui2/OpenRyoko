import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentTooLargeError, attachmentLimitBytes, DEFAULT_MAX_ATTACHMENT_MB, saveResponseWithin, saveWithin } from "../attachment-download.js";

/* Every connector saves the files people send it. The size of such a file is
 * the sender's choice, so a save must stop at a limit — while reading, not
 * after the whole body has been taken into memory — and a save that stops
 * must leave nothing behind.
 *
 * The code under test removes the partial file it wrote and the directories
 * it created for it. It does so with unlink and a non-recursive rmdir only,
 * and every path here is an absolute path inside a directory made for the
 * test, so a mistake in it cannot remove anything that matters. */

let root: string;
let dest: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-attachment-download-"));
  dest = path.join(root, "message", "0", "photo.png");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const everythingUnder = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

/** A source that counts how far it was read and whether it was closed early. */
function source(chunks: Array<Uint8Array | Error>) {
  const state = { pulled: 0, closed: false };
  async function* generate() {
    try {
      for (const chunk of chunks) {
        state.pulled++;
        if (chunk instanceof Error) throw chunk;
        yield chunk;
      }
    } finally {
      state.closed = true;
    }
  }
  return { chunks: generate(), state };
}

const bytes = (length: number, fill = "x") => Buffer.from(fill.repeat(length));

describe("saveWithin", () => {
  it("writes what it is given, creating the directories the file needs", async () => {
    await saveWithin(source([bytes(3, "a"), bytes(2, "b")]).chunks, dest, 100);
    expect(fs.readFileSync(dest, "utf-8")).toBe("aaabb");
  });

  it("accepts a file of exactly the limit", async () => {
    await saveWithin(source([bytes(60), bytes(40)]).chunks, dest, 100);
    expect(fs.statSync(dest).size).toBe(100);
  });

  it("saves an empty file for an empty body", async () => {
    await saveWithin(source([]).chunks, dest, 100);
    expect(fs.statSync(dest).size).toBe(0);
  });

  it("refuses one byte more than the limit and leaves nothing behind — not the file, not the directories made for it", async () => {
    await expect(saveWithin(source([bytes(60), bytes(41)]).chunks, dest, 100)).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(everythingUnder(root)).toEqual([]);
  });

  it("stops reading the moment the limit is passed", async () => {
    const { chunks, state } = source([bytes(60), bytes(60), bytes(60), bytes(60)]);
    await expect(saveWithin(chunks, dest, 100)).rejects.toThrow(/too large/i);
    expect(state.pulled).toBe(2); // the third and fourth chunks were never asked for
    expect(state.closed).toBe(true); // and the source was told to stop
  });

  it("keeps in memory no more than the chunk in hand: what was read is already on disk when the next chunk comes", async () => {
    const sizesSeen: number[] = [];
    async function* watching() {
      yield bytes(10);
      sizesSeen.push(fs.statSync(dest).size);
      yield bytes(10);
      sizesSeen.push(fs.statSync(dest).size);
    }
    await saveWithin(watching(), dest, 100);
    expect(sizesSeen).toEqual([10, 20]);
  });

  it("removes only what it created: a directory that was already there stays, with what was in it", async () => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const neighbour = path.join(path.dirname(dest), "other.png");
    fs.writeFileSync(neighbour, "keep me");

    await expect(saveWithin(source([bytes(101)]).chunks, dest, 100)).rejects.toThrow(/too large/i);

    expect(everythingUnder(root)).toEqual(["message", "message/0", "message/0/other.png"]);
    expect(fs.readFileSync(neighbour, "utf-8")).toBe("keep me");
  });

  it("removes the directories it created up to the first one that was already there", async () => {
    fs.mkdirSync(path.join(root, "message"));
    await expect(saveWithin(source([bytes(10), bytes(200)]).chunks, dest, 100)).rejects.toThrow(/too large/i);
    expect(everythingUnder(root)).toEqual(["message"]);
  });

  it("passes on a failure of the source, and leaves nothing behind then either", async () => {
    await expect(saveWithin(source([bytes(10), new Error("connection reset")]).chunks, dest, 100)).rejects.toThrow("connection reset");
    expect(everythingUnder(root)).toEqual([]);
  });

  it("reads a Node stream the same way, and destroys it when it stops early", async () => {
    const stream = Readable.from([bytes(60), bytes(60), bytes(60)]);
    await expect(saveWithin(stream, dest, 100)).rejects.toThrow(/too large/i);
    expect(stream.destroyed).toBe(true);
    expect(everythingUnder(root)).toEqual([]);
  });

  it("says how large is too large, and nothing about the file", async () => {
    const failure = await saveWithin(source([bytes(101)]).chunks, dest, 100).catch((err: unknown) => err);
    expect((failure as Error).message).toBe("Attachment is too large (limit 100 bytes)");
  });
});

describe("saveResponseWithin", () => {
  it("saves the body of a response", async () => {
    await saveResponseWithin(new Response("file-bytes"), dest, 100);
    expect(fs.readFileSync(dest, "utf-8")).toBe("file-bytes");
  });

  it("refuses a body announced as larger than the limit without reading any of it", async () => {
    const cancel = vi.fn(async () => {});
    const getReader = vi.fn();
    const response = { headers: new Headers({ "content-length": "101" }), body: { cancel, getReader } } as unknown as Response;

    await expect(saveResponseWithin(response, dest, 100)).rejects.toBeInstanceOf(AttachmentTooLargeError);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(everythingUnder(root)).toEqual([]);
  });

  it("does not take the announced size on trust: a body that runs past the limit is cut off", async () => {
    const response = new Response("x".repeat(500), { headers: { "content-length": "50" } });
    await expect(saveResponseWithin(response, dest, 100)).rejects.toThrow(/too large/i);
    expect(everythingUnder(root)).toEqual([]);
  });

  it("saves an empty file for a response without a body", async () => {
    await saveResponseWithin(new Response(null), dest, 100);
    expect(fs.statSync(dest).size).toBe(0);
  });
});

describe("attachmentLimitBytes", () => {
  /* A limit of 50 MB — the first one — turned away the videos and recordings
   * people had been sending all along. The limit is each connector's own
   * setting now (`maxAttachmentMb`), and generous unless it is set. */
  const MB = 1024 * 1024;

  it("is 200 MB unless the connector says otherwise", () => {
    expect(DEFAULT_MAX_ATTACHMENT_MB).toBe(200);
    expect(attachmentLimitBytes(undefined)).toBe(200 * MB);
  });

  it("takes the connector's maxAttachmentMb, whole or fractional", () => {
    expect(attachmentLimitBytes(50)).toBe(50 * MB);
    expect(attachmentLimitBytes(1024)).toBe(1024 * MB);
    expect(attachmentLimitBytes(0.5)).toBe(MB / 2);
  });

  it.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY], ["100"], [null], [{}], [true]])(
    "falls back to the default for %j, which is not a size",
    (value) => {
      expect(attachmentLimitBytes(value)).toBe(200 * MB);
    },
  );
});

describe("AttachmentTooLargeError", () => {
  it("remembers the limit that was passed, for whoever has to explain it", () => {
    const failure = new AttachmentTooLargeError(200 * 1024 * 1024);
    expect(failure.maxBytes).toBe(200 * 1024 * 1024);
    expect(failure.message).toBe("Attachment is too large (limit 209715200 bytes)");
  });
});

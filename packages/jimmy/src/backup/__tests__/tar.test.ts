import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeTarEntry,
  encodeTarHeaderBlock,
  readTar,
  tarPadding,
  TAR_BLOCK_BYTES,
  TAR_TRAILER,
  type TarEntry,
} from "../tar.js";

const scratch: string[] = [];
const MTIME = 1_760_000_000;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-tar-"));
  scratch.push(dir);
  return dir;
}

function file(entryPath: string, contents: string, mode = 0o644): { entry: TarEntry; data: Buffer } {
  const data = Buffer.from(contents, "utf8");
  return { entry: { path: entryPath, type: "file", mode, size: data.length, mtimeSeconds: MTIME }, data };
}

function directory(entryPath: string): { entry: TarEntry; data: Buffer } {
  return { entry: { path: entryPath, type: "directory", mode: 0o755, size: 0, mtimeSeconds: MTIME }, data: Buffer.alloc(0) };
}

function symlink(entryPath: string, linkTarget: string): { entry: TarEntry; data: Buffer } {
  return {
    entry: { path: entryPath, type: "symlink", mode: 0o777, size: 0, mtimeSeconds: MTIME, linkTarget },
    data: Buffer.alloc(0),
  };
}

function archiveOf(items: { entry: TarEntry; data: Buffer }[]): Buffer {
  return Buffer.concat([
    ...items.flatMap(({ entry, data }) => [encodeTarEntry(entry), data, tarPadding(data.length)]),
    TAR_TRAILER,
  ]);
}

/** Feeds the archive in awkward slices, so nothing depends on block-aligned chunks. */
async function* slices(archive: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < archive.length; offset += size) yield archive.subarray(offset, offset + size);
}

async function readAll(archive: Buffer, sliceBytes = 777): Promise<{ entry: TarEntry; data: string }[]> {
  const seen: { entry: TarEntry; data: string }[] = [];
  await readTar(slices(archive, sliceBytes), (entry) => {
    const chunks: Buffer[] = [];
    return {
      write: (chunk) => { chunks.push(Buffer.from(chunk)); },
      end: () => { seen.push({ entry, data: Buffer.concat(chunks).toString("utf8") }); },
    };
  });
  return seen;
}

const hasSystemTar = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tar codec", () => {
  it("round-trips files, directories and symlinks", async () => {
    const items = [
      directory("skills"),
      file("skills/run.sh", "#!/bin/sh\necho hi\n", 0o755),
      symlink("skills/shared", "../elsewhere/shared"),
      file("config.yaml", "gateway:\n  port: 7901\n", 0o600),
    ];

    const seen = await readAll(archiveOf(items));

    expect(seen.map(({ entry }) => entry)).toEqual(items.map(({ entry }) => entry));
    expect(seen.map(({ data }) => data)).toEqual(items.map(({ data }) => data.toString("utf8")));
  });

  it.each([0, 1, TAR_BLOCK_BYTES - 1, TAR_BLOCK_BYTES, TAR_BLOCK_BYTES + 1, 70_000])(
    "carries a %i byte file intact",
    async (bytes) => {
      const contents = "x".repeat(bytes);
      const seen = await readAll(archiveOf([file("knowledge/note.md", contents), file("after.txt", "next")]));

      expect(seen[0]!.data).toBe(contents);
      expect(seen[1]!.data).toBe("next");
    },
  );

  it("keeps paths longer than a ustar name field and non-ASCII names", async () => {
    const long = `knowledge/${"deep/".repeat(40)}note.md`;
    const japanese = "knowledge/議事録/2026年10月の振り返り.md";
    expect(Buffer.byteLength(long)).toBeGreaterThan(100);

    const seen = await readAll(archiveOf([file(long, "long"), file(japanese, "日本語"), directory(`knowledge/${"あ".repeat(60)}`)]));

    expect(seen.map(({ entry }) => entry.path)).toEqual([long, japanese, `knowledge/${"あ".repeat(60)}`]);
    expect(seen[1]!.data).toBe("日本語");
    expect(seen[2]!.entry.type).toBe("directory");
  });

  it("keeps a symlink target longer than a ustar link field", async () => {
    const target = `/Users/someone/${"nested/".repeat(30)}skill`;

    const seen = await readAll(archiveOf([symlink("skills/linked", target)]));

    expect(seen[0]!.entry).toMatchObject({ type: "symlink", linkTarget: target });
  });

  it("reads a size carried by a pax record, for files past the ustar limit", async () => {
    const huge = encodeTarEntry({ path: "big.bin", type: "file", mode: 0o600, size: 2 ** 33 + 1, mtimeSeconds: MTIME });
    expect(huge.toString("latin1")).toContain("size=8589934593\n");

    // A pax record's length counts its own digits: "10 size=5\n" is ten bytes.
    const paxBody = Buffer.from("10 size=5\n", "latin1");
    const archive = Buffer.concat([
      encodeTarHeaderBlock({ name: "PaxHeader", mode: 0o644, size: paxBody.length, mtimeSeconds: MTIME, typeflag: "x" }),
      paxBody,
      tarPadding(paxBody.length),
      encodeTarHeaderBlock({ name: "small.txt", mode: 0o600, size: 0, mtimeSeconds: MTIME, typeflag: "0" }),
      Buffer.from("hello"),
      tarPadding(5),
      TAR_TRAILER,
    ]);

    const seen = await readAll(archive);

    expect(seen).toEqual([{ entry: expect.objectContaining({ path: "small.txt", size: 5 }), data: "hello" }]);
  });

  it("refuses a pax header far larger than a path, a link target and a size could need", async () => {
    // A reader has to hold a pax header whole before it can use it.
    const body = Buffer.alloc(64 * 1024, 0x61);
    const archive = Buffer.concat([
      encodeTarHeaderBlock({ name: "PaxHeader", mode: 0o644, size: body.length, mtimeSeconds: MTIME, typeflag: "x" }),
      body,
      tarPadding(body.length),
      TAR_TRAILER,
    ]);

    await expect(readAll(archive)).rejects.toThrow(/implausibly large/);
  });

  it("skips the data of an entry nobody asked for", async () => {
    const archive = archiveOf([file("skip.txt", "a".repeat(3000)), file("keep.txt", "kept")]);
    const kept: string[] = [];

    await readTar(slices(archive, 500), (entry) => {
      if (entry.path !== "keep.txt") return undefined;
      return { write: (chunk) => { kept.push(chunk.toString("utf8")); }, end: () => {} };
    });

    expect(kept.join("")).toBe("kept");
  });

  it("refuses a header whose checksum does not match", async () => {
    const archive = archiveOf([file("config.yaml", "port: 1\n")]);
    archive[0] = archive[0]! ^ 0x01;

    await expect(readAll(archive)).rejects.toThrow(/checksum/);
  });

  it("refuses an archive that ends before its end-of-archive marker", async () => {
    const whole = archiveOf([file("config.yaml", "x".repeat(2000))]);

    await expect(readAll(whole.subarray(0, whole.length - TAR_TRAILER.length))).rejects.toThrow(/truncated/);
    await expect(readAll(whole.subarray(0, TAR_BLOCK_BYTES + 700))).rejects.toThrow(/truncated/);
    await expect(readAll(Buffer.alloc(0))).rejects.toThrow(/truncated/);
  });

  it.each([
    ["hard link", "1"],
    ["character device", "3"],
    ["FIFO", "6"],
    ["GNU long name", "L"],
  ])("refuses a %s entry", async (_label, typeflag) => {
    const archive = Buffer.concat([
      encodeTarHeaderBlock({ name: "entry", mode: 0o644, size: 0, mtimeSeconds: MTIME, typeflag, linkname: "config.yaml" }),
      TAR_TRAILER,
    ]);

    await expect(readAll(archive)).rejects.toThrow(/unsupported tar entry type/i);
  });

  it("refuses data that follows the end-of-archive marker", async () => {
    const archive = Buffer.concat([archiveOf([file("config.yaml", "port: 1\n")]), Buffer.from("smuggled")]);

    await expect(readAll(archive)).rejects.toThrow(/after the end of the archive/);
  });

  it("refuses a directory or symlink that claims to carry data", async () => {
    const archive = Buffer.concat([
      encodeTarHeaderBlock({ name: "skills/", mode: 0o755, size: 4, mtimeSeconds: MTIME, typeflag: "5" }),
      Buffer.from("data"),
      tarPadding(4),
      TAR_TRAILER,
    ]);

    await expect(readAll(archive)).rejects.toThrow(/must not carry data/);
  });

  it.skipIf(!hasSystemTar)("writes archives the system tar can list and extract", () => {
    const dir = tempDir();
    const japanese = "knowledge/議事録.md";
    const long = `knowledge/${"deep/".repeat(30)}note.md`;
    const archive = archiveOf([
      directory("knowledge"),
      file(japanese, "日本語\n"),
      ...Array.from({ length: 30 }, (_, depth) => directory(`knowledge/${"deep/".repeat(depth + 1).slice(0, -1)}`)),
      file(long, "long\n"),
      file("run.sh", "#!/bin/sh\n", 0o755),
      symlink("linked", "run.sh"),
    ]);
    const archivePath = path.join(dir, "sample.tar");
    fs.writeFileSync(archivePath, archive);
    const out = path.join(dir, "out");
    fs.mkdirSync(out);

    execFileSync("tar", ["-xf", archivePath, "-C", out], { stdio: ["ignore", "ignore", "pipe"] });

    expect(fs.readFileSync(path.join(out, japanese), "utf8")).toBe("日本語\n");
    expect(fs.readFileSync(path.join(out, long), "utf8")).toBe("long\n");
    expect(fs.readlinkSync(path.join(out, "linked"))).toBe("run.sh");
    expect(fs.statSync(path.join(out, "run.sh")).mode & 0o111).not.toBe(0);
  });
});

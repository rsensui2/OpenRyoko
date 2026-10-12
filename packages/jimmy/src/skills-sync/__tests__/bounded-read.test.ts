import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashBounded, listBounded, readBounded, TooLargeError } from "../bounded-read.js";

const dirs: string[] = [];
function file(name: string, content: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openryoko-bounded-read-"));
  dirs.push(dir);
  const target = path.join(dir, name);
  fs.writeFileSync(target, content);
  return target;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("bounded reads of files in the home", () => {
  it("returns a small file exactly, and hashes one longer than a chunk correctly", () => {
    const small = Buffer.from([0, 255, 1, 2, 3]);
    expect(readBounded(file("small", small), 1024)).toEqual(small);

    const long = crypto.randomBytes(200_000);
    const target = file("long", long);
    expect(readBounded(target, 1_000_000)).toEqual(long);
    expect(hashBounded(target, 1_000_000)).toBe(crypto.createHash("sha256").update(long).digest("hex"));
  });

  it("accepts a file of exactly the limit and refuses one byte more", () => {
    expect(readBounded(file("at", Buffer.alloc(1024)), 1024)).toHaveLength(1024);
    expect(() => readBounded(file("over", Buffer.alloc(1025)), 1024)).toThrow(TooLargeError);
    expect(() => hashBounded(file("over", Buffer.alloc(1025)), 1024)).toThrow(TooLargeError);
  });

  it("gives up on an oversized file before reading any of it", () => {
    const target = file("huge", "");
    fs.truncateSync(target, 64 * 1024 * 1024);
    const read = vi.spyOn(fs, "readSync");

    expect(() => hashBounded(target, 1024)).toThrow(TooLargeError);

    expect(read).not.toHaveBeenCalled();
  });

  it("cuts off a file that turns out longer than it said it was", () => {
    const target = file("growing", Buffer.alloc(300_000));
    // The size is taken once, on the open file. A file appended to after that, or one
    // whose size is not what it reports, must still not be read past the limit.
    const fstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const real = fstat(fd);
      return { isFile: () => real.isFile(), size: 10 };
    }) as unknown as typeof fs.fstatSync);
    const read = vi.spyOn(fs, "readSync");

    expect(() => hashBounded(target, 100_000)).toThrow(TooLargeError);

    // It stopped within one chunk of the limit instead of reading all 300,000 bytes.
    const bytesRead = read.mock.results.reduce((sum, result) => sum + (result.value as number), 0);
    expect(bytesRead).toBeGreaterThan(100_000);
    expect(bytesRead).toBeLessThanOrEqual(100_000 + 64 * 1024);
  });

  it.skipIf(process.platform === "win32")("does not read through a symlink", () => {
    const real = file("real", "the user's file");
    const link = path.join(path.dirname(real), "link");
    fs.symlinkSync(real, link);

    expect(() => readBounded(link, 1024)).toThrow();
    expect(() => hashBounded(link, 1024)).toThrow();
  });

  it("refuses a directory", () => {
    const target = path.dirname(file("inside", "x"));

    expect(() => readBounded(target, 1024)).toThrow(/not a regular file|EISDIR/);
  });

  it.skipIf(process.platform === "win32")("refuses a device, which would otherwise read as an empty or endless file", () => {
    expect(() => readBounded("/dev/null", 1024)).toThrow("it is not a regular file");
    expect(() => hashBounded("/dev/zero", 1024)).toThrow("it is not a regular file");
  });
});

describe("bounded listing of directories in the home", () => {
  function directory(entries: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openryoko-bounded-list-"));
    dirs.push(dir);
    for (let index = 0; index < entries; index++) fs.writeFileSync(path.join(dir, `entry-${index}`), "");
    return dir;
  }

  it("lists a directory that holds no more than the limit", () => {
    expect(listBounded(directory(0), 3)).toEqual([]);
    expect(listBounded(directory(3), 3)?.sort()).toEqual(["entry-0", "entry-1", "entry-2"]);
  });

  it("answers null for one that holds more, having read one entry past the limit and no further", () => {
    const dir = directory(50);
    const open = fs.opendirSync;
    let read = 0;
    let closed = 0;
    vi.spyOn(fs, "opendirSync").mockImplementation(((...args: Parameters<typeof fs.opendirSync>) => {
      const handle = open(...args);
      const readSync = handle.readSync.bind(handle);
      const closeSync = handle.closeSync.bind(handle);
      handle.readSync = () => { read += 1; return readSync(); };
      handle.closeSync = () => { closed += 1; closeSync(); };
      return handle;
    }) as typeof fs.opendirSync);

    expect(listBounded(dir, 3)).toBeNull();

    expect(read).toBe(4);
    expect(closed).toBe(1);
  });

  it("closes the directory when reading it fails", () => {
    const dir = directory(2);
    const open = fs.opendirSync;
    let closed = 0;
    vi.spyOn(fs, "opendirSync").mockImplementation(((...args: Parameters<typeof fs.opendirSync>) => {
      const handle = open(...args);
      const closeSync = handle.closeSync.bind(handle);
      handle.readSync = () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); };
      handle.closeSync = () => { closed += 1; closeSync(); };
      return handle;
    }) as typeof fs.opendirSync);

    expect(() => listBounded(dir, 3)).toThrow(/EIO/);
    expect(closed).toBe(1);
  });
});

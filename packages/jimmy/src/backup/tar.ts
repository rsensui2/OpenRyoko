/**
 * The subset of tar a home archive needs, read and written in-process.
 *
 * No external `tar` is spawned: the gateway runs in containers with a read-only
 * root and whatever userland the image happens to ship, and a restore has to
 * inspect every entry before a single byte is written - which a child process
 * extracting on its own does not allow. The format stays plain ustar with pax
 * records for long or non-ASCII names, so any system tar can still open an
 * archive by hand.
 *
 * Only files, directories and symlinks exist here. Hard links, devices and the
 * GNU extensions are refused on read rather than interpreted.
 */

export const TAR_BLOCK_BYTES = 512;
/** Two zero blocks close an archive. */
export const TAR_TRAILER = Buffer.alloc(TAR_BLOCK_BYTES * 2);

/** Largest value an 11-digit octal field holds (8 GiB - 1). Past it the size rides in a pax record. */
const USTAR_MAX_SIZE = 0o77777777777;
const USTAR_NAME_BYTES = 100;
/**
 * A pax header only ever carries a path, a link target and a size, and it has
 * to be held whole before it can be used. Sixteen kilobytes is several times
 * the longest path any filesystem allows.
 */
const PAX_MAX_BYTES = 16 * 1024;
const PLAIN_ASCII = /^[\x20-\x7e]*$/;
const PAX_TYPEFLAG = "x";

export type TarEntryType = "file" | "directory" | "symlink";

export interface TarEntry {
  /** Slash-separated, relative, with no trailing slash. */
  path: string;
  type: TarEntryType;
  mode: number;
  /** Bytes of data that follow the header. Always 0 unless `type` is "file". */
  size: number;
  mtimeSeconds: number;
  linkTarget?: string;
}

/** Receives one entry's data. `end` runs once the last byte has been written. */
export interface TarEntrySink {
  write(chunk: Buffer): void | Promise<void>;
  end(): void | Promise<void>;
}

export interface TarHeaderFields {
  name: string;
  mode: number;
  size: number;
  mtimeSeconds: number;
  typeflag: string;
  linkname?: string;
}

const TYPEFLAGS: Record<TarEntryType, string> = { file: "0", directory: "5", symlink: "2" };
const ENTRY_TYPES: Record<string, TarEntryType> = { "0": "file", "\0": "file", "5": "directory", "2": "symlink" };

function writeField(block: Buffer, text: string, offset: number, length: number): void {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > length) throw new Error(`tar header field overflow (${bytes.length} > ${length} bytes)`);
  bytes.copy(block, offset);
}

function octal(value: number, width: number): string {
  return `${Math.max(0, Math.floor(value)).toString(8).padStart(width - 1, "0")}\0`;
}

/** One raw 512-byte ustar header. Exposed so tests can build entries the writer never would. */
export function encodeTarHeaderBlock(fields: TarHeaderFields): Buffer {
  const block = Buffer.alloc(TAR_BLOCK_BYTES);
  writeField(block, fields.name, 0, USTAR_NAME_BYTES);
  writeField(block, octal(fields.mode & 0o7777, 8), 100, 8);
  writeField(block, octal(0, 8), 108, 8);
  writeField(block, octal(0, 8), 116, 8);
  writeField(block, octal(fields.size, 12), 124, 12);
  writeField(block, octal(Math.min(fields.mtimeSeconds, USTAR_MAX_SIZE), 12), 136, 12);
  block.fill(0x20, 148, 156);
  writeField(block, fields.typeflag, 156, 1);
  if (fields.linkname) writeField(block, fields.linkname, 157, USTAR_NAME_BYTES);
  writeField(block, "ustar\0", 257, 6);
  writeField(block, "00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeField(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

/** Zero bytes that bring `size` bytes of data up to the next block boundary. */
export function tarPadding(size: number): Buffer {
  return Buffer.alloc((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);
}

function fitsUstar(text: string): boolean {
  return PLAIN_ASCII.test(text) && text.length <= USTAR_NAME_BYTES;
}

/** What a reader without pax support would see; ours always prefers the record. */
function ustarFallback(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "_").slice(0, USTAR_NAME_BYTES);
}

/** `<length> <key>=<value>\n`, where the length counts its own digits. */
function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  let length = body.length;
  for (;;) {
    const next = body.length + String(length).length;
    if (next === length) break;
    length = next;
  }
  return Buffer.concat([Buffer.from(String(length), "latin1"), body]);
}

/** The header block(s) for one entry: a pax header first when ustar cannot hold it. */
export function encodeTarEntry(entry: TarEntry): Buffer {
  const name = entry.type === "directory" ? `${entry.path}/` : entry.path;
  const size = entry.type === "file" ? entry.size : 0;
  const linkTarget = entry.type === "symlink" ? entry.linkTarget ?? "" : undefined;
  const records: Buffer[] = [];
  if (!fitsUstar(name)) records.push(paxRecord("path", name));
  if (linkTarget !== undefined && !fitsUstar(linkTarget)) records.push(paxRecord("linkpath", linkTarget));
  if (size > USTAR_MAX_SIZE) records.push(paxRecord("size", String(size)));

  const header = encodeTarHeaderBlock({
    name: ustarFallback(name),
    mode: entry.mode,
    size: size > USTAR_MAX_SIZE ? 0 : size,
    mtimeSeconds: entry.mtimeSeconds,
    typeflag: TYPEFLAGS[entry.type],
    ...(linkTarget !== undefined ? { linkname: ustarFallback(linkTarget) } : {}),
  });
  if (records.length === 0) return header;

  const body = Buffer.concat(records);
  const pax = encodeTarHeaderBlock({
    name: "PaxHeader", mode: 0o644, size: body.length, mtimeSeconds: entry.mtimeSeconds, typeflag: PAX_TYPEFLAG,
  });
  return Buffer.concat([pax, body, tarPadding(body.length), header]);
}

function parseOctal(block: Buffer, offset: number, length: number, label: string): number {
  // The high bit marks GNU's base-256 encoding; this codec writes pax records instead.
  if (block[offset]! & 0x80) throw new Error(`unsupported ${label} encoding in tar header`);
  const text = block.toString("latin1", offset, offset + length).replace(/\0[\s\S]*$/, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`corrupt ${label} in tar header`);
  return parseInt(text, 8);
}

function readText(block: Buffer, offset: number, length: number): string {
  const end = block.indexOf(0, offset);
  return block.toString("utf8", offset, end === -1 || end > offset + length ? offset + length : end);
}

function checksumMatches(block: Buffer): boolean {
  const stored = parseOctal(block, 148, 8, "checksum");
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  return sum === stored;
}

function isZeroFilled(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function parsePaxRecords(body: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = space === -1 ? Number.NaN : Number(body.toString("latin1", offset, space));
    if (!Number.isInteger(length) || length <= space - offset + 1 || offset + length > body.length) {
      throw new Error("corrupt pax header in tar archive");
    }
    const record = body.toString("utf8", space + 1, offset + length - 1);
    const separator = record.indexOf("=");
    if (separator === -1) throw new Error("corrupt pax header in tar archive");
    records[record.slice(0, separator)] = record.slice(separator + 1);
    offset += length;
  }
  return records;
}

/** Pulls exact byte counts out of a stream that hands over chunks of any size. */
class ByteReader {
  private current: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(private readonly source: AsyncIterator<Uint8Array>) {}

  private async refill(): Promise<boolean> {
    const next = await this.source.next();
    if (next.done) return false;
    const chunk = next.value;
    this.current = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.offset = 0;
    return true;
  }

  /** Hands `bytes` bytes to `write` in whatever slices the stream delivers them. */
  async forward(bytes: number, write: (chunk: Buffer) => void | Promise<void>): Promise<void> {
    let needed = bytes;
    while (needed > 0) {
      if (this.offset >= this.current.length && !(await this.refill())) throw new Error("truncated tar archive");
      const take = Math.min(needed, this.current.length - this.offset);
      if (take > 0) await write(this.current.subarray(this.offset, this.offset + take));
      this.offset += take;
      needed -= take;
    }
  }

  async read(bytes: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    await this.forward(bytes, (chunk) => { parts.push(chunk); });
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, bytes);
  }

  /** Everything left in the stream, which the caller must still look at. */
  async *rest(): AsyncGenerator<Buffer> {
    if (this.offset < this.current.length) yield this.current.subarray(this.offset);
    while (await this.refill()) yield this.current;
  }
}

function entryFromHeader(block: Buffer, pax: Record<string, string>): TarEntry {
  const typeflag = String.fromCharCode(block[156]!);
  const prefix = readText(block, 345, 155);
  const name = readText(block, 0, USTAR_NAME_BYTES);
  const rawPath = pax.path ?? (prefix ? `${prefix}/${name}` : name);
  const type = ENTRY_TYPES[typeflag];
  if (!type) throw new Error(`unsupported tar entry type "${typeflag}" for ${rawPath}`);

  const size = pax.size !== undefined ? Number(pax.size) : parseOctal(block, 124, 12, "size");
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`corrupt size in tar header for ${rawPath}`);
  if (type !== "file" && size !== 0) throw new Error(`a ${type} entry must not carry data: ${rawPath}`);

  return {
    path: type === "directory" ? rawPath.replace(/\/+$/, "") : rawPath,
    type,
    mode: parseOctal(block, 100, 8, "mode") & 0o7777,
    size,
    mtimeSeconds: parseOctal(block, 136, 12, "mtime"),
    ...(type === "symlink" ? { linkTarget: pax.linkpath ?? readText(block, 157, USTAR_NAME_BYTES) } : {}),
  };
}

async function readPaxRecords(reader: ByteReader, block: Buffer): Promise<Record<string, string>> {
  const size = parseOctal(block, 124, 12, "size");
  if (size > PAX_MAX_BYTES) throw new Error("pax header in tar archive is implausibly large");
  const body = await reader.read(size);
  await reader.read(tarPadding(size).length);
  return parsePaxRecords(body);
}

/**
 * Walks a tar stream entry by entry.
 *
 * `onEntry` decides what happens to each entry's data: return a sink to receive
 * it, or nothing to have it skipped. The stream is always read to its end -
 * the caller's decompressor only verifies its checksum once it is drained, and
 * anything other than padding after the end-of-archive marker is refused.
 */
export async function readTar(
  source: AsyncIterable<Uint8Array>,
  onEntry: (entry: TarEntry) => TarEntrySink | undefined | void | Promise<TarEntrySink | undefined | void>,
): Promise<void> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  let pax: Record<string, string> = {};
  for (;;) {
    const block = await reader.read(TAR_BLOCK_BYTES);
    if (isZeroFilled(block)) break;
    if (!block.toString("latin1", 257, 262).startsWith("ustar") || !checksumMatches(block)) {
      throw new Error("corrupt tar header (checksum mismatch)");
    }
    if (String.fromCharCode(block[156]!) === PAX_TYPEFLAG) {
      pax = await readPaxRecords(reader, block);
      continue;
    }
    const entry = entryFromHeader(block, pax);
    pax = {};
    const sink = await onEntry(entry);
    await reader.forward(entry.size, (chunk) => sink?.write(chunk));
    await reader.read(tarPadding(entry.size).length);
    await sink?.end();
  }
  for await (const chunk of reader.rest()) {
    if (!isZeroFilled(chunk)) throw new Error("unexpected data after the end of the archive");
  }
}

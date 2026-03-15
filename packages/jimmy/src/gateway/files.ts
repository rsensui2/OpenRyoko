import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import Busboy from "busboy";
import { FILES_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { insertFile, getFile, listFiles, deleteFile, type FileMeta } from "../sessions/registry.js";
import type { ApiContext } from "./api.js";

// Ensure managed files directory exists
export function ensureFilesDir(): void {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

// MIME type lookup by extension
const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "application/javascript",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

interface UploadResult {
  id: string;
  filename: string;
  buffer: Buffer;
  customPath: string | null;
  open: boolean;
}

/** Save buffer to managed storage and optionally to a custom path. */
async function saveFile(result: UploadResult, context: ApiContext): Promise<FileMeta> {
  const fileDir = path.join(FILES_DIR, result.id);
  fs.mkdirSync(fileDir, { recursive: true });
  const storagePath = path.join(fileDir, result.filename);
  fs.writeFileSync(storagePath, result.buffer);

  const mimetype = mimeFromFilename(result.filename);
  const meta = insertFile({
    id: result.id,
    filename: result.filename,
    size: result.buffer.length,
    mimetype,
    path: result.customPath,
  });

  // Write to custom path if provided
  if (result.customPath) {
    const expanded = expandPath(result.customPath);
    fs.mkdirSync(path.dirname(expanded), { recursive: true });
    fs.writeFileSync(expanded, result.buffer);
  }

  // Open file if requested
  if (result.open) {
    const targetPath = result.customPath ? expandPath(result.customPath) : storagePath;
    const { spawn } = await import("node:child_process");
    spawn("open", [targetPath], { stdio: "ignore", detached: true }).unref();
  }

  context.emit("file:uploaded", { id: result.id, filename: result.filename, size: result.buffer.length });
  logger.info(`File uploaded: ${result.filename} (${result.id}, ${result.buffer.length} bytes)`);

  return meta;
}

/** Handle POST /api/files — multipart upload */
async function handleMultipartUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  return new Promise((resolve) => {
    const busboy = Busboy({ headers: req.headers });
    let filename = "";
    let fileBuffer: Buffer | null = null;
    let customPath: string | null = null;
    let open = false;

    busboy.on("file", (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
      filename = info.filename;
      const chunks: Buffer[] = [];
      file.on("data", (chunk: Buffer) => chunks.push(chunk));
      file.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });

    busboy.on("field", (name: string, val: string) => {
      if (name === "path") customPath = val;
      if (name === "open") open = val === "true" || val === "1";
    });

    busboy.on("finish", async () => {
      if (!fileBuffer || !filename) {
        badRequest(res, "No file provided");
        resolve();
        return;
      }
      try {
        const meta = await saveFile({
          id: crypto.randomUUID(),
          filename,
          buffer: fileBuffer,
          customPath,
          open,
        }, context);
        json(res, meta, 201);
      } catch (err) {
        serverError(res, err instanceof Error ? err.message : "Upload failed");
      }
      resolve();
    });

    busboy.on("error", (err: Error) => {
      serverError(res, err.message);
      resolve();
    });

    req.pipe(busboy);
  });
}

/** Handle POST /api/files — JSON body (base64 content or URL fetch) */
async function handleJsonUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return badRequest(res, "Invalid JSON body");
  }

  const filename = body.filename as string | undefined;
  const content = body.content as string | undefined;
  const url = body.url as string | undefined;
  const customPath = (body.path as string) || null;
  const open = !!body.open;

  if (!filename) return badRequest(res, "filename is required");
  if (content && url) return badRequest(res, "content and url are mutually exclusive");
  if (!content && !url) return badRequest(res, "content or url is required");

  let buffer: Buffer;

  if (content) {
    // Base64 decode
    try {
      buffer = Buffer.from(content, "base64");
    } catch {
      return badRequest(res, "Invalid base64 content");
    }
  } else {
    // URL fetch
    try {
      const response = await fetch(url!);
      if (!response.ok) {
        return serverError(res, `Failed to fetch URL: ${response.status} ${response.statusText}`);
      }
      const arrayBuf = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
    } catch (err) {
      return serverError(res, `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const meta = await saveFile({
      id: crypto.randomUUID(),
      filename,
      buffer,
      customPath,
      open,
    }, context);
    json(res, meta, 201);
  } catch (err) {
    serverError(res, err instanceof Error ? err.message : "Upload failed");
  }
}

// ── Transfer types ──────────────────────────────────────────────

interface TransferSpec {
  file: string;       // absolute local path OR file ID from /api/files
  remotePath?: string; // destination path on remote (defaults to same relative path)
}

interface TransferRequest {
  destination: string; // remote gateway URL or remote name from config
  files: TransferSpec[];
}

interface TransferResult {
  file: string;
  remotePath: string | null;
  status: "ok" | "error";
  remoteId?: string;
  error?: string;
}

const MAX_TRANSFER_SIZE = 50 * 1024 * 1024; // 50 MB

/** Resolve a file spec to { buffer, filename, relativePath }. */
function resolveFileSpec(spec: TransferSpec): { buffer: Buffer; filename: string; relativePath: string | null } {
  const expanded = expandPath(spec.file);

  // Try as absolute/home path first
  if (fs.existsSync(expanded)) {
    const stat = fs.statSync(expanded);
    if (stat.size > MAX_TRANSFER_SIZE) {
      throw new Error(`File ${spec.file} is ${(stat.size / 1024 / 1024).toFixed(1)} MB — exceeds 50 MB transfer limit`);
    }
    const buffer = fs.readFileSync(expanded);
    const filename = path.basename(expanded);
    // Compute relative path from ~/.jinn/ for default remotePath
    const jinnHome = path.join(os.homedir(), ".jinn");
    const relativePath = expanded.startsWith(jinnHome)
      ? path.relative(jinnHome, expanded)
      : null;
    return { buffer, filename, relativePath };
  }

  // Try as file ID from managed storage
  const meta = getFile(spec.file);
  if (meta) {
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Managed file ${spec.file} exists in DB but not on disk`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_TRANSFER_SIZE) {
      throw new Error(`File ${spec.file} is ${(stat.size / 1024 / 1024).toFixed(1)} MB — exceeds 50 MB transfer limit`);
    }
    return {
      buffer: fs.readFileSync(filePath),
      filename: meta.filename,
      relativePath: meta.path || null,
    };
  }

  throw new Error(`File not found: ${spec.file}`);
}

/** Resolve destination URL — accept raw URL or remote name from config. Whitelist is enforced after resolution. */
function resolveDestination(destination: string, config: { remotes?: Record<string, { url: string }> }): string {
  // If it looks like a URL, use directly
  if (destination.startsWith("http://") || destination.startsWith("https://")) {
    return destination.replace(/\/+$/, "");
  }
  // Look up in config remotes
  const remote = config.remotes?.[destination];
  if (!remote) {
    throw new Error(`Unknown remote "${destination}". Add it to config.yaml remotes or use a full URL.`);
  }
  return remote.url.replace(/\/+$/, "");
}

/** Check if a destination URL is whitelisted in config remotes. */
function isAllowedRemote(destUrl: string, config: { remotes?: Record<string, { url: string }> }): boolean {
  if (!config.remotes) return false;
  const normalized = destUrl.replace(/\/+$/, "");
  return Object.values(config.remotes).some(r => r.url.replace(/\/+$/, "") === normalized);
}

/** POST /api/files/transfer — send files to a remote gateway. */
async function handleTransfer(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return badRequest(res, "Invalid JSON body");
  }

  const destination = body.destination as string | undefined;
  if (!destination) return badRequest(res, "destination is required");

  // Normalize: accept single file spec or array
  let fileSpecs: TransferSpec[];
  if (body.files && Array.isArray(body.files)) {
    fileSpecs = body.files as TransferSpec[];
  } else if (body.file) {
    fileSpecs = [{
      file: body.file as string,
      remotePath: body.remotePath as string | undefined,
    }];
  } else {
    return badRequest(res, "file or files is required");
  }

  if (fileSpecs.length === 0) return badRequest(res, "files array is empty");

  // Resolve and validate destination
  const config = context.getConfig();
  let destUrl: string;
  try {
    destUrl = resolveDestination(destination, config);
  } catch (err) {
    return badRequest(res, err instanceof Error ? err.message : String(err));
  }

  if (!isAllowedRemote(destUrl, config)) {
    return json(res, { error: `Remote "${destUrl}" is not in config.yaml remotes whitelist` }, 403);
  }

  // Transfer each file
  const results: TransferResult[] = [];
  for (const spec of fileSpecs) {
    try {
      const { buffer, filename, relativePath } = resolveFileSpec(spec);
      const targetPath = spec.remotePath || (relativePath ? `~/.jinn/${relativePath}` : null);

      const uploadBody = {
        filename,
        content: buffer.toString("base64"),
        path: targetPath,
      };

      const response = await fetch(`${destUrl}/api/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(uploadBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        results.push({ file: spec.file, remotePath: targetPath, status: "error", error: `HTTP ${response.status}: ${errText}` });
      } else {
        const remoteMeta = await response.json() as { id: string };
        results.push({ file: spec.file, remotePath: targetPath, status: "ok", remoteId: remoteMeta.id });
      }
    } catch (err) {
      results.push({ file: spec.file, remotePath: spec.remotePath || null, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const ok = results.filter(r => r.status === "ok").length;
  const failed = results.filter(r => r.status === "error").length;
  context.emit("file:transferred", { destination: destUrl, ok, failed });
  logger.info(`File transfer to ${destUrl}: ${ok} ok, ${failed} failed`);

  json(res, { destination: destUrl, results, summary: { ok, failed, total: results.length } });
}

/** Route handler for all /api/files endpoints. Returns true if handled. */
export async function handleFilesRequest(
  req: HttpRequest,
  res: ServerResponse,
  pathname: string,
  method: string,
  context: ApiContext,
): Promise<boolean> {
  // POST /api/files/transfer — send files to remote gateway
  if (method === "POST" && pathname === "/api/files/transfer") {
    await handleTransfer(req, res, context);
    return true;
  }

  // POST /api/files — upload
  if (method === "POST" && pathname === "/api/files") {
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
      await handleMultipartUpload(req, res, context);
    } else {
      await handleJsonUpload(req, res, context);
    }
    return true;
  }

  // GET /api/files — list all
  if (method === "GET" && pathname === "/api/files") {
    json(res, listFiles());
    return true;
  }

  // GET /api/files/:id/meta — file metadata
  const metaMatch = pathname.match(/^\/api\/files\/([^/]+)\/meta$/);
  if (method === "GET" && metaMatch) {
    const meta = getFile(metaMatch[1]);
    if (!meta) { notFound(res); return true; }
    json(res, meta);
    return true;
  }

  // GET /api/files/:id — download file
  const dlMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (method === "GET" && dlMatch) {
    const meta = getFile(dlMatch[1]);
    if (!meta) { notFound(res); return true; }
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (!fs.existsSync(filePath)) {
      notFound(res);
      return true;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      "Content-Type": meta.mimetype || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${meta.filename}"`,
      "Content-Length": stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // DELETE /api/files/:id
  const delMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (method === "DELETE" && delMatch) {
    const id = delMatch[1];
    const meta = getFile(id);
    if (!meta) { notFound(res); return true; }

    // Remove managed storage directory
    const fileDir = path.join(FILES_DIR, id);
    if (fs.existsSync(fileDir)) {
      fs.rmSync(fileDir, { recursive: true, force: true });
    }

    deleteFile(id);
    context.emit("file:deleted", { id, filename: meta.filename });
    logger.info(`File deleted: ${meta.filename} (${id})`);
    json(res, { status: "deleted" });
    return true;
  }

  return false;
}

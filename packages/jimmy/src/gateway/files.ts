import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Busboy from "busboy";
import { FILES_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { safeAttachmentName } from "../shared/safe-file-name.js";
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
  /** Already through {@link safeAttachmentName}: one path segment, never `..`. */
  filename: string;
  buffer: Buffer;
  open: boolean;
}

/**
 * What POST /api/files answers to a `path`. The route used to write a second
 * copy of the upload to any path the request named — anywhere the gateway can
 * write, config.yaml included. Nothing shipped ever sent one (the chat page
 * uploads the file and nothing else), so the option is gone rather than
 * fenced in; refusing it out loud beats storing the file and silently not
 * writing the copy the caller asked for.
 */
const PATH_RETIRED = "`path` is no longer supported: an upload is kept in the gateway's own storage and read back with GET /api/files/:id";
/** Likewise for `url`: the gateway fetched whatever URL it was given — the
 *  cloud metadata address, its own API — and served the answer back. */
const URL_RETIRED = "`url` is no longer supported: send the file's contents (multipart, or base64 in `content`)";
const BAD_FILENAME = "filename is required and must name a file";

/** Save buffer to managed storage: files/<id>/<filename>, and nowhere else. */
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
    path: null,
  });

  // Open file if requested
  if (result.open) {
    const { spawn } = await import("node:child_process");
    spawn("open", [storagePath], { stdio: "ignore", detached: true }).unref();
  }

  context.emit("file:uploaded", { id: result.id, filename: result.filename, size: result.buffer.length });
  logger.info(`File uploaded: ${result.filename} (${result.id}, ${result.buffer.length} bytes)`);

  return meta;
}

/** Handle POST /api/files — multipart upload */
async function handleMultipartUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  return new Promise((resolve) => {
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE } });
    let filename = "";
    let fileBuffer: Buffer | null = null;
    let pathGiven = false;
    let open = false;
    let fileTruncated = false;

    busboy.on("file", (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
      filename = info.filename;
      const chunks: Buffer[] = [];
      file.on("data", (chunk: Buffer) => chunks.push(chunk));
      (file as NodeJS.EventEmitter).on("limit", () => { fileTruncated = true; });
      file.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });

    busboy.on("field", (name: string, val: string) => {
      if (name === "path" && val) pathGiven = true;
      if (name === "open") open = val === "true" || val === "1";
    });

    busboy.on("finish", async () => {
      if (fileTruncated) {
        badRequest(res, `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`);
        resolve();
        return;
      }
      if (!fileBuffer || !filename) {
        badRequest(res, "No file provided");
        resolve();
        return;
      }
      const safeName = safeAttachmentName(filename);
      if (pathGiven || safeName === null) {
        badRequest(res, pathGiven ? PATH_RETIRED : BAD_FILENAME);
        resolve();
        return;
      }
      try {
        const meta = await saveFile({
          id: crypto.randomUUID(),
          filename: safeName,
          buffer: fileBuffer,
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

/** Handle POST /api/files — JSON body (base64 content) */
async function handleJsonUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return badRequest(res, "Invalid JSON body");
  }

  if (!body || typeof body !== "object") return badRequest(res, "Invalid JSON body");
  if (body.path) return badRequest(res, PATH_RETIRED);
  if (body.url) return badRequest(res, URL_RETIRED);

  const filename = safeAttachmentName(body.filename);
  const content = body.content;
  const open = !!body.open;

  if (filename === null) return badRequest(res, BAD_FILENAME);
  if (typeof content !== "string" || !content) return badRequest(res, "content is required");

  // Base64 decode
  let buffer: Buffer;
  try {
    buffer = Buffer.from(content, "base64");
  } catch {
    return badRequest(res, "Invalid base64 content");
  }

  try {
    const meta = await saveFile({
      id: crypto.randomUUID(),
      filename,
      buffer,
      open,
    }, context);
    json(res, meta, 201);
  } catch (err) {
    serverError(res, err instanceof Error ? err.message : "Upload failed");
  }
}

/** Route handler for all /api/files endpoints. Returns true if handled. */
export async function handleFilesRequest(
  req: HttpRequest,
  res: ServerResponse,
  pathname: string,
  method: string,
  context: ApiContext,
): Promise<boolean> {
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
    // A record written before file names were checked may point out of its
    // directory; only what lies directly inside files/<id>/ is an upload.
    const fileDir = path.join(FILES_DIR, meta.id);
    const filePath = path.join(fileDir, meta.filename);
    if (path.dirname(filePath) !== fileDir || !fs.existsSync(filePath)) {
      notFound(res);
      return true;
    }
    const stat = fs.statSync(filePath);
    // Sanitize filename to prevent Content-Disposition header injection.
    // Strip anything that isn't alphanumeric, dash, underscore, period, or space,
    // then use the RFC 5987 filename* parameter with percent-encoding.
    const sanitizedFilename = meta.filename.replace(/[^\w.\- ]/g, "_");
    res.writeHead(200, {
      "Content-Type": meta.mimetype || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
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

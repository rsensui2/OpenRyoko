import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApiRequest, type ApiContext } from "../../gateway/api.js";
import { loadConfig } from "../config.js";
import { CONFIG_PATH } from "../paths.js";

/* loadConfig() is how every part of the gateway reads config.yaml, and what it
 * throws for a file that will not parse is logged, printed, and sent back in
 * API responses by whoever called it. js-yaml's own error quotes the lines
 * around the mistake — in the file that holds the bot tokens. So the error
 * that leaves loadConfig() says where the mistake is and nothing else, and
 * carries nothing a caller could print by accident. */

const BROKEN = "connectors:\n  slack:\n    botToken: xoxb-SECRET-TOKEN\n   appToken: xapp-SECRET-TOKEN\n";

function thrownBy(act: () => unknown): Error {
  try {
    act();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected loadConfig() to throw");
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
});

afterEach(() => {
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("loadConfig", () => {
  it("returns the parsed config", () => {
    fs.writeFileSync(CONFIG_PATH, "engines:\n  default: claude\n");
    expect(loadConfig()).toEqual({ engines: { default: "claude" } });
  });

  it("says where a file that will not parse goes wrong, and quotes none of it", () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);

    const failure = thrownBy(loadConfig);

    expect(failure.message).toMatch(/^config\.yaml is not valid YAML \(line \d+, column \d+\)$/);
    expect(failure.message).not.toContain("SECRET");
  });

  it("carries the file's text nowhere else either: not in a cause, a mark, a stack or anything a logger might print", () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);

    const failure = thrownBy(loadConfig);

    expect(inspect(failure, { depth: 10, showHidden: true })).not.toContain("SECRET");
    expect(String(failure.stack)).not.toContain("SECRET");
    expect(JSON.stringify({ ...failure, message: failure.message })).not.toContain("SECRET");
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it("leaves out js-yaml's reason as well, which can name something taken from the file", () => {
    fs.writeFileSync(CONFIG_PATH, "portal:\n  password: *hunter2-SECRET\n");
    expect(inspect(thrownBy(loadConfig), { depth: 10 })).not.toContain("hunter2");
  });

  it("still says the file is missing when it is", () => {
    expect(thrownBy(loadConfig).message).toContain("Ryoko config not found");
  });
});

describe("an API route that reloads the config", () => {
  async function post(pathname: string) {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.headers = { host: "127.0.0.1", "content-type": "application/json" };
    req.method = "POST";
    req.url = pathname;
    let status = 0;
    const chunks: string[] = [];
    const res = {
      writeHead(code: number) { status = code; return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
    } as unknown as ServerResponse;
    const context = {
      getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "claude" } }),
      connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
      // What the gateway's own reload does first: read the file.
      reloadAllConnectors: async () => {
        loadConfig();
        return { started: [], stopped: [], errors: [] };
      },
    } as unknown as ApiContext;
    await handleApiRequest(req, res, context);
    return { status, text: chunks.join("") };
  }

  it("does not send the broken line back: POST /api/connectors/reload answers with the position only", async () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);

    const answer = await post("/api/connectors/reload");

    expect(answer.status).toBe(500);
    expect(answer.text).not.toContain("SECRET");
    expect(JSON.parse(answer.text).error).toMatch(/^config\.yaml is not valid YAML \(line \d+, column \d+\)$/);
  });
});

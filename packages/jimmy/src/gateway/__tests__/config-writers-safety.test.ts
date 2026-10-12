import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";

const downloadModel = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../stt/stt.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../stt/stt.js")>()), downloadModel }));

import { CONFIG_PATH } from "../../shared/paths.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* PUT /api/config is not the only API route that writes config.yaml. The
 * voice-input settings and the onboarding portal block write it too, each in
 * its own way. The properties under test are the same for all of them: a
 * config.yaml that cannot be read is never written over, a write that fails
 * leaves the previous file whole, and nothing of the file leaks into an error. */

function fakeRequest(method: string, pathname: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  readable.headers = { host: "127.0.0.1", "content-type": "application/json" };
  readable.method = method;
  readable.url = pathname;
  return readable;
}

/** What the gateway holds in memory; the watcher refreshes it about a second after the file changes. */
let inMemory: Record<string, unknown>;

async function call(method: string, pathname: string, body?: unknown) {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  const context = {
    getConfig: () => inMemory, connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(fakeRequest(method, pathname, body), res, context);
  const text = chunks.join("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, text, body: (text ? JSON.parse(text) : null) as any };
}

const CONFIG = [
  "# my instance",
  "engines:",
  "  default: claude   # the usual",
  "connectors:",
  "  slack:",
  "    botToken: xoxb-STORED-SECRET",
  "",
  "portal:",
  "  portalName: Ryoko",
  "  operatorSlackId: U0OPERATOR",
  "",
  "stt:",
  "  enabled: true",
  "  language: en",
  "  languages:",
  "    - en",
  "",
].join("\n");

/** A half-finished hand edit: the line after the token is indented wrongly. */
const BROKEN = "connectors:\n  slack:\n    botToken: xoxb-STORED-SECRET\n   appToken: xapp-STORED-SECRET\n";

const onDisk = () => fs.readFileSync(CONFIG_PATH, "utf-8");
const parsed = () => yaml.load(onDisk()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const homeFiles = () => fs.readdirSync(path.dirname(CONFIG_PATH)).sort();

/** The disk fills up after the new contents were staged, before they could replace config.yaml. */
function failTheSwap() {
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  });
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, CONFIG);
  inMemory = { gateway: {}, connectors: {}, engines: { default: "claude" }, portal: { portalName: "Ryoko", operatorSlackId: "U0OPERATOR" }, stt: { model: "small" } };
  downloadModel.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(CONFIG_PATH, { force: true });
});

describe("PUT /api/stt/config", () => {
  it("saves the languages and drops the deprecated single-language key, as before", async () => {
    const answer = await call("PUT", "/api/stt/config", { languages: ["en", "ja"] });
    expect(answer).toMatchObject({ status: 200, body: { status: "ok", languages: ["en", "ja"] } });
    expect(parsed().stt).toEqual({ enabled: true, languages: ["en", "ja"] });
    expect(parsed().connectors.slack.botToken).toBe("xoxb-STORED-SECRET");
  });

  it("refuses a config.yaml it cannot read, without quoting the file in the error", async () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);
    const answer = await call("PUT", "/api/stt/config", { languages: ["en", "ja"] });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(answer.text).not.toContain("STORED-SECRET"); // js-yaml's message carries the lines around the error
    expect(answer.text).toContain("config.yaml");
    expect(onDisk()).toBe(BROKEN);
  });

  it("refuses a config.yaml whose top level is not a mapping instead of reporting a save that changed nothing", async () => {
    fs.writeFileSync(CONFIG_PATH, "- a\n- list\n");
    const answer = await call("PUT", "/api/stt/config", { languages: ["en", "ja"] });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(onDisk()).toBe("- a\n- list\n");
  });

  it("leaves the previous file whole when the write fails part-way", async () => {
    failTheSwap();
    const answer = await call("PUT", "/api/stt/config", { languages: ["en", "ja"] });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(onDisk()).toBe(CONFIG);
    expect(homeFiles()).toContain("config.yaml");
    expect(homeFiles().filter((name) => name.includes("config.yaml"))).toEqual(["config.yaml"]);
  });

  it("still fails when there is no config.yaml to add the setting to", async () => {
    fs.rmSync(CONFIG_PATH);
    const answer = await call("PUT", "/api/stt/config", { languages: ["en"] });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(fs.existsSync(CONFIG_PATH)).toBe(false);
  });
});

describe("POST /api/stt/download, once the model has arrived", () => {
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("turns voice input on and records the model, as before", async () => {
    const answer = await call("POST", "/api/stt/download");
    expect(answer).toMatchObject({ status: 200, body: { status: "downloading", model: "small" } });
    await settled();
    expect(parsed().stt).toEqual({ enabled: true, language: "en", languages: ["en"], model: "small" });
    expect(parsed().portal.portalName).toBe("Ryoko");
  });

  it("leaves the previous file whole when the write fails part-way", async () => {
    failTheSwap();
    await call("POST", "/api/stt/download");
    await settled();
    expect(onDisk()).toBe(CONFIG);
    expect(homeFiles().filter((name) => name.includes("config.yaml"))).toEqual(["config.yaml"]);
  });

  it("does not touch a config.yaml it cannot read", async () => {
    fs.writeFileSync(CONFIG_PATH, "- a\n- list\n");
    await call("POST", "/api/stt/download");
    await settled();
    expect(onDisk()).toBe("- a\n- list\n");
  });
});

describe("POST /api/onboarding", () => {
  it("rewrites the portal block and leaves every line outside it alone, as before", async () => {
    const answer = await call("POST", "/api/onboarding", { portalName: "Momo" });
    expect(answer.status).toBe(200);
    expect(parsed().portal).toEqual({ portalName: "Momo", operatorSlackId: "U0OPERATOR", onboarded: true });
    expect(onDisk().startsWith("# my instance\nengines:\n  default: claude   # the usual\nconnectors:\n  slack:\n    botToken: xoxb-STORED-SECRET\n")).toBe(true);
    expect(onDisk().endsWith("stt:\n  enabled: true\n  language: en\n  languages:\n    - en\n")).toBe(true);
  });

  it("refuses a config.yaml it cannot read instead of patching a broken file", async () => {
    fs.writeFileSync(CONFIG_PATH, BROKEN);
    const answer = await call("POST", "/api/onboarding", { portalName: "Momo" });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(answer.text).not.toContain("STORED-SECRET");
    expect(onDisk()).toBe(BROKEN);
  });

  it.skipIf(!POSIX_MODES_SUPPORTED)("keeps config.yaml private when it was private (it holds tokens)", async () => {
    fs.chmodSync(CONFIG_PATH, 0o600);
    await call("POST", "/api/onboarding", { portalName: "Momo" });
    expectPosixMode(CONFIG_PATH, 0o600);
  });

  it("starts from the portal block on disk, so two quick edits do not undo each other", async () => {
    // Portal name, then operator name, each saved on blur. The second request
    // arrives before the watcher has refreshed the in-memory config.
    expect((await call("POST", "/api/onboarding", { portalName: "Momo" })).status).toBe(200);
    expect((await call("POST", "/api/onboarding", { operatorName: "Aiko" })).status).toBe(200);
    expect(parsed().portal).toEqual({ portalName: "Momo", operatorSlackId: "U0OPERATOR", onboarded: true, operatorName: "Aiko" });
  });

  it("leaves the previous file whole, and nothing staged behind, when the write fails part-way", async () => {
    failTheSwap();
    const answer = await call("POST", "/api/onboarding", { portalName: "Momo" });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(onDisk()).toBe(CONFIG);
    expect(homeFiles().filter((name) => name.includes("config.yaml"))).toEqual(["config.yaml"]);
  });

  /* The portal block used to be swapped in as text by a routine that knows
   * one spelling of it. Any other spelling got a second `portal:` appended —
   * a duplicate key, which js-yaml refuses: from then on every save was
   * rejected and the gateway could not restart. */
  it.each([
    ["a quoted key", '"portal":\n  portalName: Ryoko\n  operatorSlackId: U0OPERATOR\n'],
    ["a single-quoted key", "'portal':\n  portalName: Ryoko\n  operatorSlackId: U0OPERATOR\n"],
    ["a flow mapping over several lines", "portal: {\n  portalName: Ryoko,\n  operatorSlackId: U0OPERATOR\n}\n"],
    ["an anchor on the block", "portal: &p\n  portalName: Ryoko\n  operatorSlackId: U0OPERATOR\n"],
    ["a tag on the block", "portal: !!map\n  portalName: Ryoko\n  operatorSlackId: U0OPERATOR\n"],
    ["a comment after the key that is not a plain one", "portal:   #   who we are: Ryoko\n  portalName: Ryoko\n  operatorSlackId: U0OPERATOR\n"],
    ["an indented document", "  portal:\n    portalName: Ryoko\n    operatorSlackId: U0OPERATOR\n  engines:\n    default: claude\n"],
    ["CRLF line endings", "engines:\r\n  default: claude\r\nportal:\r\n  portalName: Ryoko\r\n  operatorSlackId: U0OPERATOR\r\n"],
  ])("leaves a readable config.yaml with one portal block when it is written with %s", async (_form, portalBlock) => {
    const config = portalBlock.includes("engines:") ? portalBlock : `engines:\n  default: claude\n${portalBlock}logging:\n  level: info\n`;
    fs.writeFileSync(CONFIG_PATH, config);

    const answer = await call("POST", "/api/onboarding", { portalName: "Momo" });

    expect(answer.status).toBe(200);
    expect(() => yaml.load(onDisk())).not.toThrow();
    expect(parsed().portal).toEqual({ portalName: "Momo", operatorSlackId: "U0OPERATOR", onboarded: true });
    expect(parsed().engines).toEqual({ default: "claude" });
    // And the next save still works: the file was not left in a state every writer refuses.
    expect((await call("POST", "/api/onboarding", { operatorName: "Aiko" })).status).toBe(200);
    expect(parsed().portal.operatorName).toBe("Aiko");
  });

  it("writes what was asked even when a value needs quoting or spans lines", async () => {
    const name = 'Ry"oko: the #1\nassistant';
    expect((await call("POST", "/api/onboarding", { portalName: name })).status).toBe(200);
    expect(parsed().portal.portalName).toBe(name);
    expect(parsed().stt).toEqual({ enabled: true, language: "en", languages: ["en"] });
  });

  it("still creates config.yaml with the portal block when there is none, private to its owner", async () => {
    fs.rmSync(CONFIG_PATH);
    const answer = await call("POST", "/api/onboarding", { portalName: "Momo" });
    expect(answer.status).toBe(200);
    expect(parsed()).toEqual({ portal: { portalName: "Momo", operatorSlackId: "U0OPERATOR", onboarded: true } });
    expectPosixMode(CONFIG_PATH, 0o600);
  });
});

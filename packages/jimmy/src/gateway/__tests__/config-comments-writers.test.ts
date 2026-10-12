import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadModel = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../stt/stt.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../stt/stt.js")>()), downloadModel }));

import { applyConfigPatches, stampVersion } from "../../cli/migrate.js";
import type { DiscoveredModel, ManagedEngine } from "../../models/discovery.js";
import { ModelManagement } from "../../models/service.js";
import { invalidateModelRegistry, setDiscoveredModels } from "../../shared/models.js";
import { CONFIG_PATH, CRON_JOBS, JINN_HOME, MIGRATIONS_DIR, ORG_DIR } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* The comment-preserving save reaches every writer of config.yaml, not only
 * PUT /api/config: the voice settings, model management (every model switch
 * from Slack) and `ryoko migrate` (every update) used to dump the whole file
 * and take the comments with them. These tests depend on that save; they
 * belong with it, and go if it goes. */

const CONFIG = [
  "# my instance — notes to self live in this file",
  "jinn:",
  '  version: "2026.9.1"',
  "",
  "engines:",
  "  default: codex",
  "  claude:",
  "    bin: claude",
  "    model: claude-opus-5   # pinned on purpose, see the March incident",
  "  codex:",
  "    bin: codex",
  "    # the family Slack follows; do not hand-edit while 'auto' is on",
  "    model: gpt-5.6-sol",
  "    effortLevel: high      # was medium until the batch jobs",
  "",
  "connectors:",
  "  slack:",
  "    botToken: xoxb-STORED   # production workspace",
  "",
  "# Voice input",
  "stt:",
  "  enabled: true",
  "  languages:",
  "    - en   # default",
  "",
  "logging:",
  "  level: info",
  "",
].join("\n");

const onDisk = () => fs.readFileSync(CONFIG_PATH, "utf-8");
const parsed = () => yaml.load(onDisk()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const comments = (text: string) => text.split("\n").flatMap((line) => (line.includes("#") ? [line.slice(line.indexOf("#"))] : []));

/** Lines only `before` has, and lines only `after` has (longest common subsequence). */
function changedLines(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else if (common[i + 1][j] >= common[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  return { removed: [...removed, ...a.slice(i)], added: [...added, ...b.slice(j)] };
}

async function call(method: string, pathname: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  req.method = method;
  req.url = pathname;
  let status = 0;
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end() {},
  } as unknown as ServerResponse;
  const context = {
    getConfig: () => ({ gateway: {}, connectors: {}, engines: { default: "codex" }, stt: { model: "small" } }),
    connectors: new Map(), sessionManager: {}, emit: () => {}, startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(req, res, context);
  return status;
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, CONFIG);
  downloadModel.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
});

describe("voice settings", () => {
  it("PUT /api/stt/config adds a language as one line", async () => {
    expect(await call("PUT", "/api/stt/config", { languages: ["en", "ja"] })).toBe(200);
    expect(changedLines(CONFIG, onDisk())).toEqual({ removed: [], added: ["    - ja"] });
    expect(parsed().stt.languages).toEqual(["en", "ja"]);
  });

  it("the end of a model download records the model as one line", async () => {
    expect(await call("POST", "/api/stt/download")).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changedLines(CONFIG, onDisk())).toEqual({ removed: [], added: ["  model: small"] });
  });
});

describe("model management", () => {
  const sol = (id: string): DiscoveredModel => ({ id, label: id, supportsEffort: true, effortLevels: ["low", "medium", "high"], defaultEffort: "medium" });

  it("switches the model on its own line and keeps every note in the file", async () => {
    fs.rmSync(path.join(JINN_HOME, "models"), { force: true, recursive: true });
    fs.rmSync(ORG_DIR, { force: true, recursive: true });
    fs.mkdirSync(ORG_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(CRON_JOBS), { recursive: true });
    fs.writeFileSync(CRON_JOBS, "[]");
    invalidateModelRegistry();
    setDiscoveredModels("codex", []);
    setDiscoveredModels("claude", []);
    let running = yaml.load(CONFIG) as JinnConfig;
    const service = new ModelManagement({
      getConfig: () => running, onConfig: (next) => { running = next; },
      discover: async (engine: ManagedEngine) => (engine === "codex" ? [sol("gpt-6-sol")] : []), notify: async () => true,
    });

    await service.act({ action: "policy", engine: "codex", policy: { mode: "auto", profile: "balanced" } });

    expect(parsed().engines.codex.model).toBe("gpt-6-sol");
    expect(comments(onDisk())).toEqual(comments(CONFIG));
    expect(onDisk()).toContain("    model: gpt-6-sol\n");
    const { removed } = changedLines(CONFIG, onDisk());
    expect(removed).toEqual(["    model: gpt-5.6-sol", "    effortLevel: high      # was medium until the batch jobs"]);
    expect(onDisk()).toContain("    effortLevel: medium      # was medium until the batch jobs\n");
  });
});

describe("ryoko migrate", () => {
  it("stamps the version on its own line, quotes and all", () => {
    stampVersion("2026.10.9");
    expect(changedLines(CONFIG, onDisk())).toEqual({ removed: ['  version: "2026.9.1"'], added: ['  version: "2026.10.9"'] });
  });

  it("applies a shipped config patch to the keys it names", () => {
    fs.mkdirSync(path.join(MIGRATIONS_DIR, "2026.10.9"), { recursive: true });
    fs.writeFileSync(path.join(MIGRATIONS_DIR, "2026.10.9", "config-patch.json"), JSON.stringify([
      { path: "engines.claude.model", from: "claude-opus-5", to: "claude-opus-5-5" },
      { path: "engines.claude.autoMemory", to: false },
    ]));

    expect(applyConfigPatches(["2026.10.9"])).toBe(2);

    expect(changedLines(CONFIG, onDisk())).toEqual({
      removed: ["    model: claude-opus-5   # pinned on purpose, see the March incident"],
      added: ["    model: claude-opus-5-5   # pinned on purpose, see the March incident", "    autoMemory: false"],
    });
  });
});

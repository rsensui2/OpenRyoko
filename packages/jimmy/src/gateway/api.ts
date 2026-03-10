import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { CronJob, Engine, JinnConfig, Session } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildContext } from "../sessions/context.js";
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  insertMessage,
  getMessages,
} from "../sessions/registry.js";
import {
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  ORG_DIR,
  SKILLS_DIR,
  LOGS_DIR,
} from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { loadJobs, saveJobs } from "../cron/jobs.js";
import { reloadScheduler } from "../cron/scheduler.js";

export interface ApiContext {
  config: JinnConfig;
  sessionManager: SessionManager;
  startTime: number;
  getConfig: () => JinnConfig;
  emit: (event: string, payload: unknown) => void;
  connectors: Map<string, import("../shared/types.js").Connector>;
}

function dispatchWebSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  opts?: { delayMs?: number },
): void {
  const run = async () => {
    await context.sessionManager.getQueue().enqueue(session.sessionKey || session.sourceRef, async () => {
      context.emit("session:started", { sessionId: session.id });
      await runWebSession(session, prompt, engine, config, context);
    });
  };

  const launch = () => {
    run().catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Web session ${session.id} dispatch error: ${errMsg}`);
      updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      context.emit("session:completed", {
        sessionId: session.id,
        result: null,
        error: errMsg,
      });
    });
  };

  if (opts?.delayMs && opts.delayMs > 0) {
    setTimeout(launch, opts.delayMs);
  } else {
    launch();
  }
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function serializeSession(session: Session, context: ApiContext): Session {
  const queue = context.sessionManager.getQueue();
  const queueDepth = queue.getPendingCount(session.sessionKey || session.sourceRef);
  const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  return {
    ...session,
    queueDepth,
    transportState,
  };
}

export async function handleApiRequest(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  try {
    // GET /api/status
    if (method === "GET" && pathname === "/api/status") {
      const config = context.getConfig();
      const sessions = listSessions();
      const running = sessions.filter((s) => s.status === "running").length;
      const connectors = Object.fromEntries(
        Array.from(context.connectors.values()).map((connector) => [connector.name, connector.getHealth()]),
      );
      return json(res, {
        status: "ok",
        uptime: Math.floor((Date.now() - context.startTime) / 1000),
        port: config.gateway.port || 7777,
        engines: {
          default: config.engines.default,
          claude: { model: config.engines.claude.model, available: true },
          codex: { model: config.engines.codex.model, available: true },
        },
        sessions: { total: sessions.length, running, active: running },
        connectors,
      });
    }

    // GET /api/sessions
    if (method === "GET" && pathname === "/api/sessions") {
      const sessions = listSessions();
      return json(res, sessions.map((session) => serializeSession(session, context)));
    }

    // GET /api/sessions/:id
    let params = matchRoute("/api/sessions/:id", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      let messages = getMessages(params.id);

      // Backfill from Claude Code's JSONL transcript if our DB has no messages
      if (messages.length === 0 && session.engineSessionId) {
        const transcriptMessages = loadTranscriptMessages(session.engineSessionId);
        if (transcriptMessages.length > 0) {
          for (const tm of transcriptMessages) {
            insertMessage(params.id, tm.role, tm.content);
          }
          messages = getMessages(params.id);
        }
      }

      return json(res, { ...serializeSession(session, context), messages });
    }

    // DELETE /api/sessions/:id
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);

      // Kill any live engine process for this session before deleting it.
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine) && engine.isAlive(params.id)) {
        logger.info(`Killing live engine process for deleted session ${params.id}`);
        engine.kill(params.id);
      }

      const deleted = deleteSession(params.id);
      if (!deleted) return notFound(res);
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      return json(res, { status: "deleted" });
    }

    // GET /api/sessions/:id/children
    params = matchRoute("/api/sessions/:id/children", pathname);
    if (method === "GET" && params) {
      const children = listSessions().filter((s) => s.parentSessionId === params!.id);
      return json(res, children.map((child) => serializeSession(child, context)));
    }

    // POST /api/sessions/stub — create a session with a pre-populated assistant
    // message but do NOT run the engine. Used for lazy onboarding.
    if (method === "POST" && pathname === "/api/sessions/stub") {
      const body = JSON.parse(await readBody(req));
      const greeting = body.greeting || "Hey! Say hi when you're ready to get started.";
      const config = context.getConfig();
      const engineName = body.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: body.employee,
        title: body.title,
        portalName: config.portal?.portalName,
      });
      insertMessage(session.id, "assistant", greeting);
      logger.info(`Stub session created: ${session.id}`);
      return json(res, serializeSession(session, context), 201);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const body = JSON.parse(await readBody(req));
      const prompt = body.prompt || body.message;
      if (!prompt) return badRequest(res, "prompt or message is required");
      const config = context.getConfig();
      const engineName = body.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: body.employee,
        parentSessionId: body.parentSessionId,
        prompt,
        portalName: config.portal?.portalName,
      });
      logger.info(`Web session created: ${session.id}`);
      insertMessage(session.id, "user", prompt);

      // Run engine asynchronously — respond immediately, push result via WebSocket
      const engine = context.sessionManager.getEngine(engineName);
      if (!engine) {
        updateSession(session.id, {
          status: "error",
          lastError: `Engine "${engineName}" not available`,
        });
        return json(res, { ...serializeSession({ ...session, status: "error", lastError: `Engine "${engineName}" not available` }, context) }, 201);
      }

      // Set status to "running" synchronously BEFORE returning the response.
      // This prevents a race condition where the caller polls immediately and
      // sees "idle" status before runWebSession has a chance to set "running".
      updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
      session.status = "running";

      dispatchWebSessionRun(session, prompt, engine, config, context);

      return json(res, serializeSession(session, context), 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const body = JSON.parse(await readBody(req));
      const prompt = body.message || body.prompt;
      if (!prompt) return badRequest(res, "message is required");

      const config = context.getConfig();
      const engine = context.sessionManager.getEngine(session.engine);
      if (!engine) return serverError(res, `Engine "${session.engine}" not available`);

      // Persist the user message immediately
      insertMessage(session.id, "user", prompt);

      // If a turn is already running, this follow-up will be queued and resume later.
      if (session.status === "running") {
        context.emit("session:queued", { sessionId: session.id, message: prompt });
      }

      dispatchWebSessionRun(session, prompt, engine, config, context);

      return json(res, { status: "queued", sessionId: session.id });
    }

    // GET /api/cron
    if (method === "GET" && pathname === "/api/cron") {
      const jobs = loadJobs();
      // Enrich with last run status
      const enriched = jobs.map((job) => {
        const runFile = path.join(CRON_RUNS, `${job.id}.jsonl`);
        let lastRun = null;
        if (fs.existsSync(runFile)) {
          const lines = fs.readFileSync(runFile, "utf-8").trim().split("\n").filter(Boolean);
          if (lines.length > 0) {
            try { lastRun = JSON.parse(lines[lines.length - 1]); } catch {}
          }
        }
        return { ...job, lastRun };
      });
      return json(res, enriched);
    }

    // GET /api/cron/:id/runs
    params = matchRoute("/api/cron/:id/runs", pathname);
    if (method === "GET" && params) {
      const runFile = path.join(CRON_RUNS, `${params.id}.jsonl`);
      if (!fs.existsSync(runFile)) return json(res, []);
      const lines = fs
        .readFileSync(runFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      return json(res, lines);
    }

    // POST /api/cron — create new cron job
    if (method === "POST" && pathname === "/api/cron") {
      const body = JSON.parse(await readBody(req));
      const jobs = loadJobs();
      const newJob: CronJob = {
        id: body.id || crypto.randomUUID(),
        name: body.name || "untitled",
        enabled: body.enabled ?? true,
        schedule: body.schedule || "0 * * * *",
        timezone: body.timezone,
        engine: body.engine,
        model: body.model,
        employee: body.employee,
        prompt: body.prompt || "",
        delivery: body.delivery,
      };
      jobs.push(newJob);
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, newJob, 201);
    }

    // PUT /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "PUT" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const body = JSON.parse(await readBody(req));
      jobs[idx] = { ...jobs[idx], ...body, id: params.id };
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, jobs[idx]);
    }

    // DELETE /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "DELETE" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const removed = jobs.splice(idx, 1)[0];
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, { deleted: removed.id, name: removed.name });
    }

    // GET /api/org
    if (method === "GET" && pathname === "/api/org") {
      if (!fs.existsSync(ORG_DIR)) return json(res, { departments: [], employees: [] });
      const entries = fs.readdirSync(ORG_DIR, { withFileTypes: true });
      const departments = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const employees: string[] = [];
      // Scan root-level YAML files
      for (const e of entries) {
        if (e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml"))) {
          employees.push(e.name.replace(/\.ya?ml$/, ""));
        }
      }
      // Scan employees/ subdirectory
      const employeesDir = path.join(ORG_DIR, "employees");
      if (fs.existsSync(employeesDir)) {
        const empEntries = fs.readdirSync(employeesDir, { withFileTypes: true });
        for (const e of empEntries) {
          if (e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml"))) {
            employees.push(e.name.replace(/\.ya?ml$/, ""));
          }
        }
      }
      // Scan inside each department directory for YAML files (excluding department.yaml)
      for (const dept of departments) {
        const deptDir = path.join(ORG_DIR, dept);
        const deptEntries = fs.readdirSync(deptDir, { withFileTypes: true });
        for (const e of deptEntries) {
          if (e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")) && e.name !== "department.yaml") {
            employees.push(e.name.replace(/\.ya?ml$/, ""));
          }
        }
      }
      return json(res, { departments, employees });
    }

    // GET /api/org/employees/:name
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "GET" && params) {
      const candidates = [
        path.join(ORG_DIR, "employees", `${params.name}.yaml`),
        path.join(ORG_DIR, "employees", `${params.name}.yml`),
        path.join(ORG_DIR, `${params.name}.yaml`),
        path.join(ORG_DIR, `${params.name}.yml`),
      ];
      // Also search inside each department directory
      if (fs.existsSync(ORG_DIR)) {
        const dirs = fs.readdirSync(ORG_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
        for (const dir of dirs) {
          candidates.push(path.join(ORG_DIR, dir.name, `${params.name}.yaml`));
          candidates.push(path.join(ORG_DIR, dir.name, `${params.name}.yml`));
        }
      }
      const filePath = candidates.find((c) => fs.existsSync(c));
      if (!filePath) return notFound(res);
      const content = yaml.load(fs.readFileSync(filePath, "utf-8"));
      return json(res, content);
    }

    // GET /api/org/departments/:name/board
    params = matchRoute("/api/org/departments/:name/board", pathname);
    if (method === "GET" && params) {
      const boardPath = path.join(ORG_DIR, params.name, "board.json");
      if (!fs.existsSync(boardPath)) return notFound(res);
      const board = JSON.parse(fs.readFileSync(boardPath, "utf-8"));
      return json(res, board);
    }

    // PUT /api/org/departments/:name/board
    if (method === "PUT" && matchRoute("/api/org/departments/:name/board", pathname)) {
      const p = matchRoute("/api/org/departments/:name/board", pathname)!;
      const boardPath = path.join(ORG_DIR, p.name, "board.json");
      const deptDir = path.join(ORG_DIR, p.name);
      if (!fs.existsSync(deptDir)) return notFound(res);
      const body = JSON.parse(await readBody(req));
      fs.writeFileSync(boardPath, JSON.stringify(body, null, 2));
      context.emit("board:updated", { department: p.name });
      return json(res, { status: "ok" });
    }

    // GET /api/skills/search?q=<query> — search the skills.sh registry
    if (method === "GET" && pathname === "/api/skills/search") {
      const query = url.searchParams.get("q") || "";
      if (!query) return badRequest(res, "q parameter is required");
      try {
        const { execSync } = await import("node:child_process");
        const output = execSync(`npx skills find ${JSON.stringify(query)}`, {
          encoding: "utf-8",
          timeout: 30000,
        });
        const results = parseSkillsSearchOutput(output);
        return json(res, results);
      } catch (err) {
        const msg = err instanceof Error ? (err as any).stderr || err.message : String(err);
        return json(res, { results: [], error: msg });
      }
    }

    // GET /api/skills/manifest — return skills.json contents
    if (method === "GET" && pathname === "/api/skills/manifest") {
      const { readManifest } = await import("../cli/skills.js");
      return json(res, readManifest());
    }

    // POST /api/skills/install — install a skill from skills.sh
    if (method === "POST" && pathname === "/api/skills/install") {
      const body = JSON.parse(await readBody(req));
      const source = body.source;
      if (!source) return badRequest(res, "source is required");
      try {
        const {
          snapshotDirs, diffSnapshots, copySkillToInstance,
          upsertManifest, extractSkillName, findExistingSkill,
        } = await import("../cli/skills.js");
        const { execSync } = await import("node:child_process");

        const before = snapshotDirs();
        execSync(`npx skills add ${JSON.stringify(source)} -g -y`, {
          encoding: "utf-8",
          timeout: 60000,
        });
        const after = snapshotDirs();
        const newDirs = diffSnapshots(before, after);

        let skillName: string;
        if (newDirs.length > 0) {
          const installed = newDirs[0];
          skillName = installed.name;
          copySkillToInstance(installed.name, path.join(installed.dir, installed.name));
        } else {
          skillName = extractSkillName(source);
          const existing = findExistingSkill(skillName);
          if (existing) {
            copySkillToInstance(existing.name, existing.dir);
          } else {
            return serverError(res, "Skill installed globally but could not locate the directory");
          }
        }
        upsertManifest(skillName, source);
        return json(res, { status: "installed", name: skillName });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, msg);
      }
    }

    // GET /api/skills
    if (method === "GET" && pathname === "/api/skills") {
      if (!fs.existsSync(SKILLS_DIR)) return json(res, []);
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
      const skills = entries.filter((e) => e.isDirectory()).map((e) => {
        const skillMdPath = path.join(SKILLS_DIR, e.name, "SKILL.md");
        let description = "";
        if (fs.existsSync(skillMdPath)) {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          // Extract description from YAML frontmatter, ## Trigger section, or first paragraph
          const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (frontmatterMatch) {
            const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
            if (descMatch) {
              description = descMatch[1].trim();
            }
          }
          if (!description) {
            const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
            if (triggerMatch) {
              description = triggerMatch[1].trim();
            } else {
              // Use first non-heading, non-empty, non-frontmatter line
              const bodyContent = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
              const lines = bodyContent.split("\n");
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("#")) {
                  description = trimmed;
                  break;
                }
              }
            }
          }
        }
        return { name: e.name, description };
      });
      return json(res, skills);
    }

    // GET /api/skills/:name
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "GET" && params) {
      const skillMd = path.join(SKILLS_DIR, params.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) return notFound(res);
      const content = fs.readFileSync(skillMd, "utf-8");
      return json(res, { name: params.name, content });
    }

    // DELETE /api/skills/:name — remove a skill
    if (method === "DELETE" && params) {
      const skillDir = path.join(SKILLS_DIR, params.name);
      if (!fs.existsSync(skillDir)) return notFound(res);
      fs.rmSync(skillDir, { recursive: true, force: true });
      const { removeFromManifest } = await import("../cli/skills.js");
      removeFromManifest(params.name);
      logger.info(`Skill removed via API: ${params.name}`);
      return json(res, { status: "removed", name: params.name });
    }

    // GET /api/config
    if (method === "GET" && pathname === "/api/config") {
      const config = context.getConfig();
      // Sanitize: remove any secrets/tokens from connectors
      const sanitized = {
        ...config,
        connectors: Object.fromEntries(
          Object.entries(config.connectors || {}).map(([k, v]) => [
            k,
            {
              ...v,
              token: v?.token ? "***" : undefined,
              signingSecret: v?.signingSecret ? "***" : undefined,
              botToken: v?.botToken ? "***" : undefined,
              appToken: v?.appToken ? "***" : undefined,
            },
          ]),
        ),
      };
      return json(res, sanitized);
    }

    // PUT /api/config
    if (method === "PUT" && pathname === "/api/config") {
      const body = JSON.parse(await readBody(req));
      const yamlStr = yaml.dump(body);
      fs.writeFileSync(CONFIG_PATH, yamlStr);
      logger.info("Config updated via API");
      return json(res, { status: "ok" });
    }

    // GET /api/logs
    if (method === "GET" && pathname === "/api/logs") {
      const logFile = path.join(LOGS_DIR, "gateway.log");
      if (!fs.existsSync(logFile)) return json(res, { lines: [] });
      const n = parseInt(url.searchParams.get("n") || "100", 10);
      const content = fs.readFileSync(logFile, "utf-8");
      const allLines = content.trim().split("\n");
      const lines = allLines.slice(-n);
      return json(res, { lines });
    }

    // POST /api/connectors/:name/send — send a message via a connector
    params = matchRoute("/api/connectors/:name/send", pathname);
    if (method === "POST" && params) {
      const connector = context.connectors.get(params.name);
      if (!connector) return notFound(res);
      const body = JSON.parse(await readBody(req));
      if (!body.channel || !body.text) return badRequest(res, "channel and text are required");
      await connector.sendMessage(
        { channel: body.channel, thread: body.thread },
        body.text,
      );
      return json(res, { status: "sent" });
    }

    // GET /api/connectors — list available connectors
    if (method === "GET" && pathname === "/api/connectors") {
      const connectors = Array.from(context.connectors.values()).map((connector) => ({
        name: connector.name,
        ...connector.getHealth(),
      }));
      return json(res, connectors);
    }

    // GET /api/activity — recent activity derived from sessions
    if (method === "GET" && pathname === "/api/activity") {
      const sessions = listSessions();
      const events: Array<{ event: string; payload: unknown; ts: number }> = [];
      for (const s of sessions) {
        const ts = new Date(s.lastActivity || s.createdAt).getTime();
        const transportState = context.sessionManager.getQueue().getTransportState(s.sessionKey || s.sourceRef, s.status);
        if (transportState === "running") {
          events.push({ event: "session:started", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "queued") {
          events.push({ event: "session:queued", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "idle") {
          events.push({ event: "session:completed", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "error") {
          events.push({ event: "session:error", payload: { sessionId: s.id, employee: s.employee, error: s.lastError, connector: s.connector }, ts });
        }
      }
      events.sort((a, b) => b.ts - a.ts);
      return json(res, events.slice(0, 30));
    }

    // GET /api/onboarding — check if onboarding is needed
    if (method === "GET" && pathname === "/api/onboarding") {
      const sessions = listSessions();
      const hasEmployees = fs.existsSync(ORG_DIR) &&
        fs.readdirSync(ORG_DIR, { recursive: true }).some(
          (f) => String(f).endsWith(".yaml") && !String(f).endsWith("department.yaml")
        );
      const config = context.getConfig();
      return json(res, {
        needed: sessions.length === 0 && !hasEmployees,
        sessionsCount: sessions.length,
        hasEmployees,
        portalName: config.portal?.portalName ?? null,
        operatorName: config.portal?.operatorName ?? null,
      });
    }

    // POST /api/onboarding — persist portal personalization
    if (method === "POST" && pathname === "/api/onboarding") {
      const body = JSON.parse(await readBody(req));
      const { portalName, operatorName, language } = body;

      // Read current config and merge portal settings
      const config = context.getConfig();
      const updated = {
        ...config,
        portal: {
          ...config.portal,
          ...(portalName !== undefined && { portalName: portalName || undefined }),
          ...(operatorName !== undefined && { operatorName: operatorName || undefined }),
          ...(language !== undefined && { language: language || undefined }),
        },
      };

      // Write updated config
      const yamlStr = yaml.dump(updated, { lineWidth: -1 });
      fs.writeFileSync(CONFIG_PATH, yamlStr);
      logger.info(`Onboarding: portal name="${portalName}", operator="${operatorName}", language="${language}"`);

      const effectiveName = portalName || "Jinn";
      const languageSection = language && language !== "English"
        ? `\n\n## Language\nAlways respond in ${language}. All communication with the user must be in ${language}.`
        : "";

      // Update CLAUDE.md with personalized COO name and language
      const claudeMdPath = path.join(JINN_HOME, "CLAUDE.md");
      if (fs.existsSync(claudeMdPath)) {
        let claudeMd = fs.readFileSync(claudeMdPath, "utf-8");
        // Replace the identity line in CLAUDE.md
        claudeMd = claudeMd.replace(
          /^You are \w+, the COO of the user's AI organization\.$/m,
          `You are ${effectiveName}, the COO of the user's AI organization.`,
        );
        // Remove existing language section if present, then add new one if needed
        claudeMd = claudeMd.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) {
          claudeMd = claudeMd.trimEnd() + languageSection + "\n";
        }
        fs.writeFileSync(claudeMdPath, claudeMd);
      }

      // Update AGENTS.md with personalized name and language
      const agentsMdPath = path.join(JINN_HOME, "AGENTS.md");
      if (fs.existsSync(agentsMdPath)) {
        let agentsMd = fs.readFileSync(agentsMdPath, "utf-8");
        // Replace the bold identity line (e.g. "You are **Jinn**")
        agentsMd = agentsMd.replace(
          /You are \*\*\w+\*\*/,
          `You are **${effectiveName}**`,
        );
        // Remove existing language section if present, then add new one if needed
        agentsMd = agentsMd.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) {
          agentsMd = agentsMd.trimEnd() + languageSection + "\n";
        }
        fs.writeFileSync(agentsMdPath, agentsMd);
      }

      context.emit("config:updated", { portal: updated.portal });
      return json(res, { status: "ok", portal: updated.portal });
    }

    return notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    return serverError(res, msg);
  }
}

/**
 * Parse the output of `npx skills find <query>` into structured results.
 *
 * Format:
 * ```
 * owner/repo@skill-name  <N> installs
 * └ https://skills.sh/owner/repo/skill-name
 * ```
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseSkillsSearchOutput(
  output: string,
): Array<{ name: string; source: string; url: string; installs: number }> {
  const results: Array<{ name: string; source: string; url: string; installs: number }> = [];
  const lines = output.trim().split("\n");

  for (let i = 0; i < lines.length; i++) {
    const headerLine = stripAnsi(lines[i]).trim();
    // Match "owner/repo@skill-name  <N> installs"
    const headerMatch = headerLine.match(/^(\S+)\s+(\d+)\s+installs?$/);
    if (!headerMatch) continue;

    const source = headerMatch[1];
    const installs = parseInt(headerMatch[2], 10);
    const atIdx = source.lastIndexOf("@");
    const name = atIdx > 0 ? source.slice(atIdx + 1) : source;

    // Next line should be the URL
    let url = "";
    if (i + 1 < lines.length) {
      const urlLine = stripAnsi(lines[i + 1]).trim();
      const urlMatch = urlLine.match(/[└]\s*(https?:\/\/\S+)/);
      if (urlMatch) {
        url = urlMatch[1];
        i++; // consume the URL line
      }
    }

    results.push({ name, source, url, installs });
  }
  return results;
}

/**
 * Load messages from a Claude Code JSONL transcript file.
 * Used as a fallback when the messages DB is empty (pre-existing sessions).
 */
function loadTranscriptMessages(engineSessionId: string): Array<{ role: string; content: string }> {
  // Claude Code stores transcripts in ~/.claude/projects/<project-key>/<sessionId>.jsonl
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  // Search all project dirs for the transcript
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const messages: Array<{ role: string; content: string }> = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj.message;
        if (!msg) continue;

        let content = msg.content;
        if (Array.isArray(content)) {
          content = content
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text)
            .join("");
        }
        if (typeof content === "string" && content.trim()) {
          messages.push({ role: type, content: content.trim() });
        }
      } catch {
        continue;
      }
    }
    return messages;
  }
  return [];
}

async function runWebSession(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
): Promise<void> {
  const currentSession = getSession(session.id);
  if (!currentSession) {
    logger.info(`Skipping deleted web session ${session.id} before run start`);
    return;
  }
  logger.info(`Web session ${currentSession.id} running engine "${currentSession.engine}" (model: ${currentSession.model || "default"})`);

  // Ensure status is "running" (may already be set by the POST handler)
  const currentStatus = getSession(currentSession.id);
  if (currentStatus && currentStatus.status !== "running") {
    updateSession(currentSession.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
    });
  }

  try {
    // If this session has an assigned employee, load their persona
    let employee: import("../shared/types.js").Employee | undefined;
    if (currentSession.employee) {
      const { findEmployee } = await import("./org.js");
      const { scanOrg } = await import("./org.js");
      const registry = scanOrg();
      employee = findEmployee(currentSession.employee, registry);
    }

    const systemPrompt = buildContext({
      source: "web",
      channel: currentSession.sourceRef,
      user: "web-user",
      employee,
      connectors: Array.from(context.connectors.keys()),
      config,
      sessionId: currentSession.id,
    });

    const engineConfig = currentSession.engine === "codex"
      ? config.engines.codex
      : config.engines.claude;
    let lastHeartbeatAt = 0;
    const runHeartbeat = setInterval(() => {
      updateSession(currentSession.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
    }, 5000);

    const result = await engine.run({
      prompt,
      resumeSessionId: currentSession.engineSessionId ?? undefined,
      systemPrompt,
      cwd: JINN_HOME,
      bin: engineConfig.bin,
      model: currentSession.model ?? engineConfig.model,
      cliFlags: employee?.cliFlags,
      sessionId: currentSession.id,
      onStream: (delta) => {
        const now = Date.now();
        if (now - lastHeartbeatAt >= 2000) {
          lastHeartbeatAt = now;
          updateSession(currentSession.id, {
            status: "running",
            lastActivity: new Date(now).toISOString(),
          });
        }
        try {
          context.emit("session:delta", {
            sessionId: currentSession.id,
            type: delta.type,
            content: delta.content,
            toolName: delta.toolName,
          });
        } catch (err) {
          logger.warn(`Failed to emit stream delta for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
      },
    }).finally(() => {
      clearInterval(runHeartbeat);
    });

    if (!getSession(currentSession.id)) {
      logger.info(`Skipping completion for deleted web session ${currentSession.id}`);
      return;
    }

    // Persist the assistant response
    if (result.result) {
      insertMessage(currentSession.id, "assistant", result.result);
    }

    updateSession(currentSession.id, {
      engineSessionId: result.sessionId,
      status: result.error ? "error" : "idle",
      lastActivity: new Date().toISOString(),
      lastError: result.error ?? null,
    });

    context.emit("session:completed", {
      sessionId: currentSession.id,
      employee: currentSession.employee || config.portal?.portalName || "Jinn",
      title: currentSession.title,
      result: result.result,
      error: result.error || null,
      cost: result.cost,
      durationMs: result.durationMs,
    });

    logger.info(
      `Web session ${currentSession.id} completed` +
      (result.durationMs ? ` in ${result.durationMs}ms` : "") +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!getSession(currentSession.id)) {
      logger.info(`Skipping error handling for deleted web session ${currentSession.id}: ${errMsg}`);
      return;
    }
    updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    context.emit("session:completed", {
      sessionId: currentSession.id,
      result: null,
      error: errMsg,
    });
    logger.error(`Web session ${currentSession.id} error: ${errMsg}`);
  }
}

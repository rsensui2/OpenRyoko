import { beforeEach, describe, expect, it, vi } from "vitest";

/* The CLI is the agent-facing surface: what matters is that it picks the right
 * API route for each verb, merges the two automation kinds into one view,
 * distinguishes "engine disabled" from "no such id", and fails in words that
 * tell the caller (a human or Claude Code) what to run next. */

const request = vi.fn();
vi.mock("../api.js", () => ({
  requestGatewayApi: (opts: unknown) => request(opts),
}));

import {
  runAutomationList,
  runAutomationToggle,
  runWorkflowCreate,
  reportCliFailure,
} from "../automation.js";

function ok(body: unknown): { ok: true; status: number; body: string } {
  return { ok: true, status: 200, body: JSON.stringify(body) };
}

function page<T>(items: T[]): { ok: true; status: number; body: string } {
  return ok({ items, nextCursor: null });
}

const TEMPLATES_ON = ok({ templates: [], workflowsEnabled: true });
const TEMPLATES_OFF = ok({ templates: [], workflowsEnabled: false });

function logCapture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(String(line)); });
  return { lines, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  request.mockReset();
});

describe("automation list", () => {
  it("merges workflows (cursor-paged) and cron jobs into one view", async () => {
    request.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/api/cron") return ok([{ id: "daily-briefing", schedule: "50 6 * * *", enabled: true }]);
      if (path === "/api/automation/templates") return TEMPLATES_ON;
      if (path === "/api/workflows") return page([{ id: "inquiry-watch", title: "問い合わせ見張り", enabled: true, revision: 2, retiredAt: null }]);
      throw new Error(`unexpected ${path}`);
    });
    const capture = logCapture();
    try {
      await runAutomationList({ json: true });
    } finally {
      capture.restore();
    }
    const payload = JSON.parse(capture.lines.join("\n")) as { workflowsEnabled: boolean; automations: Array<{ kind: string; id: string }> };
    expect(payload.workflowsEnabled).toBe(true);
    expect(payload.automations.map((row) => `${row.kind}:${row.id}`))
      .toEqual(["workflow:inquiry-watch", "cron:daily-briefing"]);
  });

  it("follows nextCursor across pages", async () => {
    request.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/api/cron") return ok([]);
      if (path === "/api/automation/templates") return TEMPLATES_ON;
      if (path === "/api/workflows") return ok({ items: [{ id: "a", title: "A", enabled: true, revision: 1, retiredAt: null }], nextCursor: "c1" });
      if (path === "/api/workflows?cursor=c1") return page([{ id: "b", title: "B", enabled: false, revision: 1, retiredAt: null }]);
      throw new Error(`unexpected ${path}`);
    });
    const capture = logCapture();
    try {
      await runAutomationList({ json: true });
    } finally {
      capture.restore();
    }
    const payload = JSON.parse(capture.lines.join("\n")) as { automations: Array<{ id: string }> };
    expect(payload.automations.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("degrades to cron-only when the capability endpoint says the engine is off", async () => {
    request.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/api/cron") return ok([{ id: "daily-briefing", enabled: true }]);
      if (path === "/api/automation/templates") return TEMPLATES_OFF;
      throw new Error(`unexpected ${path}`);
    });
    const capture = logCapture();
    try {
      await runAutomationList({ json: true });
    } finally {
      capture.restore();
    }
    const payload = JSON.parse(capture.lines.join("\n")) as { workflowsEnabled: boolean; automations: unknown[] };
    expect(payload.workflowsEnabled).toBe(false);
    expect(payload.automations).toHaveLength(1);
  });
});

describe("automation enable/disable routes by kind", () => {
  it("a cron id goes to PUT /api/cron/:id", async () => {
    request.mockImplementation(async ({ method, path }: { method: string; path: string }) => {
      if (path === "/api/cron" && method === "GET") return ok([{ id: "daily-briefing", enabled: true }]);
      if (path === "/api/automation/templates") return TEMPLATES_ON;
      if (path === "/api/workflows") return page([]);
      if (path === "/api/cron/daily-briefing" && method === "PUT") return ok({ id: "daily-briefing", enabled: false });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const capture = logCapture();
    try {
      await runAutomationToggle("daily-briefing", false, { json: true });
    } finally {
      capture.restore();
    }
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "PUT", path: "/api/cron/daily-briefing" }));
  });

  it("a workflow id posts enable with the listed revision", async () => {
    request.mockImplementation(async ({ method, path }: { method: string; path: string }) => {
      if (path === "/api/cron") return ok([]);
      if (path === "/api/automation/templates") return TEMPLATES_ON;
      if (path === "/api/workflows") return page([{ id: "inquiry-watch", title: "w", enabled: false, revision: 4, retiredAt: null }]);
      if (path === "/api/workflows/inquiry-watch/enable" && method === "POST") return ok({ enabled: true, revision: 5 });
      throw new Error(`unexpected ${method} ${path}`);
    });
    const capture = logCapture();
    try {
      await runAutomationToggle("inquiry-watch", true, { json: true });
    } finally {
      capture.restore();
    }
    const enableCall = request.mock.calls.find(([opts]) => (opts as { path: string }).path.endsWith("/enable"))![0] as { data: string };
    expect(JSON.parse(enableCall.data)).toEqual({ expectedRevision: 4 });
    expect(JSON.parse(capture.lines.join("\n"))).toMatchObject({ enabled: true, revision: 5 });
  });

  it("demands --kind when an id exists on both sides", async () => {
    request.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/api/cron") return ok([{ id: "same-id", enabled: true }]);
      if (path === "/api/automation/templates") return TEMPLATES_ON;
      if (path === "/api/workflows") return page([{ id: "same-id", title: "w", enabled: true, revision: 1, retiredAt: null }]);
      throw new Error(`unexpected ${path}`);
    });
    await expect(runAutomationToggle("same-id", false, {})).rejects.toThrow(/--kind/);
  });

  it("reports an unknown id as not-found, not as engine-disabled", async () => {
    request.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/api/cron") return ok([]);
      if (path === "/api/automation/templates") return TEMPLATES_ON;
      if (path === "/api/workflows") return page([]);
      throw new Error(`unexpected ${path}`);
    });
    await expect(runAutomationToggle("no-such-id", true, {})).rejects.toThrow(/cron にも workflow にもありません/);
  });
});

describe("workflow create --template", () => {
  it("uses the atomic template endpoint and reports its (post-enable) revision", async () => {
    request.mockImplementation(async ({ method, path, data }: { method: string; path: string; data?: string }) => {
      if (path === "/api/automation/templates/watch-then-act" && method === "POST") {
        const body = JSON.parse(data!) as { name: string; enable: boolean; vars: Record<string, string> };
        expect(body.name).toBe("inquiry-watch");
        expect(body.enable).toBe(true);
        expect(body.vars.employee).toBe("ryoko");
        return { ok: true, status: 201, body: JSON.stringify({ id: "inquiry-watch", revision: 3, enabled: true }) };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const capture = logCapture();
    try {
      await runWorkflowCreate({
        template: "watch-then-act", name: "inquiry-watch", enable: true, json: true,
        set: ["employee=ryoko", "watchPrompt=新着問い合わせを確認", "actPrompt=返信案を投稿"],
      });
    } finally {
      capture.restore();
    }
    expect(JSON.parse(capture.lines.join("\n"))).toEqual({ id: "inquiry-watch", revision: 3, enabled: true });
  });

  it("surfaces template variable errors locally, before any API call", async () => {
    await expect(runWorkflowCreate({ template: "watch-then-act", name: "x", set: ["employee=ryoko"] }))
      .rejects.toThrow(/watchPrompt/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("reportCliFailure", () => {
  it("emits machine-readable JSON for unexpected errors too", () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(String(line)); });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    try {
      expect(() => reportCliFailure(new TypeError("boom"), true)).toThrow("exit");
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
    const parsed = JSON.parse(errors.join("\n")) as { error: string; unexpected: boolean };
    expect(parsed).toMatchObject({ error: "boom", unexpected: true });
  });


  it("emits machine-readable JSON on --json", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(String(line)); });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    try {
      await runWorkflowCreate({ template: "watch-then-act", name: "x", set: [] })
        .catch((error) => { expect(() => reportCliFailure(error, true)).toThrow("exit"); });
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
    const parsed = JSON.parse(errors.join("\n")) as { error: string };
    expect(parsed.error).toMatch(/employee/);
  });
});

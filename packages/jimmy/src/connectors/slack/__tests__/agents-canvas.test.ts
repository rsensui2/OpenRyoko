import fs from "node:fs";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { listSessions } from "../../../sessions/registry.js";
import { AgentsCanvasUpdater, renderCanvasMarkdown } from "../agents-canvas.js";
import type { Session } from "../../../shared/types.js";

vi.mock("../../../sessions/registry.js", () => ({
  listSessions: vi.fn(() => []),
}));

vi.mock("../../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-agents-canvas-test",
}));

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: "claude-abc",
    source: "slack",
    sourceRef: "C123:1700000000.000",
    connector: "slack",
    sessionKey: "slack:C123",
    replyContext: null,
    messageId: "1700000000.000",
    transportMeta: null,
    employee: null,
    model: null,
    title: "Untitled",
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-05-13T01:00:00.000Z",
    lastActivity: "2026-05-13T01:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

const FIXED_NOW = Date.parse("2026-05-13T01:30:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  fs.rmSync("/tmp/openryoko-agents-canvas-test", { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("renderCanvasMarkdown", () => {
  it("renders a placeholder when there are no sessions", () => {
    const md = renderCanvasMarkdown([], { nowMs: FIXED_NOW });
    expect(md).toContain("# Ryoko Agents View");
    expect(md).toContain("0 sessions");
    expect(md).toContain("No active sessions");
  });

  it("groups sessions by status", () => {
    const sessions = [
      makeSession({ id: "a", status: "running", title: "Build proposal" }),
      makeSession({ id: "b", status: "waiting", title: "Awaiting reply" }),
      makeSession({ id: "c", status: "error", title: "Broken thing", lastError: "boom" }),
      makeSession({ id: "d", status: "interrupted", title: "Old run" }),
      makeSession({ id: "e", status: "idle", title: "Wrapped up" }),
    ];
    const md = renderCanvasMarkdown(sessions, { nowMs: FIXED_NOW });
    expect(md).toContain("🟢 Running (1)");
    expect(md).toContain("🟡 Waiting on you (1)");
    expect(md).toContain("🔴 Errored (1)");
    expect(md).toContain("⏸️ Interrupted (resumable) (1)");
    expect(md).toContain("✅ Recently idle (1)");
    expect(md).toContain("**Build proposal**");
    expect(md).toContain("**Awaiting reply**");
  });

  it("omits empty groups", () => {
    const sessions = [makeSession({ status: "running", title: "Just one" })];
    const md = renderCanvasMarkdown(sessions, { nowMs: FIXED_NOW });
    expect(md).toContain("🟢 Running (1)");
    expect(md).not.toContain("Waiting on you");
    expect(md).not.toContain("Errored");
    expect(md).not.toContain("Recently idle");
  });

  it("caps each group at maxPerGroup and shows overflow line", () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      makeSession({ id: `r${i}`, status: "running", title: `task ${i}` }),
    );
    const md = renderCanvasMarkdown(sessions, { nowMs: FIXED_NOW, maxPerGroup: 3 });
    expect(md).toContain("🟢 Running (15)");
    expect(md).toContain("**task 0**");
    expect(md).toContain("**task 2**");
    expect(md).not.toContain("**task 3**");
    expect(md).toContain("…and 12 more");
  });

  it("formats age in minutes / hours / days", () => {
    const sessions = [
      makeSession({
        id: "fresh",
        status: "running",
        title: "fresh",
        lastActivity: new Date(FIXED_NOW - 2 * 60_000).toISOString(),
      }),
      makeSession({
        id: "old",
        status: "running",
        title: "hours-old",
        lastActivity: new Date(FIXED_NOW - 3 * 60 * 60_000).toISOString(),
      }),
      makeSession({
        id: "ancient",
        status: "running",
        title: "days-old",
        lastActivity: new Date(FIXED_NOW - 5 * 24 * 60 * 60_000).toISOString(),
      }),
    ];
    const md = renderCanvasMarkdown(sessions, { nowMs: FIXED_NOW });
    expect(md).toContain("**fresh**");
    expect(md).toMatch(/\*\*fresh\*\*.* — 2m/);
    expect(md).toMatch(/\*\*hours-old\*\*.* — 3h/);
    expect(md).toMatch(/\*\*days-old\*\*.* — 5d/);
  });

  it("truncates very long titles", () => {
    const longTitle = "x".repeat(200);
    const md = renderCanvasMarkdown(
      [makeSession({ title: longTitle, status: "running" })],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("…");
    // Should not include the full 200 chars
    expect(md).not.toContain(longTitle);
  });

  it("honors a custom title", () => {
    const md = renderCanvasMarkdown([], { title: "Team Ryoko", nowMs: FIXED_NOW });
    expect(md).toContain("# Team Ryoko");
  });

  it("includes connector/employee in the line metadata when present", () => {
    const md = renderCanvasMarkdown(
      [
        makeSession({
          status: "running",
          title: "with-meta",
          connector: "slack",
          source: "slack",
          employee: "ryoko",
        }),
      ],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("**with-meta** _(slack · @ryoko)_");
  });
});

describe("AgentsCanvasUpdater", () => {
  it("keeps the current canvas id on non-recoverable edit failures instead of creating duplicates", async () => {
    const apiCall = vi.fn(async (method: string) => {
      if (method === "canvases.create") return { canvas_id: "F123" };
      if (method === "canvases.edit") {
        const err = new Error("invalid_arguments");
        (err as any).data = { error: "invalid_arguments" };
        throw err;
      }
      return {};
    });
    const updater = new AgentsCanvasUpdater(
      { client: { apiCall } } as any,
      { enabled: true, pollIntervalMs: 5_000 },
    );
    const mockedListSessions = vi.mocked(listSessions);

    mockedListSessions.mockReturnValueOnce([]);
    await (updater as any).tick();

    mockedListSessions.mockReturnValueOnce([
      makeSession({ id: "changed", status: "running", title: "changed" }),
    ]);
    await (updater as any).tick();

    mockedListSessions.mockReturnValueOnce([
      makeSession({ id: "changed-again", status: "running", title: "changed again" }),
    ]);
    await (updater as any).tick();

    expect(apiCall.mock.calls.filter(([method]) => method === "canvases.create")).toHaveLength(1);
    expect(apiCall.mock.calls.filter(([method]) => method === "canvases.edit")).toHaveLength(2);
  });

  it("recreates on the next tick when Slack reports the canvas is missing", async () => {
    const apiCall = vi.fn(async (method: string) => {
      if (method === "canvases.create") return { canvas_id: `F${apiCall.mock.calls.length}` };
      if (method === "canvases.edit") {
        const err = new Error("canvas_not_found");
        (err as any).data = { error: "canvas_not_found" };
        throw err;
      }
      return {};
    });
    const updater = new AgentsCanvasUpdater(
      { client: { apiCall } } as any,
      { enabled: true, pollIntervalMs: 5_000 },
    );
    const mockedListSessions = vi.mocked(listSessions);

    mockedListSessions.mockReturnValueOnce([]);
    await (updater as any).tick();

    mockedListSessions.mockReturnValueOnce([
      makeSession({ id: "changed", status: "running", title: "changed" }),
    ]);
    await (updater as any).tick();

    mockedListSessions.mockReturnValueOnce([
      makeSession({ id: "changed-again", status: "running", title: "changed again" }),
    ]);
    await (updater as any).tick();

    expect(apiCall.mock.calls.filter(([method]) => method === "canvases.create")).toHaveLength(2);
    expect(apiCall.mock.calls.filter(([method]) => method === "canvases.edit")).toHaveLength(1);
  });

  it("self-disables after 10 consecutive tick failures and stops calling Slack", async () => {
    const apiCall = vi.fn(async (method: string) => {
      if (method === "canvases.create") {
        const err = new Error("canvas_tab_creation_failed");
        (err as any).data = { error: "canvas_tab_creation_failed" };
        throw err;
      }
      return {};
    });
    const updater = new AgentsCanvasUpdater(
      { client: { apiCall } } as any,
      { enabled: true, pollIntervalMs: 5_000 },
    );

    // 10 consecutive failures → the loop should give up and stop itself.
    for (let i = 0; i < 10; i++) {
      await (updater as any).tick();
    }
    expect((updater as any).stopped).toBe(true);
    const createsAtDisable = apiCall.mock.calls.filter(([m]) => m === "canvases.create").length;
    expect(createsAtDisable).toBe(10);

    // Further ticks are no-ops — a self-disabled loop must not keep hitting Slack.
    await (updater as any).tick();
    await (updater as any).tick();
    expect(apiCall.mock.calls.filter(([m]) => m === "canvases.create").length).toBe(createsAtDisable);
  });

  it("resets the failure counter after a successful tick", async () => {
    let failCreate = true;
    let n = 0;
    const apiCall = vi.fn(async (method: string) => {
      if (method === "canvases.create") {
        if (failCreate) {
          const err = new Error("canvas_tab_creation_failed");
          (err as any).data = { error: "canvas_tab_creation_failed" };
          throw err;
        }
        return { canvas_id: "F1" };
      }
      return {};
    });
    const updater = new AgentsCanvasUpdater(
      { client: { apiCall } } as any,
      { enabled: true, pollIntervalMs: 5_000 },
    );
    // Vary sessions every tick so the no-op short-circuit never fires.
    vi.mocked(listSessions).mockImplementation(() => [
      makeSession({ id: `s${n++}`, status: "running", title: `s${n}` }),
    ]);

    // 9 consecutive create failures — one short of the limit.
    for (let i = 0; i < 9; i++) await (updater as any).tick();
    expect((updater as any).consecutiveFailures).toBe(9);
    expect((updater as any).stopped).toBe(false);

    // A successful tick clears the counter, so a transient outage never trips the limit.
    failCreate = false;
    await (updater as any).tick();
    expect((updater as any).consecutiveFailures).toBe(0);
    expect((updater as any).stopped).toBe(false);
  });
});

describe("renderCanvasMarkdown — user-controlled string defang", () => {
  // Regression coverage for security review M1: a malicious session title
  // (or connector / employee field) must not be able to ping anyone or
  // hijack the canvas Markdown structure.
  it("strips Slack <@U…> user mentions", () => {
    const md = renderCanvasMarkdown(
      [makeSession({ status: "running", title: "ping <@U0123456> hi" })],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("(user)");
    expect(md).not.toMatch(/<@U\d/);
  });

  it("strips Slack <@U…|alias> aliased user mentions but keeps the label", () => {
    const md = renderCanvasMarkdown(
      [makeSession({ status: "running", title: "by <@U0123456|alice> done" })],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("alice");
    expect(md).not.toContain("<@U");
  });

  it("strips Slack <#C…> channel links", () => {
    const md = renderCanvasMarkdown(
      [makeSession({ status: "running", title: "see <#C09U11F6KEG>" })],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("(channel)");
    expect(md).not.toContain("<#C");
  });

  it("rewrites <#C…|name> channel links to #name", () => {
    const md = renderCanvasMarkdown(
      [makeSession({ status: "running", title: "from <#C123|agent-ops>" })],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("#agent-ops");
    expect(md).not.toContain("<#C");
  });

  it("strips Slack <!channel>, <!here>, <!everyone> broadcast mentions", () => {
    const md = renderCanvasMarkdown(
      [
        makeSession({ id: "a", status: "running", title: "<!channel> heads up" }),
        makeSession({ id: "b", status: "running", title: "<!here> attention" }),
        makeSession({ id: "c", status: "running", title: "<!everyone> all hands" }),
      ],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("(channel)");
    expect(md).toContain("(here)");
    expect(md).toContain("(everyone)");
    expect(md).not.toMatch(/<![a-z]+>/);
  });

  it("inserts a zero-width space inside bare @channel / @here / @everyone", () => {
    const md = renderCanvasMarkdown(
      [makeSession({ status: "running", title: "hey @channel team" })],
      { nowMs: FIXED_NOW },
    );
    // zero-width space (U+200B) between @ and the keyword breaks the ping
    expect(md).toMatch(/@​channel/);
  });

  it("strips Slack subteam mentions (<!subteam^S…>)", () => {
    const md = renderCanvasMarkdown(
      [makeSession({ status: "running", title: "for <!subteam^SAZ94GDB8>" })],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("(group)");
    expect(md).not.toContain("<!subteam");
  });

  it("escapes Markdown emphasis / heading / blockquote / table / strike chars", () => {
    const md = renderCanvasMarkdown(
      [
        makeSession({
          status: "running",
          title: "# big *bold* `code` ~~strike~~ > quote | col [link]",
        }),
      ],
      { nowMs: FIXED_NOW },
    );
    expect(md).toContain("\\#");
    expect(md).toContain("\\*");
    expect(md).toContain("\\`");
    expect(md).toContain("\\~");
    expect(md).toContain("\\>");
    expect(md).toContain("\\|");
    expect(md).toContain("\\[");
    expect(md).toContain("\\]");
  });

  it("collapses embedded newlines so list items don't break", () => {
    const md = renderCanvasMarkdown(
      [makeSession({ status: "running", title: "line1\nline2\n# inject" })],
      { nowMs: FIXED_NOW },
    );
    // The title should land on one logical line (no Markdown line break);
    // every Markdown control character is escaped.
    expect(md.split("\n").filter((l) => l.includes("line1")).length).toBe(1);
    expect(md).toContain("\\#");
  });
});

describe("AgentsCanvasUpdater — free_team_canvas_tab_already_exists recovery", () => {
  // Regression coverage: on free Slack workspaces the create call (either
  // conversations.canvases.create or canvases.create) fails with
  // `free_team_canvas_tab_already_exists`. The updater must adopt the existing
  // canvas if it can be located, and otherwise stop the timer instead of
  // looping every poll interval.

  function makeSlackError(code: string): Error & { data: { error: string } } {
    const err = new Error(`An API error occurred: ${code}`) as Error & {
      data: { error: string };
    };
    err.data = { error: code };
    return err;
  }

  function makeFakeApp(apiCall: (method: string, payload: unknown) => unknown) {
    return { client: { apiCall: vi.fn(apiCall) } } as unknown as ConstructorParameters<
      typeof AgentsCanvasUpdater
    >[0];
  }

  it("adopts the existing channel canvas when create returns free_team_canvas_tab_already_exists", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const app = makeFakeApp(async (method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "conversations.canvases.create") {
        throw makeSlackError("free_team_canvas_tab_already_exists");
      }
      if (method === "conversations.info") {
        return { channel: { properties: { canvas: { file_id: "F_EXISTING" } } } };
      }
      if (method === "canvases.edit") {
        return { ok: true };
      }
      throw new Error(`unexpected api call ${method}`);
    });

    const updater = new AgentsCanvasUpdater(app, {
      enabled: true,
      channelId: "C123",
      pollIntervalMs: 5_000,
    });
    await (updater as unknown as { tick(): Promise<void> }).tick();

    const methods = calls.map((c) => c.method);
    expect(methods).toContain("conversations.canvases.create");
    expect(methods).toContain("conversations.info");
    const edit = calls.find((c) => c.method === "canvases.edit");
    expect(edit?.payload.canvas_id).toBe("F_EXISTING");
  });

  it("falls back to files.list when the channel does not own the existing canvas", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const app = makeFakeApp(async (method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "conversations.canvases.create") {
        throw makeSlackError("free_team_canvas_tab_already_exists");
      }
      if (method === "conversations.info") {
        return { channel: {} };
      }
      if (method === "files.list") {
        return { files: [{ id: "F_STANDALONE", title: "Ryoko Agents View" }] };
      }
      if (method === "canvases.edit") {
        return { ok: true };
      }
      throw new Error(`unexpected api call ${method}`);
    });

    const updater = new AgentsCanvasUpdater(app, {
      enabled: true,
      channelId: "C123",
      pollIntervalMs: 5_000,
    });
    await (updater as unknown as { tick(): Promise<void> }).tick();

    const methods = calls.map((c) => c.method);
    expect(methods).toContain("files.list");
    const edit = calls.find((c) => c.method === "canvases.edit");
    expect(edit?.payload.canvas_id).toBe("F_STANDALONE");
  });

  it("stops the updater after one log when no existing canvas can be located", async () => {
    const app = makeFakeApp(async (method) => {
      if (method === "conversations.canvases.create") {
        throw makeSlackError("free_team_canvas_tab_already_exists");
      }
      if (method === "conversations.info") return { channel: {} };
      if (method === "files.list") return { files: [] };
      throw new Error(`unexpected api call ${method}`);
    });

    const updater = new AgentsCanvasUpdater(app, {
      enabled: true,
      channelId: "C123",
      pollIntervalMs: 5_000,
    });
    await (updater as unknown as { tick(): Promise<void> }).tick();

    // Second tick must be a no-op now that the timer has been stopped — i.e.
    // no further apiCalls should happen on subsequent invocations.
    const fakeClient = (app as unknown as { client: { apiCall: ReturnType<typeof vi.fn> } }).client;
    const callsBefore = fakeClient.apiCall.mock.calls.length;
    await (updater as unknown as { tick(): Promise<void> }).tick();
    expect(fakeClient.apiCall.mock.calls.length).toBe(callsBefore);
  });
});

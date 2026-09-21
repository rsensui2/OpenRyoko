import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, deleteSession, getSession, updateSession } from "../registry.js";
import type { Engine, EngineRunOpts, JinnConfig } from "../../shared/types.js";
import { runWithSessionGoal, sessionGoalOptions } from "../goal-execution.js";
import { SessionQueue } from "../queue.js";
import { reviewGoal } from "../goal-review.js";
import { extractGoalCondition } from "../../connectors/slack/goal-extractor.js";

vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn() }));
vi.mock("../../connectors/slack/goal-extractor.js", async (original) => ({
  ...await original<object>(), extractGoalCondition: vi.fn(),
}));

function setup(name = "codex") {
  const session = createSession({ engine: name, source: "slack", sourceRef: crypto.randomUUID(), prompt: "update calendar" });
  updateSession(session.id, { status: "running" });
  const run = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "thread-81", result: "招待を反映します。", numTurns: 1 });
  const engine: Engine = { name, run };
  const opts: EngineRunOpts = { sessionId: session.id, prompt: "/goal 正式日程と参加者設定を確認する\n\n承認済みのカレンダー更新を実行して", cwd: "/tmp" };
  return { session, run, engine, opts };
}

beforeEach(() => { vi.resetAllMocks(); });

describe("tracked conversation goals", () => {
  it("resumes the same Codex thread after a promise, and delivers only the verified final result", async () => {
    const { engine, opts, run, session } = setup();
    vi.mocked(reviewGoal).mockResolvedValueOnce({ status: "continue", reason: "更新が未実行" })
      .mockResolvedValueOnce({ status: "complete", reason: "予定と参加者を読み返し確認済み" });
    run.mockResolvedValueOnce({ sessionId: "thread-81", result: "招待を反映します。", numTurns: 1, cost: 1 })
      .mockResolvedValueOnce({ sessionId: "thread-81", result: "更新と確認が完了しました。", numTurns: 1, cost: 2 });
    const result = await runWithSessionGoal(engine, opts);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].resumeSessionId).toBe("thread-81");
    expect(run.mock.calls[1][0].prompt).toContain("Do not replay");
    expect(result).toMatchObject({ result: "更新と確認が完了しました。", numTurns: 2, cost: 3 });
    expect(result.turns).toBeUndefined();
    expect(getSession(session.id)?.goal?.status).toBe("complete");
  });

  it("persists a waiting goal across a later acknowledgement without inventing new approval", async () => {
    const { engine, opts, run, session } = setup();
    run.mockResolvedValue({ sessionId: "thread-81", result: "対象を確認してください。" });
    vi.mocked(reviewGoal).mockResolvedValue({ status: "waiting", reason: "対象の確認待ち", waitingFor: "user" });
    await runWithSessionGoal(engine, opts);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)?.goal?.status).toBe("waiting");
    expect(getSession(session.id)?.goal?.waitingFor).toBe("user");
    vi.mocked(reviewGoal).mockResolvedValue({ status: "complete", reason: "確認完了" });
    await runWithSessionGoal(engine, { ...opts, prompt: "はい、それで進めて", resumeSessionId: "thread-81" });
    const next = run.mock.calls[1][0];
    expect(next.prompt).toContain("はい、それで進めて");
    expect(next.systemPrompt).toContain("正式日程と参加者設定を確認する");
    expect(next.systemPrompt).toContain("does not grant permission");
    expect(getSession(session.id)?.goal?.status).toBe("complete");
    expect(getSession(session.id)?.goal?.waitingFor).toBeUndefined();
  });

  it.each(["waiting", "cancelled", "blocked"] as const)("does not restart a %s task", async (status) => {
    const { engine, opts, run, session } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status, reason: "停止理由" });
    await runWithSessionGoal(engine, opts);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)?.goal?.status).toBe(status);
  });

  it.each(["background", "external", "unknown"] as const)("persists explicit %s dependency without converting it to user input", async (waitingFor) => {
    const { engine, opts, session } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "waiting", reason: "依存先の待機", waitingFor });
    await runWithSessionGoal(engine, opts);
    expect(getSession(session.id)?.goal?.waitingFor).toBe(waitingFor);
  });

  it("treats an unspecified waiting dependency as unknown", async () => {
    const { engine, opts, session } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "blocked", reason: "サービスのエラー" });
    await runWithSessionGoal(engine, opts);
    expect(getSession(session.id)?.goal?.waitingFor).toBe("unknown");
  });

  it("bounds unfinished continuations and reports the unfinished work", async () => {
    const { engine, opts, run, session } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "continue", reason: "参加者未登録" });
    const result = await runWithSessionGoal(engine, opts, { maxContinuations: 2 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.error).toContain("Goal incomplete");
    expect(result.result).toContain("未完了");
    expect(result.result).not.toBe("招待を反映します。");
    expect(getSession(session.id)?.goal?.status).toBe("incomplete");
  });

  it("does not rerun when the completion check fails or no resume ID exists", async () => {
    const { engine, opts, run } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "unknown", reason: "判定できない" });
    expect((await runWithSessionGoal(engine, opts)).error).toContain("Goal incomplete");
    expect(run).toHaveBeenCalledTimes(1);
    vi.mocked(reviewGoal).mockResolvedValue({ status: "continue", reason: "未実行" });
    run.mockResolvedValue({ sessionId: "", result: "続けます。" });
    expect((await runWithSessionGoal(engine, opts)).error).toContain("Goal incomplete");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("honours cancellation during the completion check, even between Codex processes", async () => {
    const { engine, opts, run } = setup();
    let cancelled = false;
    vi.mocked(reviewGoal).mockImplementation(async () => { cancelled = true; return { status: "continue", reason: "未実行" }; });
    const result = await runWithSessionGoal(engine, opts, { shouldStop: () => cancelled });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.error).toMatch(/^Interrupted/);
  });

  it("never recreates a session reset while the check was running", async () => {
    const { engine, opts, run, session } = setup();
    vi.mocked(reviewGoal).mockImplementation(async () => { deleteSession(session.id); return { status: "continue", reason: "未実行" }; });
    expect((await runWithSessionGoal(engine, opts)).error).toMatch(/^Interrupted/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)).toBeUndefined();
  });

  it("does not start an engine for a session reset before execution", async () => {
    const { engine, opts, run, session } = setup();
    deleteSession(session.id);
    expect((await runWithSessionGoal(engine, opts)).error).toMatch(/^Interrupted/);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps ordinary conversation unchanged and performs no extra model calls", async () => {
    const { engine, opts, run } = setup();
    await runWithSessionGoal(engine, { ...opts, prompt: "こんにちは" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(reviewGoal).not.toHaveBeenCalled();
    expect(extractGoalCondition).not.toHaveBeenCalled();
  });

  it("uses the existing natural-language extractor for Codex", async () => {
    const { engine, opts, session } = setup();
    vi.mocked(extractGoalCondition).mockResolvedValue("予定と参加者を読み返し確認する");
    vi.mocked(reviewGoal).mockResolvedValue({ status: "complete", reason: "確認済み" });
    await runWithSessionGoal(engine, { ...opts, prompt: "カレンダーを更新して最後まで確認して" }, { extraction: { enabled: true } });
    expect(extractGoalCondition).toHaveBeenCalled();
    expect(getSession(session.id)?.goal?.condition).toBe("予定と参加者を読み返し確認する");
  });

  it("preserves Claude's native /goal path", async () => {
    const { engine, opts, run } = setup("claude");
    await runWithSessionGoal(engine, opts);
    expect(run.mock.calls[0][0].prompt).toMatch(/^\/goal /);
    expect(reviewGoal).not.toHaveBeenCalled();
  });
  it("retains tool evidence and the original wait reason after approval", async () => {
    const { engine, opts, run } = setup();
    run.mockImplementationOnce(async (o) => {
      o.onStream?.({ type: "tool_result", toolId: "create", toolName: "calendar", content: "Created event e81" });
      return { sessionId: "thread-81", result: "招待する参加者を確認してください" };
    });
    vi.mocked(reviewGoal).mockResolvedValue({ status: "waiting", reason: "参加者の承認待ち" });
    await runWithSessionGoal(engine, opts);
    await runWithSessionGoal(engine, { ...opts, prompt: "この参加者で進めて", resumeSessionId: "thread-81" });
    const input = vi.mocked(reviewGoal).mock.calls[1][0];
    expect(input.goal.status).toBe("waiting");
    expect(input.goal.reason).toBe("参加者の承認待ち");
    expect(input.tools.join(" ")).toContain("Created event e81");
  });

  it("yields to a newly queued message while evaluating completion", async () => {
    const { engine, opts, run, session } = setup();
    let queued = false;
    vi.mocked(reviewGoal).mockImplementation(async () => { queued = true; return { status: "continue", reason: "未実行" }; });
    const result = await runWithSessionGoal(engine, opts, { shouldYield: () => queued });
    expect(result.error).toMatch(/^Interrupted/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)?.goal?.status).toBe("waiting");
  });

  it("does not revive a closed goal for the next ordinary message", async () => {
    const { engine, opts, run } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "complete", reason: "確認済み" });
    await runWithSessionGoal(engine, opts);
    await runWithSessionGoal(engine, { ...opts, prompt: "ありがとう" });
    expect(reviewGoal).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[1][0].systemPrompt).toBeUndefined();
  });

  it("does not auto-replay a failed engine run", async () => {
    const { engine, opts, run, session } = setup();
    run.mockResolvedValue({ sessionId: "thread-81", result: "処理途中", error: "failed" });
    expect((await runWithSessionGoal(engine, opts)).error).toBe("failed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(reviewGoal).not.toHaveBeenCalled();
    expect(getSession(session.id)?.goal?.status).toBe("incomplete");
  });

  it("supports status and cancellation without executing more work", async () => {
    const { engine, opts, run, session } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "waiting", reason: "確認待ち" });
    await runWithSessionGoal(engine, opts);
    expect((await runWithSessionGoal(engine, { ...opts, prompt: "/goal" })).result).toContain("waiting");
    await runWithSessionGoal(engine, { ...opts, prompt: "/goal cancel" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)?.goal?.status).toBe("cancelled");
  });

  it("leaves Claude's native lifecycle in Claude's hands", async () => {
    const { engine, opts, run, session } = setup("claude");
    await runWithSessionGoal(engine, opts);
    await runWithSessionGoal(engine, { ...opts, prompt: "次の質問です" });
    expect(run.mock.calls[1][0].prompt).toBe("次の質問です");
    expect(getSession(session.id)?.goal).toBeNull();
  });

  it("uses per-instance settings, respects opt-out, and observes stops between processes", () => {
    const { session } = setup();
    const queue = new SessionQueue();
    const config = { connectors: { slack: { goalExtraction: { enabled: true } }, instances: [
      { id: "slack-private", type: "slack", goalExtraction: { enabled: false, engine: "claude" } },
    ] } } as unknown as JinnConfig;
    const options = sessionGoalOptions(config, { ...session, connector: "slack-private" }, queue, "task");
    expect(options.extraction).toMatchObject({ enabled: false, engine: "claude" });
    expect(options.shouldStop?.()).toBe(false);
    queue.clearQueue(session.sessionKey || session.sourceRef || session.id);
    expect(options.shouldStop?.()).toBe(true);
    expect(sessionGoalOptions({ connectors: {} } as JinnConfig, session, queue, "task").extraction?.enabled).toBe(true);
  });

});

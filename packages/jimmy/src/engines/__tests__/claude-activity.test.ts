import { describe, expect, it } from "vitest";
import { lastActivityAt, startedRun, TOOL_RUN_CAP_MS, withOutput, withStreamLine, type ClaudeRunActivity } from "../claude-activity.js";

/**
 * What counts as a `claude -p` run still working, read off the stream-json it
 * prints. The message shapes are the ones Claude Code 2.1 prints; see
 * claude-headless-activity.test.ts for the engine and the watchdog around it.
 */

const START = Date.parse("2026-10-22T07:10:00Z");
const minutes = (n: number) => n * 60_000;
const line = (message: unknown) => JSON.stringify(message);

const toolUse = (ids: string[], parent: string | null = null) =>
  line({ type: "assistant", message: { content: ids.map((id) => ({ type: "tool_use", id, name: "Bash", input: {} })) }, parent_tool_use_id: parent });
const toolResult = (id: string, parent: string | null = null) =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, parent_tool_use_id: parent });
const task = (subtype: "task_started" | "task_notification", taskId: string, toolUseId = "toolu_agent") =>
  line({ type: "system", subtype, task_id: taskId, tool_use_id: toolUseId, status: "completed" });
const backgroundTasks = (...taskIds: string[]) =>
  line({ type: "system", subtype: "background_tasks_changed", tasks: taskIds.map((task_id) => ({ task_id, task_type: "local_agent" })) });
const messageStart = (parent: string | null = null) =>
  line({ type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: parent });
const keepAlive = line({ type: "keep_alive" });

/** Feed lines in order, each printed at its own time. */
function feed(activity: ClaudeRunActivity, ...printed: Array<[number, string]>): ClaudeRunActivity {
  return printed.reduce((current, [at, text]) => withStreamLine(current, text, at), activity);
}

describe("a claude run's last activity", () => {
  it("starts at the start of the run and moves with every line and every part of one", () => {
    const run = startedRun(START);
    expect(lastActivityAt(run, START + minutes(3))).toBe(START);
    expect(lastActivityAt(withOutput(run, START + minutes(2)), START + minutes(3))).toBe(START + minutes(2));
    expect(lastActivityAt(feed(run, [START + minutes(1), messageStart()]), START + minutes(3))).toBe(START + minutes(1));
  });

  it("does not move for the CLI's keep-alive heartbeat", () => {
    const run = feed(startedRun(START), [START + minutes(1), toolResult("toolu_unknown")], [START + minutes(2), keepAlive], [START + minutes(3), keepAlive]);
    expect(lastActivityAt(run, START + minutes(4))).toBe(START + minutes(1));
  });

  it("holds a tool as running from its tool_use until its tool_result", () => {
    const running = feed(startedRun(START), [START, toolUse(["toolu_deploy"])]);
    expect(lastActivityAt(running, START + minutes(9))).toBe(START + minutes(9));

    const returned = feed(running, [START + minutes(9), toolResult("toolu_deploy")]);
    expect(lastActivityAt(returned, START + minutes(12))).toBe(START + minutes(9));
  });

  it("waits for every tool of a parallel call, whose results come back one line each", () => {
    const both = feed(startedRun(START), [START, toolUse(["toolu_fast", "toolu_slow"])]);
    const oneLeft = feed(both, [START + 5_000, toolResult("toolu_fast")]);
    expect(lastActivityAt(oneLeft, START + minutes(8))).toBe(START + minutes(8));

    const done = feed(oneLeft, [START + minutes(8), toolResult("toolu_slow")]);
    expect(lastActivityAt(done, START + minutes(10))).toBe(START + minutes(8));
  });

  it("measures the cap from the last tool that started or came back", () => {
    const run = feed(startedRun(START), [START, toolUse(["toolu_a", "toolu_b"])], [START + minutes(14), toolResult("toolu_a")]);
    expect(lastActivityAt(run, START + minutes(20))).toBe(START + minutes(20));
    expect(lastActivityAt(run, START + minutes(14) + TOOL_RUN_CAP_MS)).toBe(START + minutes(14));
  });

  it("follows a background agent, whose tool call returns at once while the agent works on", () => {
    // Claude Code 2.1 starts an Agent tool call in the background: the call
    // returns at once, the agent is reported as a task, and its own tool calls
    // carry the agent call's id as their parent.
    const launched = feed(startedRun(START),
      [START, toolUse(["toolu_agent"])],
      [START + 10, task("task_started", "agent_1")],
      [START + 20, toolResult("toolu_agent")]);
    expect(lastActivityAt(launched, START + minutes(7))).toBe(START + minutes(7));

    const agentTool = feed(launched,
      [START + minutes(7), toolUse(["toolu_build"], "toolu_agent")],
      [START + minutes(16), toolResult("toolu_build", "toolu_agent")]);
    expect(lastActivityAt(agentTool, START + minutes(20))).toBe(START + minutes(20));

    const finished = feed(agentTool, [START + minutes(21), task("task_notification", "agent_1")]);
    expect(lastActivityAt(finished, START + minutes(24))).toBe(START + minutes(21));
  });

  it("drops what an agent left behind: its calls when it makes its next request, and all of them when it is done", () => {
    // A call whose result never came (the response was retried), next to a background agent at work.
    const run = feed(startedRun(START),
      [START, task("task_started", "agent_1")],
      [START + 1, toolUse(["toolu_agent_build"], "toolu_agent")],
      [START + 2, toolUse(["toolu_abandoned"])]);
    const nextRequest = feed(run, [START + minutes(1), messageStart()]);
    expect([...nextRequest.running.keys()].sort()).toEqual(["task:agent_1", "tool:toolu_agent_build"]);

    const agentDone = feed(nextRequest, [START + minutes(2), task("task_notification", "agent_1", "toolu_agent")]);
    expect(agentDone.running.size).toBe(0);
    expect(lastActivityAt(agentDone, START + minutes(9))).toBe(START + minutes(2));
  });

  it("drops only the calls of the agent whose task is done", () => {
    const run = feed(startedRun(START),
      [START, task("task_started", "agent_1", "toolu_agent_1")],
      [START + 1, task("task_started", "agent_2", "toolu_agent_2")],
      [START + 2, toolUse(["toolu_build_1"], "toolu_agent_1")],
      [START + 3, toolUse(["toolu_build_2"], "toolu_agent_2")]);
    const firstDone = feed(run, [START + minutes(1), task("task_notification", "agent_1", "toolu_agent_1")]);
    expect([...firstDone.running.keys()].sort()).toEqual(["task:agent_2", "tool:toolu_build_2"]);
  });

  it("does not restart the cap for a line that changes nothing running", () => {
    const run = feed(startedRun(START),
      [START, toolUse(["toolu_hung"])],
      [START + 1, backgroundTasks()],
      [START + minutes(10), toolResult("toolu_unknown")],
      [START + minutes(11), toolUse(["toolu_hung"])],
      [START + minutes(12), backgroundTasks()],
      [START + minutes(13), messageStart("toolu_some_agent")]);
    expect(lastActivityAt(run, START + TOOL_RUN_CAP_MS)).toBe(START + minutes(13));
  });

  it("takes the CLI's own list of background tasks over the starts and ends it saw", () => {
    const run = feed(startedRun(START),
      [START, task("task_started", "agent_1")],
      [START + 1, task("task_started", "agent_2")],
      [START + 2, toolUse(["toolu_main"])]);
    const listed = feed(run, [START + minutes(3), backgroundTasks("agent_2")]);
    expect([...listed.running.keys()].sort()).toEqual(["task:agent_2", "tool:toolu_main"]);

    const none = feed(listed, [START + minutes(4), backgroundTasks()], [START + minutes(5), toolResult("toolu_main")]);
    expect(lastActivityAt(none, START + minutes(9))).toBe(START + minutes(5));
  });

  it("gives up on running work once nothing has started or come back for 15 minutes", () => {
    const running = feed(startedRun(START), [START, toolUse(["toolu_hung"])], [START + 3, line({ type: "stream_event", event: { type: "message_stop" } })]);
    expect(lastActivityAt(running, START + TOOL_RUN_CAP_MS - 1)).toBe(START + TOOL_RUN_CAP_MS - 1);
    expect(lastActivityAt(running, START + TOOL_RUN_CAP_MS)).toBe(START + 3);
    // Another tool starting is new work, with a cap of its own.
    const next = feed(running, [START + minutes(16), toolUse(["toolu_next"])]);
    expect(lastActivityAt(next, START + minutes(30))).toBe(START + minutes(30));
  });

  it.each([
    ["an empty line", ""],
    ["a line that is not JSON", "Warning: no stdin data received in 3s"],
    ["a text delta", line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } } })],
    ["an assistant message with text only", line({ type: "assistant", message: { content: [{ type: "text", text: "tool_use" }] } })],
    ["a tool result for a call it never saw", toolResult("toolu_unknown")],
    ["a task line without a task id", line({ type: "system", subtype: "task_started" })],
    ["a JSON value that is not an object", line(["tool_use"])],
  ])("starts nothing on %s", (_label, text) => {
    const activity = feed(startedRun(START), [START + 1_000, text]);
    expect(activity.running.size).toBe(0);
    expect(lastActivityAt(activity, START + minutes(10))).toBe(START + 1_000);
  });

  it("returns new values and leaves the ones it is given as they were", () => {
    const run = Object.freeze(startedRun(START));
    const running = withStreamLine(run, toolUse(["toolu_1"]), START + 1);
    expect(running).not.toBe(run);
    expect(run.running.size).toBe(0);

    const returned = withStreamLine(running, toolResult("toolu_1"), START + 2);
    expect(running.running.size).toBe(1);
    expect(returned.running.size).toBe(0);
    expect(withOutput(run, START + 3)).toMatchObject({ stdoutAt: START + 3 });
    expect(run.stdoutAt).toBe(START);
  });
});

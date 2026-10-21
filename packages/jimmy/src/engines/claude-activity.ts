/**
 * Whether a `claude -p` run is still working, read off the stream-json it prints.
 *
 * The response watchdog (runEngineWithResponseTimeout) stops a run that shows
 * no activity for `sessions.engineNoResponseTimeoutMs`, and only part of what
 * claude prints becomes a stream delta. So every line counts here — extended
 * thinking and the input of a tool call included, the CLI's keep-alive
 * heartbeat excepted — and so does the silence of work that is running: a
 * tool from the moment its call is complete until its result comes back, and
 * a task the CLI runs in the background, such as an agent, until it is done.
 * Neither prints anything meanwhile.
 *
 * Values of ClaudeRunActivity are never changed: each update returns a new one.
 */

/** Claude Code's own Bash timeout is at most 10 minutes, so a single tool run longer than this is treated as hung. */
export const TOOL_RUN_CAP_MS = 15 * 60_000;

/** Running work by key (`tool:<id>`, `task:<id>`), with the tool call it belongs to: a sub-agent's, or null. */
type Running = ReadonlyMap<string, string | null>;

type Message = Record<string, unknown>;

export interface ClaudeRunActivity {
  /** When the run last wrote to stdout (or started). */
  readonly stdoutAt: number;
  /** Tool calls and CLI tasks that have started and not yet come back. */
  readonly running: Running;
  /** When the running work last changed: something started or came back. */
  readonly workEventAt: number;
}

export function startedRun(now: number): ClaudeRunActivity {
  return { stdoutAt: now, running: new Map(), workEventAt: now };
}

/** The activity after the run wrote part of a line: a long one still arriving. */
export function withOutput(activity: ClaudeRunActivity, now: number): ClaudeRunActivity {
  return { ...activity, stdoutAt: now };
}

/** The activity after one complete stream-json line. */
export function withStreamLine(activity: ClaudeRunActivity, line: string, now: number): ClaudeRunActivity {
  const message = parseLine(line);
  // A heartbeat only says that the process is there, which is no sign of work.
  if (message?.type === "keep_alive") return activity;
  const running = message ? nextRunning(activity.running, message) : undefined;
  return running && !sameRunning(activity.running, running)
    ? { stdoutAt: now, running, workEventAt: now }
    : withOutput(activity, now);
}

/** Whether running work still counts as activity: some is running, and it last changed within the cap. */
export function workStillCounts(runningCount: number, workEventAt: number, now: number): boolean {
  return runningCount > 0 && now - workEventAt < TOOL_RUN_CAP_MS;
}

/** Now while work runs (up to the cap), otherwise the last time the run wrote anything. */
export function lastActivityAt(activity: ClaudeRunActivity, now: number): number {
  return workStillCounts(activity.running.size, activity.workEventAt, now) ? now : activity.stdoutAt;
}

/** The running work after a message about work, or undefined for any other message. */
function nextRunning(running: Running, message: Message): Running | undefined {
  const owner = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
  switch (message.type) {
    case "assistant": {
      // Printed once a tool call's input is complete — the main agent's calls and a sub-agent's alike.
      const started = blockValues(message, "tool_use", "id");
      return started.length > 0 ? new Map([...running, ...started.map((id) => [toolKey(id), owner] as const)]) : undefined;
    }
    case "user": {
      const finished = new Set(blockValues(message, "tool_result", "tool_use_id").map(toolKey));
      return without(running, (key) => finished.has(key));
    }
    case "stream_event":
      // An agent makes its next request only once each of its tool calls has a
      // result, so a call still listed for it was abandoned (a retried stream).
      // This takes the event's parent_tool_use_id to name its agent: Claude
      // Code 2.1 prints stream events for the main agent only, with null.
      return eventType(message) === "message_start" ? without(running, (key, of) => isTool(key) && of === owner) : undefined;
    case "system":
      return nextTasks(running, message);
    default:
      return undefined;
  }
}

/** Claude Code 2.1 runs agents in the background and reports them, and long shell commands, as tasks. */
function nextTasks(running: Running, message: Message): Running | undefined {
  if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
    // The full list of background tasks: a start or end that was missed leaves none behind.
    const listed = message.tasks.flatMap((task: unknown) => {
      const id = task && typeof task === "object" ? (task as Message).task_id : undefined;
      return typeof id === "string" ? [[taskKey(id), null] as const] : [];
    });
    return new Map([...[...running].filter(([key]) => !isTask(key)), ...listed]);
  }
  const taskId = message.task_id;
  if (typeof taskId !== "string") return undefined;
  if (message.subtype === "task_started") return new Map([...running, [taskKey(taskId), null]]);
  if (message.subtype !== "task_notification") return undefined;
  // The task is over, and so is any call made by the agent it ran.
  const call = typeof message.tool_use_id === "string" ? message.tool_use_id : undefined;
  return without(running, (key, of) => key === taskKey(taskId) || (call !== undefined && of === call));
}

/** `running` without the entries `drop` picks. */
function without(running: Running, drop: (key: string, owner: string | null) => boolean): Running {
  return new Map([...running].filter(([key, owner]) => !drop(key, owner)));
}

/** Whether two sets of running work hold the same entries. */
function sameRunning(a: Running, b: Running): boolean {
  return a.size === b.size && [...b].every(([key, owner]) => a.has(key) && a.get(key) === owner);
}

const toolKey = (id: string): string => `tool:${id}`;
const taskKey = (id: string): string => `task:${id}`;
const isTool = (key: string): boolean => key.startsWith("tool:");
const isTask = (key: string): boolean => key.startsWith("task:");

function eventType(message: Message): unknown {
  const event = message.event;
  return event && typeof event === "object" ? (event as Message).type : undefined;
}

/** The `field` of each content block of the given type in a message. */
function blockValues(message: Message, type: string, field: string): string[] {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    const fields = block as Message;
    return fields.type === type && typeof fields[field] === "string" ? [fields[field] as string] : [];
  });
}

function parseLine(line: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
}

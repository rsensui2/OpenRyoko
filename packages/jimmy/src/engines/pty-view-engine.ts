/**
 * Shared contract for engines that expose a live PTY to the web dashboard's
 * xterm view (`/ws/pty/:sessionId`). Both the interactive Claude engine and the
 * Antigravity engine implement this, so the WebSocket handler can route by
 * `session.engine` instead of being hardwired to one engine.
 */

/** Out-of-band control event for PTY subscribers (e.g. respawn → client clears xterm). */
export type PtyControlEvent = { type: "reset" };

export interface PtyIdleSpawnOpts {
  /** Engine-side conversation/session id to resume into the idle PTY, if any. */
  engineSessionId?: string;
  cwd?: string;
  model?: string;
  bin?: string;
  cols?: number;
  rows?: number;
  /** See EngineRunOpts.nativeMemory: the session's audience decides it, also for a PTY warmed up ahead of a turn. */
  nativeMemory?: "off";
}

export interface PtyViewEngine {
  hasWarmPty(sessionId: string): boolean;
  ensureIdleSpawn(sessionId: string, opts: PtyIdleSpawnOpts): void;
  subscribeOutput(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void;
  getScrollback(sessionId: string): Buffer;
  setViewing(sessionId: string, viewing: boolean): void;
  writeStdin(sessionId: string, text: string): void;
  resizePty(sessionId: string, cols: number, rows: number): void;
}

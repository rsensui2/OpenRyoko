import { describe, expect, it, vi } from "vitest";

// node-pty loads a native module at import time (fails on Linux CI). The engine
// imports it at the top level, so stub it before importing the engine.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { pasteAndSubmit } from "../claude-interactive.js";
import { stripTerminalControlChars } from "../../shared/terminal-safe-text.js";

const PASTE_OPEN = "\u001b[200~";
const PASTE_CLOSE = "\u001b[201~";
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

describe("stripTerminalControlChars", () => {
  it("drops C0, DEL and C1 controls but keeps tab and newline", () => {
    expect(stripTerminalControlChars("a\u0000b\u0007c\u001bd\u007fe\u009bf")).toBe("abcdef");
    expect(stripTerminalControlChars("one\ttwo\nthree")).toBe("one\ttwo\nthree");
  });

  it("folds carriage returns into the line feed, keeping the line break", () => {
    expect(stripTerminalControlChars("a\r\nb")).toBe("a\nb");
    expect(stripTerminalControlChars("a\rb")).toBe("a\nb");
    expect(stripTerminalControlChars("a\n\rb")).toBe("a\n\nb");
  });

  it("turns an embedded bracketed-paste sequence into inert text", () => {
    const out = stripTerminalControlChars(`before${PASTE_CLOSE}after`);
    expect(out).toBe("before[201~after");
    expect(CONTROL.test(out)).toBe(false);
  });

  it("leaves text without control characters untouched", () => {
    const clean = "手順:\n- 一つ目\n- 二つ目\t(タブ)";
    expect(stripTerminalControlChars(clean)).toBe(clean);
  });
});

describe("pasteAndSubmit", () => {
  const writesOf = (text: string): string[] => {
    const writes: string[] = [];
    pasteAndSubmit({ write: (data: string) => { writes.push(data); } }, text);
    return writes;
  };
  /** The text inside the single bracketed-paste write. */
  const pastedBody = (text: string): string => {
    const paste = writesOf(text).find((write) => write.startsWith(PASTE_OPEN));
    if (paste === undefined) throw new Error("no bracketed-paste write");
    return paste.slice(PASTE_OPEN.length, paste.length - PASTE_CLOSE.length);
  };

  it("cannot be ended from inside the paste: an embedded close sequence is inert text", () => {
    const body = pastedBody(`hello${PASTE_CLOSE}/logout`);

    expect(body).toContain("[201~/logout"); // the ESC is gone, so the paste runs to its real end
    expect(CONTROL.test(body)).toBe(false);
  });

  it("carries no control character into the paste, whatever the message held", () => {
    const body = pastedBody("a\u0000b\u001bc\u009bd\u007fe");

    expect(CONTROL.test(body)).toBe(false);
  });

  it("keeps the newlines and tabs of an ordinary multi-line message", () => {
    expect(pastedBody("line1\nline2\ttabbed")).toBe("line1\nline2\ttabbed");
  });

  it("still submits with a carriage return after the paste", () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      pasteAndSubmit({ write: (data: string) => { writes.push(data); } }, "hi");
      vi.advanceTimersByTime(200);
      expect(writes.filter((write) => write === "\r")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

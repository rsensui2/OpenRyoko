import { describe, expect, it, vi } from "vitest";
import { readTriageHistory } from "../triage-context.js";

describe("Slack triage context", () => {
  it("reads the tail of a long chronological thread and excludes current/future messages", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: Array.from({ length: 100 }, (_, i) => ({ ts: `${i + 1}.000`, text: `m${i + 1}` })),
      has_more: true, response_metadata: { next_cursor: "page2" },
    }).mockResolvedValueOnce({
      messages: Array.from({ length: 25 }, (_, i) => ({ ts: `${i + 100}.000`, text: `m${i + 100}` })),
      has_more: false,
    });
    const result = await readTriageHistory({ replies, history: vi.fn() }, {
      channel: "C1", threadTs: "1.000", messageTs: "124.000", limit: 10,
    });
    expect(result.incomplete).toBe(false);
    expect(result.messages.map((m) => m.text)).toEqual(Array.from({ length: 10 }, (_, i) => `m${114 + i}`));
    expect(replies.mock.calls[1][0]).toMatchObject({ cursor: "page2", latest: "124.000", inclusive: false });
  });

  it("marks a capped or cursor-less thread incomplete instead of treating the head as the latest context", async () => {
    for (const cursor of [undefined, "repeated"]) {
      const replies = vi.fn().mockResolvedValue({
        messages: [{ ts: "1.000", text: "old" }], has_more: true,
        response_metadata: { next_cursor: cursor },
      });
      const result = await readTriageHistory({ replies, history: vi.fn() }, {
        channel: "C1", threadTs: "1.000", messageTs: "99.000", limit: 10,
      });
      expect(result.incomplete).toBe(true);
      expect(replies.mock.calls.length).toBeLessThanOrEqual(4);
    }
  });

  it("returns newest channel messages chronologically, deduplicated", async () => {
    const history = vi.fn().mockResolvedValue({ messages: [
      { ts: "3.000", text: "new" }, { ts: "2.000", text: "old" }, { ts: "2.000", text: "old" },
    ] });
    const result = await readTriageHistory({ replies: vi.fn(), history }, { channel: "C1", limit: 10 });
    expect(result).toMatchObject({ incomplete: false, messages: [{ text: "old" }, { text: "new" }] });
  });

  it("marks transport failure and malformed timestamps incomplete", async () => {
    const history = vi.fn().mockRejectedValueOnce(new Error("private provider body"))
      .mockResolvedValueOnce({ messages: [{ text: "unknown time" }] });
    for (let i = 0; i < 2; i++) {
      expect(await readTriageHistory({ replies: vi.fn(), history }, { channel: "C1", limit: 10 }))
        .toEqual({ messages: [], incomplete: true });
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeOneShot } from "../../shared/oneShotCli.js";
import { parseGoalReview, reviewGoal } from "../goal-review.js";
vi.mock("../../shared/oneShotCli.js", async (original) => ({ ...await original<object>(), invokeOneShot: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("completion assessment", () => {
  it.each(["", "done", '{"status":"continue"}', '{"status":"approved","reason":"yes"}', '{"status":"continue","reason":""}'])("fails closed on an invalid assessment: %s", (text) => {
    expect(parseGoalReview(text).status).toBe("unknown");
  });
  it("accepts a structured wait in Japanese", () => {
    expect(parseGoalReview('```json\n{"status":"waiting","reason":"承認を待っています"}\n```')).toEqual({ status: "waiting", reason: "承認を待っています" });
  });
  it.each(["user", "background", "external", "unknown"] as const)("preserves structured %s dependency", (waitingFor) => {
    expect(parseGoalReview(JSON.stringify({ status: "waiting", reason: "待機中", waitingFor })))
      .toMatchObject({ status: "waiting", waitingFor });
  });
  it("rejects unrecognized dependency values", () => {
    expect(parseGoalReview('{"status":"waiting","reason":"待機中","waitingFor":"anyone"}').status).toBe("unknown");
  });
  it("does not turn a failed classifier into permission to continue", async () => {
    vi.mocked(invokeOneShot).mockRejectedValue(new Error("timeout"));
    const result = await reviewGoal({ goal: { id: "g", condition: "招待済み", request: "承認後に招待", status: "waiting", reason: "承認待ち", updatedAt: "now" }, latestRequest: "了解", answer: "承認を待っています", tools: [] });
    expect(result.status).toBe("unknown");
    expect(invokeOneShot).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ classificationOnly: true }));
    const prompt = vi.mocked(invokeOneShot).mock.calls[0][0];
    expect(prompt).toContain('"previousState":"waiting"');
    expect(prompt).toContain('"previousReason":"承認待ち"');
    expect(prompt).toContain("A waiting/blocked status or a historical approval request alone does NOT imply waitingFor=user");
  });
});

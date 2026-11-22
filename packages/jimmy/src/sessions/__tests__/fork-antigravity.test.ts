import { describe, it, expect } from "vitest";
import { forkEngineSession } from "../fork.js";

describe("forkEngineSession — antigravity", () => {
  it("lets a duplicate start a new agy conversation instead of failing", () => {
    expect(forkEngineSession("antigravity", "conv-1", "/tmp")).toEqual({ engineSessionId: "" });
  });
});

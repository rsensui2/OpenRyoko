import { describe, expect, it } from "vitest";
import { messageText } from "../message-body.js";

describe("messageText", () => {
  it("accepts the first non-empty string in key order", () => {
    expect(messageText({ prompt: "hello", message: "fallback" }, ["prompt", "message"])).toBe("hello");
  });

  it("rejects missing, non-string, empty and whitespace-only input", () => {
    expect(messageText({}, ["prompt"])).toBeNull();
    expect(messageText({ prompt: 42 }, ["prompt"])).toBeNull();
    expect(messageText({ prompt: "   \n" }, ["prompt"])).toBeNull();
  });
});

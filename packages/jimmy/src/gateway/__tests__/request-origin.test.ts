import { describe, expect, it } from "vitest";
import { requestOriginAllowed } from "../request-origin.js";

describe("browser Origin guard", () => {
  it("accepts same-host and cross-spelling loopback requests", () => {
    expect(requestOriginAllowed("http://127.0.0.1:7777", "127.0.0.1:7777", "127.0.0.1")).toBe(true);
    expect(requestOriginAllowed("http://localhost:7777", "127.0.0.1:7777", "127.0.0.1")).toBe(true);
    expect(requestOriginAllowed(undefined, "127.0.0.1:7777", "127.0.0.1")).toBe(true);
  });

  it("rejects a browser origin on a different port of the same host", () => {
    expect(requestOriginAllowed("http://192.168.1.5:3000", "192.168.1.5:7777", "0.0.0.0")).toBe(false);
    expect(requestOriginAllowed("http://localhost:3000", "127.0.0.1:7777", "127.0.0.1")).toBe(false);
  });

  it("rejects hostile web origins even on wildcard binds", () => {
    expect(requestOriginAllowed("https://attacker.example", "127.0.0.1:7777", "127.0.0.1")).toBe(false);
    expect(requestOriginAllowed("https://attacker.example", "192.168.1.5:7777", "0.0.0.0")).toBe(false);
    expect(requestOriginAllowed("not a url", "127.0.0.1:7777", "127.0.0.1")).toBe(false);
  });
});

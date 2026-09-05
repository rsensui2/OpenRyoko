import { describe, expect, it } from "vitest";
import { hostHeaderAllowed } from "../host-guard.js";

describe("gateway Host guard", () => {
  it("allows loopback and an explicit bind host", () => {
    expect(hostHeaderAllowed("localhost:7777", "127.0.0.1")).toBe(true);
    expect(hostHeaderAllowed("[::1]:7777", "127.0.0.1")).toBe(true);
    expect(hostHeaderAllowed("192.168.1.5:7777", "192.168.1.5")).toBe(true);
  });

  it("does not turn a wildcard bind into a wildcard Host policy", () => {
    expect(hostHeaderAllowed("attacker.example:7777", "0.0.0.0", [], ["192.168.1.5"])).toBe(false);
    expect(hostHeaderAllowed("192.168.1.5:7777", "0.0.0.0", [], ["192.168.1.5"])).toBe(true);
  });

  it("supports explicit reverse-proxy hostnames", () => {
    expect(hostHeaderAllowed("ryoko.example.com:443", "0.0.0.0", ["ryoko.example.com"], [])).toBe(true);
    expect(hostHeaderAllowed("RYOKO.EXAMPLE.COM.:443", "::", ["ryoko.example.com"], [])).toBe(true);
  });

  it("always rejects wildcard Host values, even on a wildcard bind", () => {
    expect(hostHeaderAllowed("0.0.0.0:7777", "0.0.0.0", [], [])).toBe(false);
    expect(hostHeaderAllowed("[::]:7777", "::", [], [])).toBe(false);
    expect(hostHeaderAllowed("0.0.0.0:7777", "0.0.0.0", ["0.0.0.0"], [])).toBe(false);
    expect(hostHeaderAllowed("[::]:7777", "::", ["::"], [])).toBe(false);
    expect(hostHeaderAllowed("attacker.example:7777", "0.0.0.0", [], [])).toBe(false);
    expect(hostHeaderAllowed(undefined, "0.0.0.0", [], [])).toBe(false);
  });
});

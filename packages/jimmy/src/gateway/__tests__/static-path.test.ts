import path from "node:path";
import { describe, expect, it } from "vitest";
import { staticPathWithinRoot } from "../static-path.js";

describe("static file path guard", () => {
  it("accepts files within the static root", () => {
    const root = path.resolve("dist/web");
    expect(staticPathWithinRoot(root, path.join(root, "chat/index.html"))).toBe(true);
  });

  it("rejects traversal into a sibling with the same prefix", () => {
    const root = path.resolve("dist/web");
    expect(staticPathWithinRoot(root, path.resolve(root, "../web-private/secret"))).toBe(false);
  });
});

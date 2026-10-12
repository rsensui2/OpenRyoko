import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confineRemovals, isStrictlyInside } from "../test-support/confined-removals.js";

/* The guard that keeps tests of deletion code harmless must itself be tested
 * without risk. So the decision — is this target inside the sandbox? — is a
 * pure function, and every hostile input goes to that function, where nothing
 * can be deleted. The installed guard is then exercised only with targets
 * whose real removal would not matter: paths inside two throwaway directories
 * made for the purpose. */

describe("isStrictlyInside (pure: no file is touched)", () => {
  const box = path.join(path.sep, "tmp", "sandbox");

  it.each([
    [path.join(box, "message")],
    [path.join(box, "message", "0", "photo.png")],
    [path.join(box, "..foo")], // a child whose name merely starts with two dots
    [path.join(box, "a", "..", "b")],
  ])("accepts %s", (target) => {
    expect(isStrictlyInside(box, target)).toBe(true);
  });

  it.each([
    [box], // the directory itself is not inside itself
    [`${box}${path.sep}`],
    [path.join(box, ".")],
    [path.dirname(box)],
    [path.join(box, "..")],
    [path.join(box, "message", "..", "..")],
    [path.join(box, "..", "other")],
    [`${box}-sibling`],
    [path.join(`${box}-sibling`, "file")],
    [path.sep],
    [os.homedir()],
    ["message"], // relative paths never count, wherever the working directory is
    [`.${path.sep}message`],
    ["."],
    [".."],
    [""],
    [undefined],
    [null],
    [42],
    [{ toString: () => path.join(box, "message") }],
  ])("refuses %j", (target) => {
    expect(isStrictlyInside(box, target)).toBe(false);
  });

  it("refuses everything when the directory itself is not absolute", () => {
    expect(isStrictlyInside("sandbox", path.resolve("sandbox", "message"))).toBe(false);
    expect(isStrictlyInside("", path.join(path.sep, "tmp", "x"))).toBe(false);
  });
});

describe("confineRemovals", () => {
  let sandbox: string;
  let outside: string;
  const reallyRemove = fs.rmSync.bind(fs);

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-confined-sandbox-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-confined-outside-"));
    fs.mkdirSync(path.join(sandbox, "message", "0"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "message", "0", "photo.png"), "bytes");
    fs.writeFileSync(path.join(outside, "precious.txt"), "keep me");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    reallyRemove(sandbox, { recursive: true, force: true });
    reallyRemove(outside, { recursive: true, force: true });
  });

  it("carries out a removal inside the sandbox", () => {
    const confined = confineRemovals(sandbox);
    fs.rmSync(path.join(sandbox, "message"), { recursive: true, force: true });
    expect(fs.existsSync(path.join(sandbox, "message"))).toBe(false);
    expect(confined.performed).toEqual([path.join(sandbox, "message")]);
  });

  it("records and drops a removal outside it", () => {
    const confined = confineRemovals(sandbox);
    const precious = path.join(outside, "precious.txt");

    fs.rmSync(precious, { force: true });
    fs.rmSync(path.join(sandbox, "..", path.basename(outside), "precious.txt"), { force: true });

    expect(confined.requests).toHaveLength(2);
    expect(confined.performed).toEqual([]);
    expect(fs.readFileSync(precious, "utf-8")).toBe("keep me");
  });

  it.each([[""], ["relative/dir"], [os.tmpdir()], [os.homedir()], [path.parse(os.tmpdir()).root]])(
    "refuses %j as a sandbox and installs nothing",
    (candidate) => {
      expect(() => confineRemovals(candidate)).toThrow(/inside the OS temp directory/);
      expect(vi.isMockFunction(fs.rmSync)).toBe(false);
    },
  );
});

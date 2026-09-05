import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitLandingEvidence } from "../git-landing-evidence.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical git landing evidence", () => {
  it("refuses a local-main-only commit until it reaches the fetched canonical remote branch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-canonical-landing-"));
    roots.push(root);
    const remote = path.join(root, "origin.git");
    const checkout = path.join(root, "checkout");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, checkout], { stdio: "ignore" });
    git(checkout, "config", "user.email", "test@example.invalid");
    git(checkout, "config", "user.name", "Jinn Test");
    fs.writeFileSync(path.join(checkout, "proof.txt"), "base\n");
    git(checkout, "add", "proof.txt");
    git(checkout, "commit", "-m", "base");
    git(checkout, "push", "-u", "origin", "main");

    fs.appendFileSync(path.join(checkout, "proof.txt"), "local only\n");
    git(checkout, "commit", "-am", "local only");
    const commit = git(checkout, "rev-parse", "HEAD");
    const evidence = createGitLandingEvidence({ remote: "origin", branch: "main" });

    await expect(evidence.mergedIntoMain({ commit, checkout })).resolves.toBe(false);

    git(checkout, "push", "origin", "main");
    await expect(evidence.mergedIntoMain({ commit, checkout })).resolves.toBe(true);
  });
});

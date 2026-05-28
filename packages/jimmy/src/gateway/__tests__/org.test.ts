import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We need to mock ORG_DIR to point to a temp directory
let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { scanOrg, isValidSshHost } from "../org.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("scanOrg — alwaysNotify field", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults alwaysNotify to true when not specified in YAML", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
`);
    const registry = scanOrg();
    const emp = registry.get("dev");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("parses alwaysNotify: false from YAML", () => {
    writeYaml("platform", "worker.yaml", `
name: worker
persona: A worker
alwaysNotify: false
`);
    const registry = scanOrg();
    const emp = registry.get("worker");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(false);
  });

  it("parses alwaysNotify: true from YAML", () => {
    writeYaml("platform", "lead.yaml", `
name: lead
persona: A lead
alwaysNotify: true
`);
    const registry = scanOrg();
    const emp = registry.get("lead");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("ignores non-boolean alwaysNotify values and defaults to true", () => {
    writeYaml("platform", "bad.yaml", `
name: bad
persona: A bad config
alwaysNotify: "yes"
`);
    const registry = scanOrg();
    const emp = registry.get("bad");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("accepts a valid sshHost for a claude employee", () => {
    writeYaml("platform", "remote.yaml", `
name: remote
persona: Runs remotely
engine: claude
sshHost: build-box
remoteCwd: /srv/work
`);
    const emp = scanOrg().get("remote");
    expect(emp!.sshHost).toBe("build-box");
    expect(emp!.remoteCwd).toBe("/srv/work");
  });

  it("drops an sshHost that looks like an ssh option (injection guard)", () => {
    writeYaml("platform", "evil.yaml", `
name: evil
persona: Tries to inject
engine: claude
sshHost: "-oProxyCommand=touch /tmp/pwned"
`);
    const emp = scanOrg().get("evil");
    expect(emp!.sshHost).toBeUndefined();
  });

  it("drops sshHost for non-claude engines", () => {
    writeYaml("platform", "codex-remote.yaml", `
name: codexremote
persona: Codex employee
engine: codex
sshHost: build-box
`);
    const emp = scanOrg().get("codexremote");
    expect(emp!.sshHost).toBeUndefined();
  });

  it("ignores remoteCwd when sshHost is absent", () => {
    writeYaml("platform", "local.yaml", `
name: localdev
persona: Local employee
remoteCwd: /srv/work
`);
    const emp = scanOrg().get("localdev");
    expect(emp!.remoteCwd).toBeUndefined();
  });
});

describe("isValidSshHost", () => {
  it("accepts plain hosts, aliases, user@host and host:port", () => {
    expect(isValidSshHost("build-box")).toBe(true);
    expect(isValidSshHost("user@10.0.0.5")).toBe(true);
    expect(isValidSshHost("host.example.com:2222")).toBe(true);
  });

  it("rejects leading dashes and shell/option metacharacters", () => {
    expect(isValidSshHost("-oProxyCommand=x")).toBe(false);
    expect(isValidSshHost("-F/tmp/cfg")).toBe(false);
    expect(isValidSshHost("host; rm -rf /")).toBe(false);
    expect(isValidSshHost("host with space")).toBe(false);
    expect(isValidSshHost("")).toBe(false);
  });
});

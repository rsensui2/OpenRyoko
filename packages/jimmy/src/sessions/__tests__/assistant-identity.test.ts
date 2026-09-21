import { describe, expect, it } from "vitest";
import { buildContext } from "../context.js";
import { resolveAssistantName } from "../../shared/assistant-identity.js";
import type { Employee } from "../../shared/types.js";

const employee: Employee = {
  name: "support", displayName: "Sora", department: "support", rank: "employee",
  engine: "claude", model: "sonnet", persona: "Help the user with support requests.",
};

describe("assistant identity shared by triage and session workers", () => {
  it.each([
    { portalName: "Momo", employee: undefined, expected: "Momo" },
    { portalName: undefined, employee: undefined, expected: "Ryoko" },
    { portalName: "Momo", employee, expected: "Sora" },
    { portalName: "Momo", employee: { ...employee, displayName: " " }, expected: "support" },
  ])("uses $expected as both the worker identity and routing name", ({ portalName, employee, expected }) => {
    const context = buildContext({ source: "slack", channel: "C1", user: "U1", portalName, employee });
    expect(context).toMatch(new RegExp(`^# You are ${expected}\\n`));
    expect(resolveAssistantName(portalName, employee)).toBe(expected);
    if (employee) expect(context).toContain(`- **Display name**: ${expected}`);
  });
});

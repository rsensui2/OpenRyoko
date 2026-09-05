import { describe, expect, it } from "vitest";
import {
  chooseApproval,
  keystrokesToSelect,
  parsePermissionPrompt,
  terminalTextLines,
} from "../claude-permission-prompt.js";
import { canRecoverLostStop, isPermissionPromptNotification, recoveryBlockedByWork } from "../claude-interactive.js";

describe("Claude safety permission prompts", () => {
  it("strictly parses one selected option and chooses an unambiguous Yes", () => {
    const prompt = parsePermissionPrompt([
      "Dangerous rm operation on possibly-empty variable path",
      "Do you want to proceed?",
      "❯ 1. No",
      "  2. Yes",
    ])!;
    expect(chooseApproval(prompt)?.position).toBe(1);
    expect(keystrokesToSelect(prompt.selectedPosition, 1)).toEqual(["\x1b[B", "\r"]);
  });

  it("refuses incomplete, negative-only, and ambiguous dialogs", () => {
    expect(parsePermissionPrompt(["Do you want to proceed?", "❯ 1. Yes"])).toBeNull();
    const negative = parsePermissionPrompt(["Do you want to proceed?", "❯ 1. No", "  2. Cancel"]);
    expect(negative && chooseApproval(negative)).toBeNull();
    const ambiguous = parsePermissionPrompt(["Do you want to proceed?", "❯ 1. Yes once", "  2. Yes always", "  3. No"]);
    expect(ambiguous && chooseApproval(ambiguous)).toBeNull();
  });

  it("removes ANSI control sequences before parsing", () => {
    const lines = terminalTextLines(Buffer.from("\u001b[2J\u001b[HDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No"));
    expect(chooseApproval(parsePermissionPrompt(lines)!)?.label).toBe("Yes");
  });

  it("recognizes notification hooks and lets a pending prompt reach stall recovery", () => {
    expect(isPermissionPromptNotification({ hook_event_name: "Notification", notification_type: "permission_prompt" })).toBe(true);
    expect(recoveryBlockedByWork(1, false, false)).toBe(true);
    expect(recoveryBlockedByWork(1, true, false)).toBe(false);
    expect(recoveryBlockedByWork(1, true, true)).toBe(true);
  });

  it("never reports lost-Stop success while a permission prompt is unanswered", () => {
    expect(canRecoverLostStop(0, true, false)).toBe(false);
    expect(canRecoverLostStop(1, false, false)).toBe(false);
    expect(canRecoverLostStop(0, false, true)).toBe(false);
    expect(canRecoverLostStop(0, false, false)).toBe(true);
  });
});

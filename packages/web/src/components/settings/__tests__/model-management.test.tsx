import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelManagementPanel } from "../model-management"
import { api, type ModelManagementStatus } from "@/lib/api"
vi.mock("@/lib/api", () => ({ api: { getModels: vi.fn(), modelAction: vi.fn() } }))
const status: ModelManagementStatus = {
  engines: [{ engine: "codex", current: "gpt-old", policy: { mode: "fixed", profile: "balanced" }, models: [{ id: "gpt-new-sol", label: "New Sol", effortLevels: ["medium"] }], checkedAt: "2026-09-24T00:00:00Z", error: null, candidate: "gpt-new-sol", previous: null }],
  pins: [{ kind: "cron", id: "news", name: "ニュース", engine: "codex", model: "astra", effective: "astra", remote: false }, { kind: "employee", id: "writer", name: "ライター", engine: "codex", model: null, effective: "gpt-old", remote: false }],
  notification: null, slackAdminConfigured: false,
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.getModels).mockResolvedValue(structuredClone(status)); vi.mocked(api.modelAction).mockResolvedValue(structuredClone(status)) })
afterEach(cleanup)
describe("Model management panel", () => {
  it("shows actual defaults, inheritance, administrator prerequisite, and updates policy explicitly", async () => {
    render(<ModelManagementPanel />)
    await screen.findByText("現在の既定：")
    expect(screen.getByText("既定を継承")).toBeDefined()
    expect(screen.getByText(/管理者Slack ID/)).toBeDefined()
    fireEvent.change(screen.getByLabelText("更新方針"), { target: { value: "auto" } })
    await waitFor(() => expect(api.modelAction).toHaveBeenCalledWith({ action: "policy", engine: "codex", policy: { mode: "auto", profile: "balanced" } }))
    expect(await screen.findByRole("status")).toBeDefined()
  })
  it("clears only selected pins, leaving unselected inherited entries alone", async () => {
    render(<ModelManagementPanel />)
    const checkbox = await screen.findByLabelText("ニュースを選択")
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole("button", { name: "選択した1件の固定を解除" }))
    await waitFor(() => expect(api.modelAction).toHaveBeenCalledTimes(1))
    expect(api.modelAction).toHaveBeenCalledWith({ action: "pin", kind: "cron", id: "news", model: null })
    expect(await screen.findByText("1件の固定を解除しました。")).toBeDefined()
  })
  it("shows failure without claiming a successful change", async () => {
    vi.mocked(api.modelAction).mockRejectedValue(new Error("モデル一覧を更新してください。"))
    render(<ModelManagementPanel />)
    fireEvent.click(await screen.findByRole("button", { name: "推奨モデルに切り替える" }))
    expect((await screen.findByRole("alert")).textContent).toContain("モデル一覧を更新")
    expect(screen.queryByRole("status")).toBeNull()
  })
})

it("selects a family without a version pin, changes depth, and enables fallback explicitly", async () => {
  const value = structuredClone(status);
  value.engines[0] = { ...value.engines[0], current: "gpt-new-sol", effort: "medium", families: [{ family: "sol", label: "Sol", model: "gpt-new-sol" }] };
  vi.mocked(api.getModels).mockResolvedValue(value);
  vi.mocked(api.modelAction).mockResolvedValue(value);
  render(<ModelManagementPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "codex Sol の最新版に追従" }));
  await waitFor(() => expect(api.modelAction).toHaveBeenLastCalledWith({ action: "policy", engine: "codex", policy: { mode: "auto", profile: "balanced", family: "sol" } }));
  await waitFor(() => expect(screen.getByRole("button", { name: "標準" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "標準" }));
  await waitFor(() => expect(api.modelAction).toHaveBeenLastCalledWith({ action: "default-effort", engine: "codex", effort: "medium" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "自動切替 OFF" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "自動切替 OFF" }));
  await waitFor(() => expect(api.modelAction).toHaveBeenLastCalledWith({ action: "fallback", enabled: true }));
  await waitFor(() => expect(screen.getByLabelText("ニュースのモデル").hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText("ニュースのモデル"), { target: { value: "family:sol" } });
  await waitFor(() => expect(api.modelAction).toHaveBeenLastCalledWith({ action: "follow", kind: "cron", id: "news", family: "sol" }));
});

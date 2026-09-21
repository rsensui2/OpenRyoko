import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import type { SlackTriageSettings } from "@/lib/triage-settings"
import { JevSettings } from "../jev-settings"

vi.mock("@/lib/api", () => ({ api: {
  getTypeSafeKeyStatus: vi.fn(), saveTypeSafeKey: vi.fn(),
  deleteTypeSafeKey: vi.fn(), testTypeSafeKey: vi.fn(),
} }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getTypeSafeKeyStatus).mockResolvedValue({ configured: true, source: "stored" })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Harness({ initial = {}, changed = vi.fn(), showCredentials = true }: {
  initial?: SlackTriageSettings
  changed?: (config: SlackTriageSettings) => void
  showCredentials?: boolean
}) {
  const [config, setConfig] = useState(initial)
  return <JevSettings config={config} showCredentials={showCredentials} onChange={(next) => { setConfig(next); changed(next) }} />
}

async function ready() {
  await waitFor(() => expect((screen.getByRole("option", { name: "Jev のみ" }) as HTMLOptionElement).disabled).toBe(false))
}

describe("JevSettings", () => {
  it("changes between all four modes and never silently enables CLI fallback", async () => {
    const changed = vi.fn()
    render(<Harness initial={{ enabled: true, engine: "claude", model: "haiku", jev: { model: "jev-1.13.0", fallback: "cli", timeoutMs: 2000 } }} changed={changed} />)
    await ready()
    expect(screen.getByLabelText("モデルのベンダー")).toBeDefined()
    fireEvent.change(screen.getByLabelText("判定方式"), { target: { value: "jev" } })
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ backend: "jev", engine: "claude", model: "haiku", jev: { model: "jev-1.13.0", fallback: "none", timeoutMs: 2000 } }))
    expect(screen.queryByLabelText("モデルのベンダー")).toBeNull()
    expect(screen.queryByLabelText("CLI パス（任意）")).toBeNull()
    expect(screen.getByText(/CLI は起動しません/)).toBeDefined()
    fireEvent.change(screen.getByLabelText("判定方式"), { target: { value: "jev-fallback" } })
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ backend: "jev", jev: expect.objectContaining({ fallback: "cli" }) }))
    expect(screen.getByText("再判定に使う CLI モデル")).toBeDefined()
    fireEvent.change(screen.getByLabelText("判定方式"), { target: { value: "jev-shadow" } })
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ backend: "jev-shadow" }))
    expect(screen.getByText("比較に使う CLI モデル")).toBeDefined()
    fireEvent.change(screen.getByLabelText("判定方式"), { target: { value: "cli" } })
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ backend: "cli" }))
  })

  it("requires a key before offering native modes and saves the secret separately from config", async () => {
    vi.mocked(api.getTypeSafeKeyStatus).mockResolvedValue({ configured: false, source: "none" })
    const changed = vi.fn()
    const storage = vi.spyOn(Storage.prototype, "setItem")
    render(<Harness changed={changed} />)
    await screen.findByText("TypeSafe API キー：未設定")
    expect((screen.getByRole("option", { name: "Jev のみ" }) as HTMLOptionElement).disabled).toBe(true)
    const input = screen.getByLabelText("API キー") as HTMLInputElement
    expect(input.type).toBe("password")
    expect(input.value).toBe("")
    fireEvent.change(input, { target: { value: "test-private-key" } })
    vi.mocked(api.saveTypeSafeKey).mockResolvedValue({ configured: true, source: "stored" })
    vi.mocked(api.getTypeSafeKeyStatus).mockResolvedValue({ configured: true, source: "stored" })
    fireEvent.click(screen.getByRole("button", { name: "API キーを保存" }))
    await screen.findByText("API キーを保存しました。")
    expect(api.saveTypeSafeKey).toHaveBeenCalledExactlyOnceWith("test-private-key")
    expect((screen.getByLabelText("新しい API キー") as HTMLInputElement).value).toBe("")
    expect(changed).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain("test-private-key")
    await ready()
  })

  it("shows a configured environment key without exposing it or offering to delete it", async () => {
    vi.mocked(api.getTypeSafeKeyStatus).mockResolvedValue({ configured: true, source: "environment" })
    render(<Harness initial={{ enabled: true, backend: "jev" }} />)
    await screen.findByText("TypeSafe API キー：環境変数で設定済み")
    expect((screen.getByLabelText("新しい API キー") as HTMLInputElement).value).toBe("")
    expect(screen.queryByRole("button", { name: "保存したキーを削除" })).toBeNull()
    expect(screen.queryByLabelText("モデルのベンダー")).toBeNull()
  })

  it("deletes only the stored credential and updates all rendered instances", async () => {
    render(<><Harness /><Harness showCredentials={false} /></>)
    await screen.findByText("TypeSafe API キー：保存済み")
    vi.mocked(api.deleteTypeSafeKey).mockResolvedValue({ configured: false, source: "none" })
    vi.mocked(api.getTypeSafeKeyStatus).mockResolvedValue({ configured: false, source: "none" })
    fireEvent.click(screen.getByRole("button", { name: "保存したキーを削除" }))
    await screen.findByText("保存した API キーを削除しました。")
    await waitFor(() => {
      for (const option of screen.getAllByRole("option", { name: "Jev のみ" })) expect((option as HTMLOptionElement).disabled).toBe(true)
    })
    expect(api.deleteTypeSafeKey).toHaveBeenCalledOnce()
  })

  it("tests the saved key without submitting the password draft", async () => {
    render(<Harness />)
    await ready()
    vi.mocked(api.testTypeSafeKey).mockResolvedValue({ ok: true, latencyMs: 123.4 })
    fireEvent.click(screen.getByRole("button", { name: "保存済みキーで接続テスト" }))
    await screen.findByText("接続を確認しました（123 ms）。")
    expect(api.testTypeSafeKey).toHaveBeenCalledExactlyOnceWith()
    fireEvent.change(screen.getByLabelText("新しい API キー"), { target: { value: "unsaved-key" } })
    expect((screen.getByRole("button", { name: "保存済みキーで接続テスト" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("clears submitted secrets and never renders arbitrary API error text", async () => {
    render(<Harness />)
    await ready()
    vi.mocked(api.saveTypeSafeKey).mockRejectedValue(new Error("private-key-in-error"))
    fireEvent.change(screen.getByLabelText("新しい API キー"), { target: { value: "private-key-in-error" } })
    fireEvent.click(screen.getByRole("button", { name: "API キーを保存" }))
    await screen.findByRole("alert")
    expect((screen.getByLabelText("新しい API キー") as HTMLInputElement).value).toBe("")
    expect(document.body.textContent).not.toContain("private-key-in-error")
    vi.mocked(api.testTypeSafeKey).mockResolvedValue({ ok: false, error: "private-key-in-error" as "network_error" })
    fireEvent.click(screen.getByRole("button", { name: "保存済みキーで接続テスト" }))
    await screen.findByText("接続を確認できませんでした。")
    expect(document.body.textContent).not.toContain("private-key-in-error")
  })

  it("lets the user disable an existing Jev config even when the key is missing", async () => {
    vi.mocked(api.getTypeSafeKeyStatus).mockResolvedValue({ configured: false, source: "none" })
    const changed = vi.fn()
    render(<Harness initial={{ enabled: true, backend: "jev" }} changed={changed} />)
    await screen.findByText("TypeSafe API キー：未設定")
    fireEvent.click(screen.getByRole("switch", { name: "空気読みを有効化" }))
    expect(changed).toHaveBeenLastCalledWith({ enabled: false, backend: "jev" })
  })
})

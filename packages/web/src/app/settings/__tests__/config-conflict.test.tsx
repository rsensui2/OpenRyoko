import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* The Settings form saves the whole document it loaded. These tests drive it
 * the way an operator does while config.yaml changes behind the page: the save
 * carries the revision the form was loaded from, a refused save overwrites
 * nothing and says why, and the page's own immediate saves (branding, voice
 * languages) do not turn the next "save" into a conflict with itself. */

const mocks = vi.hoisted(() => ({
  getOrg: vi.fn(), getConfigWithRevision: vi.fn(), updateConfigAtRevision: vi.fn(),
  completeOnboarding: vi.fn(), sttStatus: vi.fn(), sttUpdateConfig: vi.fn(), sttDownload: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: mocks }))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock("@/app/providers", () => ({ useTheme: () => ({ theme: "ryoko", setTheme: () => {} }) }))
vi.mock("@/app/settings-provider", () => {
  const value = {
    settings: { accentColor: null, portalName: "Ryoko", portalSubtitle: null, portalEmoji: null, operatorName: null, language: "Japanese" },
    setAccentColor: () => {}, setPortalName: () => {}, setPortalSubtitle: () => {}, setOperatorName: () => {},
    setPortalEmoji: () => {}, setLanguage: () => {}, resetAll: () => {},
  }
  return { useSettings: () => value }
})
vi.mock("@/components/ui/emoji-picker", () => ({ EmojiPicker: () => null }))
vi.mock("@/components/settings/model-selector", () => ({ ModelSelector: () => null }))
vi.mock("@/components/settings/jev-settings", () => ({ JevSettings: () => null }))
vi.mock("@/components/settings/update-notification-settings", () => ({ UpdateNotificationSettings: () => null }))

import { ConfigConflictError } from "@/lib/api"
import SettingsPage from "../page"

function document(overrides: Record<string, unknown> = {}) {
  return {
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5-5" }, codex: { bin: "codex", model: "gpt-6-sol" } },
    connectors: {},
    logging: { level: "info", stdout: true, file: true },
    portal: { portalName: "Ryoko" },
    stt: { enabled: true, languages: ["en", "ja"] },
    ...overrides,
  }
}

const hostInput = () => screen.getByPlaceholderText("127.0.0.1") as HTMLInputElement
const save = () => fireEvent.click(screen.getByRole("button", { name: "設定を保存" }))
const lastSave = () => mocks.updateConfigAtRevision.mock.calls.at(-1) as [Record<string, any>, string | null]

async function renderLoaded() {
  render(<SettingsPage />)
  await waitFor(() => expect(hostInput().value).toBe("127.0.0.1"))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getOrg.mockResolvedValue({ employees: [] })
  mocks.sttStatus.mockResolvedValue({ available: true, model: "small", downloading: false, progress: 0, languages: ["en", "ja"] })
  mocks.sttUpdateConfig.mockResolvedValue({ status: "ok", languages: ["en"] })
  mocks.completeOnboarding.mockResolvedValue({ status: "ok", portal: {} })
  mocks.getConfigWithRevision.mockResolvedValue({ config: document(), revision: "rev-1" })
  mocks.updateConfigAtRevision.mockResolvedValue({ result: { status: "ok" }, revision: "rev-2" })
})

afterEach(() => cleanup())

describe("Settings save and the config revision", () => {
  it("saves with the revision the form was loaded from, then with the one its own save produced", async () => {
    await renderLoaded()

    fireEvent.change(hostInput(), { target: { value: "0.0.0.0" } })
    save()
    await screen.findByText("Settings saved successfully")
    expect(lastSave()[0].gateway.host).toBe("0.0.0.0")
    expect(lastSave()[1]).toBe("rev-1")

    mocks.updateConfigAtRevision.mockResolvedValue({ result: { status: "ok" }, revision: "rev-3" })
    fireEvent.change(hostInput(), { target: { value: "127.0.0.1" } })
    save()
    await waitFor(() => expect(mocks.updateConfigAtRevision).toHaveBeenCalledTimes(2))
    expect(lastSave()[1]).toBe("rev-2") // not stale against its own write
  })

  it("does not overwrite on a conflict: it says the file changed and reloads only when asked", async () => {
    mocks.updateConfigAtRevision.mockRejectedValue(new ConfigConflictError())
    await renderLoaded()
    fireEvent.change(hostInput(), { target: { value: "0.0.0.0" } })
    save()

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("config.yaml")
    expect(alert.textContent).toContain("保存していません")
    // Nothing was reloaded behind the operator's back, and nothing retried.
    expect(mocks.getConfigWithRevision).toHaveBeenCalledTimes(1)
    expect(mocks.updateConfigAtRevision).toHaveBeenCalledTimes(1)
    expect(hostInput().value).toBe("0.0.0.0")

    // The file as somebody else left it.
    mocks.getConfigWithRevision.mockResolvedValue({ config: document({ gateway: { port: 7777, host: "10.0.0.5" } }), revision: "rev-9" })
    fireEvent.click(within(alert).getByRole("button", { name: /再読み込み/ }))

    await waitFor(() => expect(hostInput().value).toBe("10.0.0.5"))
    expect(screen.queryByRole("alert")).toBeNull()

    mocks.updateConfigAtRevision.mockResolvedValue({ result: { status: "ok" }, revision: "rev-10" })
    fireEvent.change(hostInput(), { target: { value: "0.0.0.0" } })
    save()
    await screen.findByText("Settings saved successfully")
    expect(lastSave()[1]).toBe("rev-9")
  })

  it("keeps reporting every other failure as before, without a reload prompt", async () => {
    mocks.updateConfigAtRevision.mockRejectedValue(new Error("Unknown config keys: nope"))
    await renderLoaded()
    save()

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Failed to save: Unknown config keys: nope")
    expect(within(alert).queryByRole("button")).toBeNull()
  })

  it("follows its own branding save: unsaved edits stay, the new revision and the saved name are adopted", async () => {
    await renderLoaded()
    fireEvent.change(hostInput(), { target: { value: "0.0.0.0" } }) // not saved yet

    // Portal Name is written immediately on blur, through another endpoint.
    mocks.getConfigWithRevision.mockResolvedValue({ config: document({ portal: { portalName: "Momo", onboarded: true } }), revision: "rev-2" })
    const portalName = screen.getByPlaceholderText("Jinn")
    fireEvent.change(portalName, { target: { value: "Momo" } })
    fireEvent.blur(portalName)
    await waitFor(() => expect(mocks.getConfigWithRevision).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(hostInput().value).toBe("0.0.0.0"))

    mocks.updateConfigAtRevision.mockResolvedValue({ result: { status: "ok" }, revision: "rev-3" })
    save()
    await screen.findByText("Settings saved successfully")
    const [saved, revision] = lastSave()
    expect(revision).toBe("rev-2")
    expect(saved.gateway.host).toBe("0.0.0.0")
    // The whole-document save must not put the previous name back.
    expect(saved.portal).toEqual({ portalName: "Momo", onboarded: true })
  })

  it("follows its own voice-language save the same way", async () => {
    await renderLoaded()
    fireEvent.change(hostInput(), { target: { value: "0.0.0.0" } })

    mocks.getConfigWithRevision.mockResolvedValue({ config: document({ stt: { enabled: true, languages: ["en"] } }), revision: "rev-2" })
    fireEvent.click(await screen.findByRole("button", { name: "Remove Japanese" }))
    await waitFor(() => expect(mocks.sttUpdateConfig).toHaveBeenCalledWith(["en"]))
    await waitFor(() => expect(mocks.getConfigWithRevision).toHaveBeenCalledTimes(2))

    save()
    await screen.findByText("Settings saved successfully")
    const [saved, revision] = lastSave()
    expect(revision).toBe("rev-2")
    expect(saved.gateway.host).toBe("0.0.0.0")
    expect(saved.stt).toEqual({ enabled: true, languages: ["en"] })
  })

  it("does not swap the form for a spinner while it follows such a save", async () => {
    await renderLoaded()
    let release!: (value: unknown) => void
    mocks.getConfigWithRevision.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const portalName = screen.getByPlaceholderText("Jinn")
    fireEvent.change(portalName, { target: { value: "Momo" } })
    fireEvent.blur(portalName)
    await waitFor(() => expect(mocks.getConfigWithRevision).toHaveBeenCalledTimes(2))

    // The operator may be typing in another field right now.
    expect(screen.queryByText("Loading gateway config...")).toBeNull()
    expect(hostInput()).toBeDefined()
    release({ config: document(), revision: "rev-2" })
  })
})

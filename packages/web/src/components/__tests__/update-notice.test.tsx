import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { getUpdateStatus } = vi.hoisted(() => ({ getUpdateStatus: vi.fn() }))
vi.mock("@/lib/api", () => ({ api: { getUpdateStatus } }))

import { UpdateNotice } from "../update-notice"

const availableUpdate = {
  currentVersion: "2026.8.18",
  latestVersion: "2026.8.19",
  updateAvailable: true,
  checkedAt: "2026-08-18T00:00:00.000Z",
  releaseUrl: "https://github.com/rsensui2/OpenRyoko/releases/tag/v2026.8.19",
  stale: false,
}

describe("UpdateNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it("shows the verified version, update command, and official release link", async () => {
    getUpdateStatus.mockResolvedValue(availableUpdate)
    render(<UpdateNotice />)

    expect((await screen.findByRole("status")).textContent).toContain("OpenRyoko 2026.8.19 が利用できます")
    expect(screen.getByText("ryoko update --restart")).toBeDefined()
    expect((screen.getByRole("link", { name: /何ができるようになったかを見る/ }) as HTMLAnchorElement).href)
      .toBe(availableUpdate.releaseUrl)
  })

  it("stays hidden when the installed version is current", async () => {
    getUpdateStatus.mockResolvedValue({ ...availableUpdate, latestVersion: "2026.8.18", updateAvailable: false })
    render(<UpdateNotice />)

    await waitFor(() => expect(getUpdateStatus).toHaveBeenCalledOnce())
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("can be dismissed for the specific release", async () => {
    getUpdateStatus.mockResolvedValue(availableUpdate)
    render(<UpdateNotice />)

    const close = await screen.findByRole("button", { name: /2026\.8\.19 の更新通知を閉じる/ })
    fireEvent.click(close)

    expect(screen.queryByRole("status")).toBeNull()
    expect(localStorage.getItem("openryoko-update-dismissed:2026.8.19")).toBe("1")
  })
})

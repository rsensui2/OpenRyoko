import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getCronJobs, updateCronJob, runMaintenance } = vi.hoisted(() => ({ getCronJobs: vi.fn(), updateCronJob: vi.fn(), runMaintenance: vi.fn() }))
vi.mock("@/lib/api", () => ({ api: { getCronJobs, updateCronJob, runMaintenance } }))
import { UpdateNotificationSettings } from "../update-notification-settings"

const job = { id: "update", name: "Update", kind: "update-notification", enabled: true, schedule: "0 9 * * *", timezone: "Asia/Tokyo", delivery: { connector: "slack", channel: "C1" } }
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  getCronJobs.mockResolvedValue([job])
  updateCronJob.mockImplementation(async (_id, data) => data)
  runMaintenance.mockResolvedValue({ status: "started" })
})

describe("update maintenance settings", () => {
  it("defaults an existing notification job to review and saves an explicit apply choice", async () => {
    render(<UpdateNotificationSettings connectorOptions={["slack"]} />)
    const mode = await screen.findByRole("combobox", { name: "導入済み機能に合わせた運用点検" })
    expect((mode as HTMLSelectElement).value).toBe("review")
    fireEvent.change(mode, { target: { value: "apply" } })
    fireEvent.click(screen.getByRole("button", { name: "通知設定を保存" }))
    await waitFor(() => expect(updateCronJob).toHaveBeenCalledWith("update", expect.objectContaining({ maintenance: { mode: "apply" }, delivery: job.delivery })))
  })

  it("uses read-only review for the manual inspection button even when automatic apply is configured", async () => {
    getCronJobs.mockResolvedValue([{ ...job, maintenance: { mode: "apply" } }])
    render(<UpdateNotificationSettings connectorOptions={["slack"]} />)
    fireEvent.click(await screen.findByRole("button", { name: "点検を実行" }))
    await waitFor(() => expect(runMaintenance).toHaveBeenCalledWith("update", "review"))
    expect(updateCronJob).not.toHaveBeenCalled()
  })

  it("preserves a disabled maintenance preference when editing the update schedule", async () => {
    getCronJobs.mockResolvedValue([{ ...job, maintenance: { mode: "off" } }])
    render(<UpdateNotificationSettings connectorOptions={["slack"]} />)
    const mode = await screen.findByRole("combobox", { name: "導入済み機能に合わせた運用点検" })
    expect((mode as HTMLSelectElement).value).toBe("off")
    fireEvent.click(screen.getByRole("button", { name: "通知設定を保存" }))
    await waitFor(() => expect(updateCronJob).toHaveBeenCalledWith("update", expect.objectContaining({ maintenance: { mode: "off" } })))
  })
})

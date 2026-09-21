import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const listeners = new Set<(event: string, payload: unknown) => void>()
  return {
    getCronJobs: vi.fn(), getCronStatus: vi.fn(), getOrg: vi.fn(), getCronRuns: vi.fn(),
    updateCronJob: vi.fn(), triggerCronJob: vi.fn(), listeners,
    subscribe: vi.fn((listener: (event: string, payload: unknown) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
  }
})

vi.mock("@/lib/api", () => ({ api: mocks }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ subscribe: mocks.subscribe }) }))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
  ToolbarActions: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/crons/weekly-schedule", () => ({ WeeklySchedule: () => null }))
vi.mock("@/components/crons/pipeline-graph", () => ({ PipelineGraph: () => null }))
vi.mock("@/components/crons/workflows-section", () => ({ WorkflowsSection: () => null }))
vi.mock("@/components/ui/employee-avatar", () => ({ EmployeeAvatar: () => null }))

import CronPage from "../page"

const job = {
  id: "daily-report", name: "Daily report", schedule: "0 9 * * *", enabled: true,
  scheduler: { state: "scheduled", registered: true },
}
const status = {
  running: true, registeredJobIds: [job.id], lastReloadAt: "2026-09-21T01:00:00.000Z",
  storage: { readable: true }, pendingJobIds: [], orphanedJobIds: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.getOrg.mockResolvedValue({ employees: [] })
  mocks.getCronRuns.mockResolvedValue([])
  mocks.getCronJobs.mockResolvedValue([job])
  mocks.getCronStatus.mockResolvedValue(status)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("Cron scheduler visibility", () => {
  it("distinguishes enabled configuration from pending or failed registration", async () => {
    mocks.getCronJobs.mockResolvedValue([
      { ...job, scheduler: { state: "pending", registered: false } },
      { ...job, id: "invalid", name: "Invalid schedule", scheduler: { state: "error", registered: false, error: "Invalid timezone" } },
    ])
    mocks.getCronStatus.mockResolvedValue({ ...status, registeredJobIds: [], pendingJobIds: [job.id] })
    render(<CronPage />)

    expect(await screen.findByText("登録待ち")).toBeDefined()
    expect(screen.getByText("登録エラー・未登録")).toBeDefined()
    expect(screen.getByText("Invalid timezone")).toBeDefined()
    expect(screen.queryByText("登録済み")).toBeNull()
    expect(screen.getAllByRole("button", { name: "Disable job" }).every((toggle) => toggle.getAttribute("aria-pressed") === "true")).toBe(true)
    expect(screen.getByText(/定期実行登録: 0 件/)).toBeDefined()
  })

  it("loads scheduler diagnostics even if the first job-list request fails", async () => {
    mocks.getCronJobs.mockRejectedValue(new Error("Malformed jobs.json"))
    mocks.getCronStatus.mockResolvedValue({
      ...status, running: false, storage: { readable: false, error: "Invalid JSON" }, orphanedJobIds: ["removed-job"],
    })
    render(<CronPage />)

    expect(await screen.findByText(/一覧の読み込みに失敗しました: Malformed jobs.json/)).toBeDefined()
    expect(await screen.findByText(/スケジューラーが停止しています/)).toBeDefined()
    expect(screen.getByText(/ジョブ設定を読み取れません/).textContent).toContain("Invalid JSON")
    expect(screen.getByText(/現在の設定にないジョブの登録が残っています/).textContent).toContain("removed-job")
    expect(screen.queryByText("No cron jobs configured")).toBeNull()
    expect(mocks.getCronStatus).toHaveBeenCalledOnce()
  })

  it("retains the last good list, visibly marks it stale, and clears the warning after recovery", async () => {
    render(<CronPage />)
    expect(await screen.findByText("Daily report")).toBeDefined()
    mocks.getCronJobs.mockRejectedValue(new Error("File is unreadable"))
    mocks.getCronStatus.mockResolvedValue({ ...status, storage: { readable: false } })
    fireEvent.click(screen.getByRole("button", { name: "Refresh cron data" }))

    expect(await screen.findByText(/前回取得した一覧を表示しています/)).toBeDefined()
    expect(screen.getByText("Daily report")).toBeDefined()
    expect(screen.getByText("前回: 登録済み").style.color).toBe("var(--text-tertiary)")
    expect(screen.queryByText("登録済み")).toBeNull()

    mocks.getCronJobs.mockResolvedValue([job])
    mocks.getCronStatus.mockResolvedValue(status)
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }))
    await waitFor(() => expect(screen.queryByText(/前回取得した一覧を表示しています/)).toBeNull())
    expect(screen.getByText("登録済み")).toBeDefined()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("keeps a successful job list when the independent status request fails", async () => {
    mocks.getCronStatus.mockRejectedValue(new Error("Status unavailable"))
    render(<CronPage />)

    expect(await screen.findByText("Daily report")).toBeDefined()
    expect(await screen.findByText(/スケジューラーの稼働状態を取得できません: Status unavailable/)).toBeDefined()
    expect(screen.getByText("登録済み")).toBeDefined()
    expect(screen.queryByText(/一覧の読み込みに失敗しました/)).toBeNull()
  })

  it("refreshes actual registration after cron:reloaded and after a configuration toggle", async () => {
    mocks.getCronJobs.mockResolvedValue([{ ...job, enabled: false, scheduler: { state: "disabled", registered: false } }])
    render(<CronPage />)
    expect(await screen.findByText("無効・未登録")).toBeDefined()
    mocks.updateCronJob.mockResolvedValue({ ...job, scheduler: { state: "pending", registered: false } })
    mocks.getCronJobs.mockResolvedValue([{ ...job, scheduler: { state: "pending", registered: false } }])
    fireEvent.click(screen.getByRole("button", { name: "Enable job" }))
    expect(await screen.findByText("登録待ち")).toBeDefined()
    expect(mocks.updateCronJob).toHaveBeenCalledWith(job.id, { enabled: true })
    expect(screen.queryByText("登録済み")).toBeNull()

    mocks.getCronJobs.mockResolvedValue([job])
    act(() => { for (const listener of mocks.listeners) listener("cron:reloaded", {}) })
    expect(await screen.findByText("登録済み")).toBeDefined()
    expect(mocks.getCronStatus).toHaveBeenCalledTimes(3)
  })

  it("polls within 30 seconds and stops polling and event subscriptions on unmount", async () => {
    vi.useFakeTimers()
    const view = render(<CronPage />)
    await act(async () => { await Promise.resolve() })
    expect(mocks.getCronStatus).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(mocks.getCronStatus).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(mocks.listeners.size).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(mocks.getCronStatus).toHaveBeenCalledTimes(2)
  })
})

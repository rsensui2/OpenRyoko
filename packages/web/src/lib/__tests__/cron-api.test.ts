import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api"

afterEach(() => vi.unstubAllGlobals())

describe("cron run history API client", () => {
  it("asks for the newest N runs only when a limit is given", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([]))
    vi.stubGlobal("fetch", request)
    await api.getCronRuns("daily-report")
    await api.getCronRuns("daily-report", 5)
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringMatching(/\/api\/cron\/daily-report\/runs$/),
      expect.stringMatching(/\/api\/cron\/daily-report\/runs\?limit=5$/),
    ])
  })
})

import { describe, expect, it } from "vitest"
import { newestRuns } from "../cron-utils"

describe("newestRuns", () => {
  // The gateway returns a job's runs oldest first (the log is append-only).
  const history = [1, 2, 3, 4, 5, 6, 7]

  it("returns the newest runs, newest first", () => {
    expect(newestRuns(history, 5)).toEqual([7, 6, 5, 4, 3])
    expect(newestRuns(history, 1)).toEqual([7])
  })

  it("returns the whole history newest first when it is shorter than the count", () => {
    expect(newestRuns([1, 2], 5)).toEqual([2, 1])
  })

  it("is empty for an empty history or a non-positive count", () => {
    expect(newestRuns([], 5)).toEqual([])
    expect(newestRuns(history, 0)).toEqual([])
    expect(newestRuns(history, -1)).toEqual([])
  })

  it("leaves the history it was given untouched", () => {
    const runs = [...history]
    newestRuns(runs, 3)
    expect(runs).toEqual(history)
  })
})

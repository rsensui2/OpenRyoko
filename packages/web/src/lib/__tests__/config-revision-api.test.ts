import { afterEach, describe, expect, it, vi } from "vitest"
import { api, ConfigConflictError } from "../api"

afterEach(() => vi.unstubAllGlobals())

const REVISION_HEADER = "X-Config-Revision"

function jsonResponse(body: unknown, init: { status?: number; revision?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.revision !== undefined ? { [REVISION_HEADER]: init.revision } : {}) },
  })
}

function sentHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers)
}

describe("config revision API client", () => {
  it("reads the config together with the revision of the file it came from", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ gateway: { port: 7777 } }, { revision: "rev-1" }))
    vi.stubGlobal("fetch", request)

    await expect(api.getConfigWithRevision()).resolves.toEqual({ config: { gateway: { port: 7777 } }, revision: "rev-1" })
    expect(String(request.mock.calls[0][0])).toMatch(/\/api\/config$/)
  })

  it("reports no revision when the gateway does not send one (an older gateway)", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ gateway: {} })))
    await expect(api.getConfigWithRevision()).resolves.toEqual({ config: { gateway: {} }, revision: null })
  })

  it("sends the revision it was given back with the save, and returns the one the save produced", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok" }, { revision: "rev-2" }))
    vi.stubGlobal("fetch", request)

    const saved = await api.updateConfigAtRevision({ logging: { level: "debug" } }, "rev-1")

    expect(saved).toEqual({ result: { status: "ok" }, revision: "rev-2" })
    const [url, init] = request.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/config$/)
    expect(init?.method).toBe("PUT")
    expect(sentHeaders(init).get(REVISION_HEADER)).toBe("rev-1")
    expect(init?.body).toBe(JSON.stringify({ logging: { level: "debug" } }))
  })

  it("sends no revision header when it has none, so the save behaves as it always did", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok" }))
    vi.stubGlobal("fetch", request)

    const saved = await api.updateConfigAtRevision({ logging: { level: "debug" } }, null)

    expect(saved.revision).toBeNull()
    expect(sentHeaders(request.mock.calls[0][1]).has(REVISION_HEADER)).toBe(false)
  })

  it("turns a 409 into a ConfigConflictError the page can tell apart from other failures", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: "config.yaml changed on disk", code: "CONFIG_CONFLICT" }, { status: 409 }),
    ))
    await expect(api.updateConfigAtRevision({}, "rev-1")).rejects.toBeInstanceOf(ConfigConflictError)
  })

  it("keeps reporting every other failure with the gateway's message", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "Unknown config keys: nope" }, { status: 400 })))
    const failure = await api.updateConfigAtRevision({}, "rev-1").catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(ConfigConflictError)
    expect((failure as Error).message).toBe("Unknown config keys: nope")
  })
})

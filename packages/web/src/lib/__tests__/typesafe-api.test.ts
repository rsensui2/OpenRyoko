import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api"

afterEach(() => vi.unstubAllGlobals())

describe("TypeSafe credential API client", () => {
  it("sends credentials only in the authenticated PUT body and disables caching", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ configured: true, source: "stored" }))
    vi.stubGlobal("fetch", request)
    await api.getTypeSafeKeyStatus()
    await api.saveTypeSafeKey("test-secret")
    await api.testTypeSafeKey()
    await api.deleteTypeSafeKey()
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringMatching(/\/api\/integrations\/typesafe$/), expect.stringMatching(/\/api\/integrations\/typesafe$/),
      expect.stringMatching(/\/api\/integrations\/typesafe\/test$/), expect.stringMatching(/\/api\/integrations\/typesafe$/),
    ])
    for (const [, init] of request.mock.calls) expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" })
    expect(request.mock.calls[1][1]).toMatchObject({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "test-secret" }) })
    for (const index of [0, 2, 3]) expect(request.mock.calls[index][1]?.body).toBeUndefined()
  })

  it("does not expose HTTP error bodies that could contain credential material", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "private-key" }), { status: 500 })))
    await expect(api.saveTypeSafeKey("private-key")).rejects.toThrow("TypeSafe request failed")
  })
})

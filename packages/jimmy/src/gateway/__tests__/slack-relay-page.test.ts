import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { newOAuthState } from "../slack-provision/provision-store.js";

/* The static relay page (site/slack/callback) must read back exactly the
 * gateway address the gateway put in the state, forward nothing else, and
 * only skip the confirmation click for addresses on the person's own network. */

interface RelayModule {
  relayTarget(search: string): { url: string; origin: string; nearby: boolean } | null;
  isNearbyHost(hostname: string): boolean;
}

const relayPath = path.resolve(import.meta.dirname, "../../../../../site/slack/callback/relay.js");
const load = async (): Promise<RelayModule> => (await import(pathToFileURL(relayPath).href)) as RelayModule;

describe("Slack relay page", () => {
  it("forwards code and state to the gateway address the gateway encoded", async () => {
    const { relayTarget } = await load();
    const { value } = newOAuthState(Date.now(), "http://127.0.0.1:17777");
    const target = relayTarget(`?code=CODE&state=${encodeURIComponent(value)}&extra=drop`)!;
    expect(target.origin).toBe("http://127.0.0.1:17777");
    expect(target.nearby).toBe(true);
    const forwarded = new URL(target.url);
    expect(forwarded.pathname).toBe("/api/onboarding/slack/oauth/callback");
    expect(Object.fromEntries(forwarded.searchParams)).toEqual({ code: "CODE", state: value });
  });

  it("passes a refusal through so the gateway can say so", async () => {
    const { relayTarget } = await load();
    const { value } = newOAuthState(Date.now(), "http://192.168.1.20:7777");
    const forwarded = new URL(relayTarget(`?error=access_denied&state=${encodeURIComponent(value)}`)!.url);
    expect(forwarded.searchParams.get("error")).toBe("access_denied");
  });

  it("refuses states without an address or with a non-web one", async () => {
    const { relayTarget } = await load();
    expect(relayTarget("?code=C&state=plainnonce")).toBeNull();
    const js = Buffer.from("javascript:alert(1)").toString("base64url");
    expect(relayTarget(`?code=C&state=n.${js}`)).toBeNull();
  });

  it.each([
    ["localhost", true], ["127.0.0.1", true], ["[::1]", true], ["10.0.0.5", true], ["172.20.1.1", true],
    ["192.168.0.10", true], ["100.64.0.1", true],
    ["ryoko.tail1234.ts.net", false], ["mac.local", false], ["app.localhost", false],
    ["example.com", false], ["172.32.0.1", false], ["8.8.8.8", false], ["localhost.evil.com", false],
  ])("treats %s as nearby: %s", async (host, nearby) => {
    const { isNearbyHost } = await load();
    expect(isNearbyHost(host)).toBe(nearby);
  });
});

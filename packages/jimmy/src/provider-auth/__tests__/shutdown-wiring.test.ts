import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * startGateway has no test harness, so the one line that matters here is
 * pinned by reading it: gateway cleanup must end provider logins before its
 * first slow step. The forced exit fires five seconds into shutdown; a login
 * stopped later than that is never stopped, and its link stays in the DM.
 *
 * If this fails after a merge or a refactor of the cleanup function, the
 * markers below moved — re-check the order by hand, then update them.
 */
const serverSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "gateway", "server.ts"),
  "utf8",
);

describe("gateway cleanup", () => {
  it("ends provider logins first, before anything it has to wait for", () => {
    const cleanupStart = serverSource.indexOf("// Return cleanup function");
    expect(cleanupStart, "cleanup function marker").toBeGreaterThan(-1);
    const cleanup = serverSource.slice(cleanupStart);

    const stopLogins = cleanup.indexOf("await stopProviderAuth()");
    const firstOtherAwait = cleanup.replace("await stopProviderAuth()", " ".repeat("await stopProviderAuth()".length)).indexOf("await ");
    expect(stopLogins, "stopProviderAuth() call in cleanup").toBeGreaterThan(-1);
    expect(firstOtherAwait, "another awaited step in cleanup").toBeGreaterThan(-1);
    expect(stopLogins).toBeLessThan(firstOtherAwait);
  });

  it("imports the shutdown hook from the provider-auth module", () => {
    expect(serverSource).toMatch(/import \{[^}]*\bstopProviderAuth\b[^}]*\} from "\.\.\/provider-auth\/index\.js";/);
  });
});

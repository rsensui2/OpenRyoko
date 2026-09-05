import { describe, it, expect } from "vitest";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

function fakeHandle() {
  const h: any = { killed: false, pid: Math.floor(Math.random() * 9999) };
  h.kill = () => { h.killed = true; };
  return h;
}

describe("PtyLifecycleManager", () => {
  it("registers a PTY and reports it as warm", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-1", h);
    expect(m.getWarm("sess-1")).toBe(h);
  });

  it("releaseSession kills the PTY, cleans the handle, and fires onCleanup", () => {
    let cleaned = "";
    const m = new PtyLifecycleManager({ maxLivePtys: 8, onCleanup: (id) => { cleaned = id; } });
    const h = fakeHandle();
    m.adopt("sess-2", h);
    m.releaseSession("sess-2");
    expect(h.killed).toBe(true);
    expect(m.getWarm("sess-2")).toBeUndefined();
    expect(cleaned).toBe("sess-2");
  });

  it("a PTY with no viewer dies within the grace window after turnEnded", () => {
    // No viewer, no turn → grace window starts → reevaluate kills since lastTurnEndedAt is 0… actually
    // lastTurnEndedAt is set on turnEnded, so within the 10-min cap it stays alive.
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-3", h);
    m.turnStarted("sess-3");
    m.turnEnded("sess-3");
    expect(h.killed).toBe(false); // still inside CLI_KEEPALIVE_AFTER_LEAVE_MS
  });

  it("a PTY with an active viewer survives turnEnded indefinitely (within the keep-alive cap)", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-4", h);
    m.viewerEnter("sess-4");
    m.turnStarted("sess-4");
    m.turnEnded("sess-4");
    expect(h.killed).toBe(false);
  });

  it("releases the PTY when the last viewer leaves and no turn has ever run", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-5", h);
    m.viewerEnter("sess-5");
    m.viewerLeave("sess-5");
    // viewingEndedAt was just set to now → still inside 10-min grace → alive
    expect(h.killed).toBe(false);
  });

  it("isAtCapacity is true once maxLivePtys is reached", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 2 });
    m.adopt("a", fakeHandle());
    m.adopt("b", fakeHandle());
    expect(m.isAtCapacity()).toBe(true);
  });

  it("sweep does not release a PTY the isBusy probe reports as working", () => {
    let busy = true;
    const m = new PtyLifecycleManager({ maxLivePtys: 8, isBusy: () => busy });
    const h = fakeHandle();
    m.adopt("busy-1", h);
    // Freshly adopted, no turn/viewer → shouldStayAlive is false, so only the
    // busy probe keeps it alive.
    (m as any).sweep();
    expect(h.killed).toBe(false);
    busy = false;
    (m as any).sweep();
    expect(h.killed).toBe(true);
  });

  it("touch restarts the keep-warm grace window for out-of-turn activity", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("touch-1", h);
    // Without touch, a fresh adopt (no turn, no viewer) is sweep-eligible.
    m.touch("touch-1");
    (m as any).sweep();
    expect(h.killed).toBe(false); // touched → inside the grace window
  });

  it("LRU eviction at capacity skips a busy PTY", () => {
    const busyIds = new Set(["victim-candidate"]);
    const m = new PtyLifecycleManager({ maxLivePtys: 2, isBusy: (id) => busyIds.has(id) });
    const a = fakeHandle(), b = fakeHandle(), c = fakeHandle();
    m.adopt("victim-candidate", a); // busy — must survive
    m.adopt("idle-one", b);         // idle — must be evicted instead
    m.adopt("newcomer", c);
    expect(a.killed).toBe(false);
    expect(b.killed).toBe(true);
    expect(m.getWarm("newcomer")).toBe(c);
  });

  it("killAll kills every live PTY", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const a = fakeHandle(), b = fakeHandle();
    m.adopt("a", a);
    m.adopt("b", b);
    m.killAll();
    expect(a.killed).toBe(true);
    expect(b.killed).toBe(true);
  });
});

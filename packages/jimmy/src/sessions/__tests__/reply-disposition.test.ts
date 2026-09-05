import { describe, it, expect } from "vitest";
import {
  parseDisposition,
  normalizeDelivery,
  normalizeTurns,
  SAFE_ACK,
  type DeliveryContext,
} from "../reply-disposition.js";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function sentinel(obj: unknown): string {
  return `<!--RYOKO-DISPOSITION:v1:${b64url(obj)}-->`;
}

const EXTERNAL: DeliveryContext = { addressed: true, channelExternal: true, isDM: false, canReact: true };
const INTERNAL_CH: DeliveryContext = { addressed: true, channelExternal: false, isDM: false, canReact: true };
const DM: DeliveryContext = { addressed: true, channelExternal: false, isDM: true, canReact: true };
const NO_REACT: DeliveryContext = { addressed: true, channelExternal: true, isDM: false, canReact: false };
const UNADDRESSED: DeliveryContext = { addressed: false, channelExternal: true, isDM: false, canReact: true };

describe("parseDisposition", () => {
  it("no sentinel → whole text is public", () => {
    const p = parseDisposition("just a normal reply");
    expect(p.hadSentinel).toBe(false);
    expect(p.publicText).toBe("just a normal reply");
    expect(p.payload).toEqual({});
  });

  it("splits public body from sentinel payload", () => {
    const text = `荒木さん、確認して折り返します。\n\n${sentinel({ internal: "録画が未アップ", react: ":eyes:" })}`;
    const p = parseDisposition(text);
    expect(p.hadSentinel).toBe(true);
    expect(p.decodeError).toBe(false);
    expect(p.publicText).toBe("荒木さん、確認して折り返します。");
    expect(p.payload.internal).toBe("録画が未アップ");
    expect(p.payload.react).toBe(":eyes:");
  });

  it("fail-closed: malformed payload is still recognized as sentinel and stripped", () => {
    const text = `public part\n\n<!--RYOKO-DISPOSITION:v1:@@@notbase64@@@-->`;
    const p = parseDisposition(text);
    expect(p.hadSentinel).toBe(true);
    expect(p.decodeError).toBe(true);
    expect(p.publicText).toBe("public part");
    // The marker line must never survive into the public body.
    expect(p.publicText).not.toContain("RYOKO-DISPOSITION");
    expect(p.payload.internal).toBeUndefined();
  });

  it("fail-closed: base64 with padding still strips the sentinel (no whole-text restore)", () => {
    // Standard base64 padding "=" must not break sentinel recognition.
    const text = `public part\n\n<!--RYOKO-DISPOSITION:v1:YWJjZA==-->`;
    const p = parseDisposition(text);
    expect(p.hadSentinel).toBe(true);
    expect(p.publicText).toBe("public part");
    expect(p.publicText).not.toContain("RYOKO-DISPOSITION");
  });

  it("fail-closed: valid base64url of non-JSON drops sentinel, no internal", () => {
    const bad = Buffer.from("not json{{{").toString("base64url");
    const text = `public part\n\n<!--RYOKO-DISPOSITION:v1:${bad}-->`;
    const p = parseDisposition(text);
    expect(p.hadSentinel).toBe(true);
    expect(p.decodeError).toBe(true);
    expect(p.publicText).toBe("public part");
    expect(p.payload.internal).toBeUndefined();
  });

  it("does not match a sentinel that is not on the last non-empty line", () => {
    const text = `${sentinel({ internal: "x" })}\n\nreal reply below`;
    const p = parseDisposition(text);
    expect(p.hadSentinel).toBe(false);
    expect(p.publicText).toContain("real reply below");
  });
});

describe("normalizeDelivery — invariants", () => {
  it("plain reply on external channel passes through", () => {
    const d = normalizeDelivery("ご連絡ありがとうございます。", EXTERNAL);
    expect(d.publicAction).toEqual({ kind: "reply", text: "ご連絡ありがとうございます。" });
    expect(d.internal).toBeUndefined();
  });

  it("strips internal note from external channel, keeps public body", () => {
    const text = `確認して折り返します。\n\n${sentinel({ internal: "file ID: 123 / GO待ち" })}`;
    const d = normalizeDelivery(text, EXTERNAL);
    expect(d.publicAction).toEqual({ kind: "reply", text: "確認して折り返します。" });
    expect(d.internal).toBe("file ID: 123 / GO待ち");
  });

  it("the actual accident: internal-only report never posts publicly, ack instead", () => {
    // Model wrote an operator report as the whole body but marked suppressPublic.
    const text = `亮介にお願いしたいこと…\n\n${sentinel({ internal: "亮介にお願い…", suppressPublic: true })}`;
    const d = normalizeDelivery(text, EXTERNAL);
    // suppressPublic + no react + addressed → safe ack, internal saved
    expect(d.publicAction).toEqual({ kind: "reply", text: SAFE_ACK });
    expect(d.internal).toBeTruthy();
  });

  it("addressed + nothing public → safe ack (never silent)", () => {
    const text = sentinel({ suppressPublic: true });
    const d = normalizeDelivery(text, EXTERNAL);
    expect(d.publicAction).toEqual({ kind: "reply", text: SAFE_ACK });
  });

  it("unaddressed + nothing public → none (silence allowed)", () => {
    const text = sentinel({ suppressPublic: true });
    const d = normalizeDelivery(text, UNADDRESSED);
    expect(d.publicAction).toEqual({ kind: "none" });
  });

  it("react-only when no body", () => {
    const text = sentinel({ react: ":+1:" });
    const d = normalizeDelivery(text, EXTERNAL);
    expect(d.publicAction).toEqual({ kind: "react", emoji: "+1" });
  });

  it("react degrades to reply when connector cannot react", () => {
    const text = sentinel({ react: ":+1:" });
    const d = normalizeDelivery(text, NO_REACT);
    expect(d.publicAction).toEqual({ kind: "reply", text: SAFE_ACK });
  });

  it("DM: audience separation OFF — internal is shown to operator", () => {
    const text = `状況です。\n\n${sentinel({ internal: "録画未アップ・file ID 123" })}`;
    const d = normalizeDelivery(text, DM);
    expect(d.publicAction.kind).toBe("reply");
    if (d.publicAction.kind === "reply") {
      expect(d.publicAction.text).toContain("状況です。");
      expect(d.publicAction.text).toContain("録画未アップ");
    }
    expect(d.internal).toBeUndefined();
  });

  it("internal channel still strips internal (only DM is exempt)", () => {
    const text = `本文\n\n${sentinel({ internal: "secret" })}`;
    const d = normalizeDelivery(text, INTERNAL_CH);
    expect(d.publicAction).toEqual({ kind: "reply", text: "本文" });
    expect(d.internal).toBe("secret");
  });
});

describe("normalizeTurns — batch", () => {
  it("strips internal from each turn, no per-turn ack", () => {
    const turns = [
      `進捗1\n\n${sentinel({ internal: "メモ1" })}`,
      "進捗2",
    ];
    const { actions, internals } = normalizeTurns(turns, EXTERNAL);
    expect(actions).toEqual([
      { kind: "reply", text: "進捗1" },
      { kind: "reply", text: "進捗2" },
    ]);
    expect(internals).toEqual(["メモ1"]);
  });

  it("all-internal turns + addressed → single trailing ack", () => {
    const turns = [
      sentinel({ internal: "メモ1", suppressPublic: true }),
      sentinel({ internal: "メモ2", suppressPublic: true }),
    ];
    const { actions, internals } = normalizeTurns(turns, EXTERNAL);
    expect(actions).toEqual([{ kind: "reply", text: SAFE_ACK }]);
    expect(internals).toEqual(["メモ1", "メモ2"]);
  });

  it("all-internal turns + unaddressed → no ack", () => {
    const turns = [sentinel({ internal: "メモ", suppressPublic: true })];
    const { actions } = normalizeTurns(turns, UNADDRESSED);
    expect(actions).toEqual([]);
  });
});

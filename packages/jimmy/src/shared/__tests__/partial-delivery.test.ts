import { describe, expect, it } from "vitest";
import { PartialDeliveryError, isPartialDelivery, partialDeliveryFromText } from "../partial-delivery.js";

describe("PartialDeliveryError", () => {
  const cause = new Error("request timed out");
  const error = new PartialDeliveryError("Slack replyMessage", 1, 3, "1700000000.000100", cause);

  it("says how far the send got and why it stopped", () => {
    expect(error.message).toBe("Slack replyMessage: only 1 of 3 chunks were delivered (request timed out)");
    expect(error).toMatchObject({ name: "PartialDeliveryError", delivered: 1, total: 3, lastId: "1700000000.000100" });
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it("describes a cause that is not an Error", () => {
    expect(new PartialDeliveryError("Discord sendMessage", 2, 4, undefined, { code: 50013 }).message)
      .toBe("Discord sendMessage: only 2 of 4 chunks were delivered ([object Object])");
  });

  it("is told apart from an ordinary failure", () => {
    expect(isPartialDelivery(error)).toBe(true);
    expect(isPartialDelivery(cause)).toBe(false);
    expect(isPartialDelivery("Slack replyMessage: only 1 of 3 chunks were delivered")).toBe(false);
    expect(isPartialDelivery(undefined)).toBe(false);
  });

  // Across an HTTP boundary only the message survives (the proxy a secondary
  // Discord instance sends through answers { error: <message> }).
  it("can be rebuilt from its message on the far side of an HTTP boundary", () => {
    const rebuilt = partialDeliveryFromText(error.message);

    expect(rebuilt).toBeInstanceOf(PartialDeliveryError);
    expect(rebuilt).toMatchObject({ delivered: 1, total: 3, message: error.message });
    expect(isPartialDelivery(rebuilt)).toBe(true);
  });

  it.each([
    "Missing Permissions",
    "Remote Discord proxy replyMessage failed: 500",
    "",
  ])("does not mistake another failure for one: %j", (text) => {
    expect(partialDeliveryFromText(text)).toBeUndefined();
  });
});

import { Bot, type Update } from "node-telegram-bot-api";
import { describe, expect, it, vi } from "vitest";

describe("node-telegram-bot-api v2 runtime contract", () => {
  it("delivers a real polling update through the v2 Context shape", async () => {
    const bot = new Bot("123456:test-token");
    const handler = vi.fn();
    bot.on("message", (context) => {
      handler(context.message?.text);
    });
    const update: Update = {
      update_id: 1,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 3, type: "private" },
        text: "contract-ok",
      },
    };
    async function* source(): AsyncGenerator<Update> {
      yield update;
    }

    const polling = bot.startPolling(source());
    expect(polling).toBeInstanceOf(Promise);
    await polling;
    bot.stop();
    expect(handler).toHaveBeenCalledWith("contract-ok");
  });
});

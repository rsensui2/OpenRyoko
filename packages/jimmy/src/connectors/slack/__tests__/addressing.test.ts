import { describe, expect, it } from "vitest";
import { isSoloThread, mentionsOfOthers, opensByAddressingOthers } from "../addressing.js";

describe("Slack addressing", () => {
  describe("isSoloThread", () => {
    const base = { incomplete: false, botUserId: "URYOKO", userId: "U1" };

    it("is true when only this person and the bot have spoken", () => {
      expect(isSoloThread({ ...base, speakers: [
        { user: "U1" }, { user: "URYOKO", botId: "B1" }, { user: "U1" },
      ] })).toBe(true);
      // A root the bot posted itself, such as a scheduled report.
      expect(isSoloThread({ ...base, speakers: [{ user: "URYOKO", botId: "B1" }] })).toBe(true);
    });

    it("ignores Slackbot notices", () => {
      expect(isSoloThread({ ...base, speakers: [
        { user: "URYOKO", botId: "B1" }, { user: "USLACKBOT" }, { user: "U1" },
      ] })).toBe(true);
    });

    it("is false until the bot has spoken", () => {
      expect(isSoloThread({ ...base, speakers: [{ user: "U1" }, { user: "U1" }] })).toBe(false);
      expect(isSoloThread({ ...base, speakers: [] })).toBe(false);
    });

    it("is false once another person has spoken", () => {
      expect(isSoloThread({ ...base, speakers: [
        { user: "URYOKO", botId: "B1" }, { user: "U2" }, { user: "U1" },
      ] })).toBe(false);
    });

    it("is false once another bot or app has spoken", () => {
      expect(isSoloThread({ ...base, speakers: [
        { user: "URYOKO", botId: "B1" }, { user: "UOTHERBOT", botId: "B2" },
      ] })).toBe(false);
      expect(isSoloThread({ ...base, speakers: [{ user: "URYOKO", botId: "B1" }, { botId: "B3" }] })).toBe(false);
    });

    it("is false for a message it cannot attribute", () => {
      expect(isSoloThread({ ...base, speakers: [{ user: "URYOKO", botId: "B1" }, {}] })).toBe(false);
    });

    it("counts a message of this person's that carries a bot ID as another bot's", () => {
      // The connector ignores messages with a bot ID, so it cannot have answered them.
      expect(isSoloThread({ ...base, speakers: [{ user: "URYOKO", botId: "B1" }, { user: "U1", botId: "B9" }] }))
        .toBe(false);
    });

    it("is false without the complete history or the bot's own ID", () => {
      const speakers = [{ user: "URYOKO", botId: "B1" }, { user: "U1" }];
      expect(isSoloThread({ ...base, speakers, incomplete: true })).toBe(false);
      expect(isSoloThread({ ...base, speakers: undefined })).toBe(false);
      expect(isSoloThread({ ...base, speakers, botUserId: null })).toBe(false);
    });
  });

  describe("mentionsOfOthers", () => {
    it("lists the people mentioned other than the bot", () => {
      expect(mentionsOfOthers("<@U2> と <@URYOKO> と <@W3> で", "URYOKO")).toEqual(["U2", "W3"]);
      expect(mentionsOfOthers("宛先なし", "URYOKO")).toEqual([]);
    });

    it("does not count the app named in a 'sent using' footer", () => {
      expect(mentionsOfOthers("確認しました。 *使用して送信されました* <@UCHATGPT>", "URYOKO")).toEqual([]);
      expect(mentionsOfOthers(
        "見てください。 *使用して送信されました* <@UCLAUDE>（インタラクティブ要素あり）", "URYOKO",
      )).toEqual([]);
      expect(mentionsOfOthers("Done. *Sent using* <@UCHATGPT>", "URYOKO")).toEqual([]);
      expect(mentionsOfOthers("<@U2> 確認をお願いします *使用して送信されました* <@UCHATGPT>", "URYOKO"))
        .toEqual(["U2"]);
    });
  });

  describe("opensByAddressingOthers", () => {
    it("is true when the message opens by mentioning someone else", () => {
      expect(opensByAddressingOthers("<@U2> 対応完了です", "URYOKO")).toBe(true);
      expect(opensByAddressingOthers("  <@U2>\n見てください", "URYOKO")).toBe(true);
    });

    it("looks past formatting and a short greeting before the mention", () => {
      expect(opensByAddressingOthers("*<@U2>* 確認して", "URYOKO")).toBe(true);
      expect(opensByAddressingOthers("&gt; <@U2> 見てください", "URYOKO")).toBe(true);
      expect(opensByAddressingOthers("お疲れ様です。\n<@U2> 明日の件、確認お願いします", "URYOKO")).toBe(true);
      expect(opensByAddressingOthers("Hi <@U2>, can you check?", "URYOKO")).toBe(true);
    });

    it("is true when the message opens with a group or broadcast mention", () => {
      expect(opensByAddressingOthers("<!here> 確認して", "URYOKO")).toBe(true);
      expect(opensByAddressingOthers("<!channel> お知らせです", "URYOKO")).toBe(true);
      expect(opensByAddressingOthers("<!subteam^S123|@ops> 見てください", "URYOKO")).toBe(true);
    });

    it("is false when the mention comes later or names the bot", () => {
      expect(opensByAddressingOthers("予定を押さえて。\n<@U2> 11日は空いていますか？", "URYOKO")).toBe(false);
      expect(opensByAddressingOthers("お疲れ様です。Ryokoさん、<@U2> に連絡して", "URYOKO")).toBe(false);
      expect(opensByAddressingOthers("確認して <!here>", "URYOKO")).toBe(false);
      expect(opensByAddressingOthers("<@URYOKO> <@U2> にも共有して", "URYOKO")).toBe(false);
      expect(opensByAddressingOthers("メンションなし", "URYOKO")).toBe(false);
    });
  });
});

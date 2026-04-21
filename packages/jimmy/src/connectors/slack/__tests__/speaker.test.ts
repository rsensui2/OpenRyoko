import { describe, it, expect } from "vitest";
import { normalizeSpeakerInfo } from "../speaker.js";

describe("normalizeSpeakerInfo", () => {
  it("prefers profile.display_name when present", () => {
    const info = normalizeSpeakerInfo(
      {
        id: "U123",
        name: "taro",
        real_name: "Taro Yamada",
        profile: { display_name: "Taro" },
      },
      "U123",
    );
    expect(info.name).toBe("Taro");
    expect(info.realName).toBe("Taro Yamada");
    expect(info.displayName).toBe("Taro");
    expect(info.handle).toBe("taro");
  });

  it("falls back to real_name when display_name is empty", () => {
    const info = normalizeSpeakerInfo(
      {
        id: "U123",
        name: "taro",
        real_name: "Taro Yamada",
        profile: { display_name: "" },
      },
      "U123",
    );
    expect(info.name).toBe("Taro Yamada");
    expect(info.displayName).toBeUndefined();
  });

  it("falls back to handle when real_name is missing", () => {
    const info = normalizeSpeakerInfo({ id: "U123", name: "taro" }, "U123");
    expect(info.name).toBe("taro");
    expect(info.realName).toBeUndefined();
  });

  it("returns fallback id when user is null", () => {
    const info = normalizeSpeakerInfo(null, "U999");
    expect(info.name).toBe("U999");
    expect(info.realName).toBeUndefined();
    expect(info.displayName).toBeUndefined();
  });

  it("surfaces is_bot and tz", () => {
    const info = normalizeSpeakerInfo(
      {
        id: "U123",
        name: "integration",
        is_bot: true,
        tz: "Asia/Tokyo",
        profile: { display_name: "MyBot" },
      },
      "U123",
    );
    expect(info.isBot).toBe(true);
    expect(info.tz).toBe("Asia/Tokyo");
  });

  it("trims whitespace on profile fields", () => {
    const info = normalizeSpeakerInfo(
      {
        id: "U123",
        name: "taro",
        real_name: "  Taro Yamada  ",
        profile: { display_name: "  Taro  " },
      },
      "U123",
    );
    expect(info.name).toBe("Taro");
    expect(info.realName).toBe("Taro Yamada");
  });
});

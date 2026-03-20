import { describe, it, expect } from "vitest";
import { markdownToWhatsApp, formatResponse } from "../format.js";

describe("markdownToWhatsApp", () => {
  describe("headings", () => {
    it("converts ## headings to *bold* on own line", () => {
      expect(markdownToWhatsApp("## My Heading")).toBe("*My Heading*");
    });

    it("converts # h1 to bold", () => {
      expect(markdownToWhatsApp("# Title")).toBe("*Title*");
    });
  });

  describe("bold", () => {
    it("converts **bold** to *bold*", () => {
      expect(markdownToWhatsApp("this is **bold** text")).toBe("this is *bold* text");
    });

    it("converts __bold__ to *bold*", () => {
      expect(markdownToWhatsApp("this is __bold__ text")).toBe("this is *bold* text");
    });
  });

  describe("italic", () => {
    it("preserves _italic_ (WhatsApp uses same syntax)", () => {
      expect(markdownToWhatsApp("this is _italic_ text")).toBe("this is _italic_ text");
    });
  });

  describe("strikethrough", () => {
    it("converts ~~strike~~ to ~strike~", () => {
      expect(markdownToWhatsApp("this is ~~struck~~ out")).toBe("this is ~struck~ out");
    });
  });

  describe("links", () => {
    it("converts [text](url) to text (url) since WA auto-links", () => {
      expect(markdownToWhatsApp("click [here](https://example.com)")).toBe(
        "click here (https://example.com)",
      );
    });
  });

  describe("bullet lists", () => {
    it("converts - item to • item", () => {
      expect(markdownToWhatsApp("- first\n- second")).toBe("• first\n• second");
    });

    it("converts * item to • item (not bold)", () => {
      expect(markdownToWhatsApp("* first\n* second")).toBe("• first\n• second");
    });
  });

  describe("code", () => {
    it("preserves inline code", () => {
      expect(markdownToWhatsApp("use `code`")).toBe("use `code`");
    });

    it("preserves code blocks", () => {
      const input = "```\ncode here\n```";
      expect(markdownToWhatsApp(input)).toBe("```\ncode here\n```");
    });

    it("does not convert markdown inside code blocks", () => {
      const input = "```\n## not a heading\n```";
      expect(markdownToWhatsApp(input)).toBe("```\n## not a heading\n```");
    });
  });

  describe("mixed content", () => {
    it("handles headings + bold + links", () => {
      const input = "## Summary\n\nThis is **important** and [docs](https://docs.com).";
      const expected = "*Summary*\n\nThis is *important* and docs (https://docs.com).";
      expect(markdownToWhatsApp(input)).toBe(expected);
    });
  });
});

describe("formatResponse", () => {
  it("applies markdown conversion before chunking", () => {
    const result = formatResponse("## Hello\n\n**bold** text");
    expect(result).toEqual(["*Hello*\n\n*bold* text"]);
  });
});

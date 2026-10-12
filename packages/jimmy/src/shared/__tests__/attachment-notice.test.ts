import { describe, expect, it } from "vitest";
import { AttachmentTooLargeError } from "../attachment-download.js";
import { attachmentFailureNotice, failedAttachment, withAttachmentNotice } from "../attachment-notice.js";

/* An attachment that could not be fetched must not simply be missing: the
 * engine would carry on as if nothing had been attached, or make the contents
 * up. The connector says so in the message it hands to the session — which
 * attachment, and why when it knows — in words of its own. Never the file's
 * name: that is the sender's text, and here it would read as part of the
 * notice. */

const MB = 1024 * 1024;

describe("failedAttachment", () => {
  it("says an attachment was larger than the limit, and what the limit is", () => {
    expect(failedAttachment("attachment 2 of 3", new AttachmentTooLargeError(200 * MB))).toBe("attachment 2 of 3 (larger than the 200 MB attachment limit)");
    expect(failedAttachment("Slack file F123", new AttachmentTooLargeError(MB / 2))).toBe("Slack file F123 (larger than the 0.5 MB attachment limit)");
    expect(failedAttachment("media", new AttachmentTooLargeError(1536 * 1024))).toBe("media (larger than the 1.5 MB attachment limit)");
  });

  it("gives no reason for any other failure: the error may quote a URL or a name", () => {
    expect(failedAttachment("attachment 1", new Error("Failed to download https://cdn.example/secret?sig=abc: 403"))).toBe("attachment 1");
    expect(failedAttachment("attachment 1", "boom")).toBe("attachment 1");
  });
});

describe("attachmentFailureNotice", () => {
  it("says nothing when every attachment was retrieved", () => {
    expect(attachmentFailureNotice("Discord", [])).toBe("");
  });

  it("tells the engine which attachments it does not have, and not to make them up", () => {
    const notice = attachmentFailureNotice("Discord", ["attachment 1 of 2 (larger than the 200 MB attachment limit)", "attachment 2 of 2"]);
    expect(notice.startsWith("\n\n[System attachment notice: ")).toBe(true);
    expect(notice.endsWith("]")).toBe(true);
    expect(notice).toContain("Discord attachment(s) could not be retrieved: attachment 1 of 2 (larger than the 200 MB attachment limit), attachment 2 of 2.");
    expect(notice).toContain("Do not infer or substitute their contents");
    expect(notice).toMatch(/why/); // the engine is asked to pass the reason on
  });
});

describe("withAttachmentNotice", () => {
  const failed = ["attachment 1 of 1 (larger than the 200 MB attachment limit)"];

  it("appends the notice to the message text", () => {
    expect(withAttachmentNotice("see attached", "Discord", failed)).toBe(`see attached${attachmentFailureNotice("Discord", failed)}`);
  });

  it("leaves the text alone when nothing failed", () => {
    expect(withAttachmentNotice("see attached", "Discord", [])).toBe("see attached");
  });

  it.each([["/status"], ["/new start over"], ["  /model gpt-6-sol"]])(
    "passes the slash command %j on exactly as typed: the session manager matches it by its text",
    (command) => {
      expect(withAttachmentNotice(command, "Discord", failed)).toBe(command);
    },
  );

  it("passes on what is not text as it is", () => {
    expect(withAttachmentNotice(undefined, "Discord", failed)).toBeUndefined();
    expect(withAttachmentNotice(42, "Discord", failed)).toBe(42);
  });
});

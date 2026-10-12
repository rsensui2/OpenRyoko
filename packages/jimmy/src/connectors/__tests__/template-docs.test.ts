import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_ATTACHMENT_MB } from "../../shared/attachment-download.js";
import { PartialDeliveryError } from "../../shared/partial-delivery.js";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { downloadIncomingAttachments } from "../discord/remote.js";
import { downloadAttachment as downloadSlackFile } from "../slack/format.js";
import { deriveSessionKey } from "../slack/threads.js";

const read = (rel: string) => fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf-8");

// An operator learns which settings a connector takes from the shipped config
// and its documentation. Nothing generates either from the code, so this pins
// that the attachment limit is written down where it is looked up — with the
// default the code really uses.
describe("shipped documentation of the attachment limit", () => {
  it("lists maxAttachmentMb, commented out with its default, under connectors.slack in the default config", () => {
    const config = read("config.default.yaml");
    const slack = config.slice(config.indexOf("\nconnectors:\n  slack:\n"), config.indexOf("\nmcp:\n"));
    expect(slack).toMatch(new RegExp(`\\n    # maxAttachmentMb: ${DEFAULT_MAX_ATTACHMENT_MB}\\b`));
    expect(slack).toMatch(/discord[^\n]*whatsapp/); // the same key under the other connectors
  });

  it("does not turn the limit on by listing it: the default config still sets nothing", () => {
    expect(read("config.default.yaml")).not.toMatch(/^\s*maxAttachmentMb:/m);
  });

  it("shows the key and its default for Slack and Discord in docs/connectors.md, and says WhatsApp takes it too", () => {
    const docs = read("docs/connectors.md");
    const shown = [...docs.matchAll(/^ {4}maxAttachmentMb: (\d+)\b.*default (\d+)/gm)];
    expect(shown).toHaveLength(2);
    for (const [, value, stated] of shown) {
      expect(Number(value)).toBe(DEFAULT_MAX_ATTACHMENT_MB);
      expect(Number(stated)).toBe(DEFAULT_MAX_ATTACHMENT_MB);
    }
    expect(docs).toMatch(/same key works under `discord` and `whatsapp`/);
  });
});

// docs/connectors.md also says which files a connector will not fetch at all,
// and what a send that did not arrive answers with. Both are what an operator
// reads when a file "went missing" or a script was told "sent".
describe("shipped documentation of what a connector fetches and reports", () => {
  const docs = () => read("docs/connectors.md");
  const scratch: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openryoko-connector-docs-"));
    scratch.push(dir);
    return dir;
  };

  it("says Slack files are fetched from Slack's own file host only — and a file hosted elsewhere is not requested", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);

    await expect(downloadSlackFile("https://docs.google.com/document/d/abc", "xoxb-test-token", tempDir(), 1024)).rejects.toThrow();

    expect(fetched).not.toHaveBeenCalled();
    expect(docs()).toMatch(/only from Slack's own file host \(`files\.slack\.com`\), the one place the bot token is sent/);
    expect(docs()).toMatch(/Google Drive document or another remote file[^.]*is not downloaded/);
  });

  it("says a forwarded Discord message is held to its own limits, whatever maxAttachmentMb says", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const listed = Array.from({ length: 12 }, (_, index) => ({ name: `file-${index}.txt`, url: `https://example.test/file-${index}.txt`, mimeType: "text/plain" }));

    const result = await downloadIncomingAttachments(listed, tempDir());

    // Ten are looked at, and none of these is on Discord's CDN, so nothing is requested.
    expect(result.attachments).toHaveLength(10);
    expect(fetched).not.toHaveBeenCalled();
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "discord", "remote.ts"), "utf-8");
    expect(source).toContain("const MAX_INCOMING_ATTACHMENT_BYTES = 50 * 1024 * 1024;");
    expect(docs()).toMatch(/forwarded attachment only from Discord's CDN over https, at most ten per message and up to 50 MB each, whatever `maxAttachmentMb` says/);
  });

  it("gives the answer of a send that arrived only in part in the words the gateway uses", () => {
    const partial = new PartialDeliveryError("[discord] sendMessage", 1, 3, undefined, new Error("boom"));

    expect(partial.message).toContain("only 1 of 3 chunks were delivered");
    expect(docs()).toContain("`only N of M chunks were delivered`");
    expect(docs()).toMatch(/answers `\{"status":"sent"\}` only when all of the message arrived/);
  });

  it("shows the connector interface as it is: sends take a target and report delivery", () => {
    expect(docs()).toContain("sendMessage(target: Target, text: string): Promise<string | void>;");
    expect(docs()).not.toContain("sendMessage(sourceRef: string");
  });
});

// The Slack section described sessions and reactions of an early version: one
// session per channel, and a check mark or a cross when a turn ended.
describe("shipped documentation of Slack sessions and reactions", () => {
  const docs = () => read("docs/connectors.md");

  it("maps each kind of Slack message to the session key the connector derives", () => {
    const keys = {
      "`slack:dm:<userId>`": deriveSessionKey({ channel_type: "im", channel: "D1", user: "<userId>", ts: "2.0" }),
      "`slack:dm:<userId>:<threadTs>`": deriveSessionKey({ channel_type: "im", channel: "D1", user: "<userId>", ts: "2.0", thread_ts: "<threadTs>" }),
      "`slack:<channelId>:<ts>`": deriveSessionKey({ channel: "<channelId>", user: "U1", ts: "<ts>" }),
      "`slack:<channelId>:<threadTs>`": deriveSessionKey({ channel: "<channelId>", user: "U1", ts: "2.0", thread_ts: "<threadTs>" }),
    };

    for (const [shown, derived] of Object.entries(keys)) {
      expect(`\`${derived}\``).toBe(shown);
      expect(docs(), shown).toContain(shown);
    }
    // A root message in a channel starts its own session; there is no session per channel.
    expect(docs()).not.toContain("One session per channel");
  });

  it("names the reactions the gateway adds, and no mark for success or failure", () => {
    const manager = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "sessions", "manager.ts"), "utf-8");
    const section = docs().split("\n### Reaction Workflow\n")[1]?.split("\n### ")[0] ?? "";

    for (const emoji of ["clock1", "eyes", "hourglass_flowing_sand"]) {
      expect(manager, emoji).toContain(`"${emoji}"`);
      expect(section, emoji).toContain(`:${emoji}:`);
    }
    for (const never of ["white_check_mark", "x"]) {
      expect(manager).not.toMatch(new RegExp(`addReaction\\([^)]*["']${never}["']`));
      expect(section).not.toContain(`add :${never}:`);
    }
  });
});

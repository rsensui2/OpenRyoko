import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ATTACHMENT_MB } from "../../shared/attachment-download.js";
import { TEMPLATE_DIR } from "../../shared/paths.js";

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

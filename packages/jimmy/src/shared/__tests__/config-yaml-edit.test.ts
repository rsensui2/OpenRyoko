import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { editYamlText } from "../config-yaml-edit.js";

/* editYamlText rewrites the lines whose value changed and nothing else. Two
 * things are checked throughout: every other line survives byte for byte, and
 * the text it returns loads (with js-yaml, the parser the gateway reads its
 * config with) to exactly the document it was asked to store. Where it cannot
 * promise that, it returns null and the caller rewrites the file in full. */

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function edit(raw: string, change: (doc: Doc) => void): { out: string | null; after: Doc } {
  const before = (yaml.load(raw) ?? {}) as Doc;
  const after = structuredClone(before);
  change(after);
  const out = editYamlText(raw, before, after);
  if (out !== null) expect(yaml.load(out)).toEqual(after);
  return { out, after };
}

/** The result, which must exist. */
function edited(raw: string, change: (doc: Doc) => void): string {
  const { out } = edit(raw, change);
  expect(out).not.toBeNull();
  return out as string;
}

const CONFIG = [
  "# Gateway",
  "gateway:",
  "  port: 7777          # where it listens",
  '  host: "127.0.0.1"',
  "  # allowedHosts: [\"ryoko.example.com\"]",
  "",
  "connectors:",
  "  slack:",
  "    botToken: xoxb-1",
  "    allowFrom: [U1, U2]   # operators",
  "    # triage:",
  "    #   enabled: true",
  "",
  "# Who is who",
  "portal:",
  "  portalName: Ryoko",
  '  operatorDiscordId: "1543864208750542941"',
  "  trustedSpeakers:",
  "    - U0XXXXXXX   # Slack",
  '    - "1543864208750542941"',
  "",
  "cron:",
  "  # alertChannel: \"#alerts\"",
  "",
  "logging:",
  "  level: info",
  "",
].join("\n");

describe("editYamlText: values changed in place", () => {
  it("returns the text untouched when nothing changed", () => {
    expect(edited(CONFIG, () => {})).toBe(CONFIG);
  });

  it("replaces one scalar and keeps its trailing comment where it was", () => {
    expect(edited(CONFIG, (doc) => { doc.gateway.port = 7800; }))
      .toBe(CONFIG.replace("  port: 7777          # where it listens", "  port: 7800          # where it listens"));
  });

  it("keeps the quoting style of the value it replaces", () => {
    const out = edited(CONFIG, (doc) => { doc.gateway.host = "0.0.0.0"; doc.portal.operatorDiscordId = "2222222222222222222"; });
    expect(out).toContain('  host: "0.0.0.0"\n');
    expect(out).toContain('  operatorDiscordId: "2222222222222222222"\n');
    const single = edited("name: 'it''s'\n", (doc) => { doc.name = "ours"; });
    expect(single).toBe("name: 'ours'\n");
  });

  it("quotes a string that would otherwise read back as a number, boolean or null", () => {
    const out = edited(CONFIG, (doc) => { doc.portal.portalName = "7777"; doc.logging.level = "true"; doc.connectors.slack.botToken = "null"; });
    expect(yaml.load(out)).toMatchObject({ portal: { portalName: "7777" }, logging: { level: "true" }, connectors: { slack: { botToken: "null" } } });
    expect(out).toMatch(/^ {2}portalName: ['"]7777['"]$/m);
  });

  it("writes a number, boolean or null where a string was", () => {
    const out = edited(CONFIG, (doc) => { doc.gateway.host = 8080; doc.portal.portalName = false; doc.logging.level = null; });
    expect(out).toContain("  host: 8080\n");
    expect(out).toContain("  portalName: false\n");
    expect(out).toContain("  level: null\n");
  });

  it("changes one item of a flow sequence and one of a block sequence without reflowing either", () => {
    const out = edited(CONFIG, (doc) => { doc.connectors.slack.allowFrom[1] = "U3"; doc.portal.trustedSpeakers[0] = "U9"; });
    expect(out).toContain("    allowFrom: [U1, U3]   # operators\n");
    expect(out).toContain("    - U9   # Slack\n");
    expect(out).toContain('    - "1543864208750542941"\n');
  });

  it("reaches into a sequence of mappings", () => {
    const raw = "instances:\n  - id: sales   # 営業\n    type: slack\n    botToken: a\n  - id: dev\n    type: discord\n";
    expect(edited(raw, (doc) => { doc.instances[0].botToken = "b"; doc.instances[1].type = "slack"; }))
      .toBe("instances:\n  - id: sales   # 営業\n    type: slack\n    botToken: b\n  - id: dev\n    type: slack\n");
  });

  it("reaches into a flow mapping for a changed value", () => {
    expect(edited("respondTo: {dm: always, channel: mention}   # gate\n", (doc) => { doc.respondTo.channel = "never"; }))
      .toBe("respondTo: {dm: always, channel: never}   # gate\n");
  });

  it.each([
    ["yes"], ["null"], ["~"], ["1e3"], ["0x1f"], ["012"], ["+1"], [".5"], ["True"], ["2026-01-01"],
    [" leading"], ["trailing "], ["multi\nline"], ["tab\there"], ["#hash"], ["a # b"], ["a: b"], ["- dash"], [""],
    ["'"], ['"'], ["\\"], ["日本語 🎉"], ["{a}"], ["[b]"], ["a, b"], ["*alias"], ["&anchor"], ["!tag"], ["%dir"], ["@at"], ["`tick`"],
    ["?"], ["-"], [":"], ["---"], ["..."], ["x".repeat(300)], ["line1\r\nline2"],
  ])("stores the awkward string %j exactly, in every position a scalar can sit", (value) => {
    const raw = "plain: old\ndouble: \"old\"\nsingle: 'old'\nflow: [old, {k: old}]\nseq:\n  - old\n";
    const { out, after } = edit(raw, (doc) => {
      doc.plain = value; doc.double = value; doc.single = value; doc.flow[0] = value; doc.flow[1].k = value; doc.seq[0] = value;
    });
    expect(out).not.toBeNull();
    expect(yaml.load(out as string)).toEqual(after);
  });
});

describe("editYamlText: keys added and removed", () => {
  it("adds a key after the last key of its mapping, ahead of the commented-out examples at that level", () => {
    expect(edited(CONFIG, (doc) => { doc.gateway.allowedHosts = ["a.example"]; }))
      .toBe(CONFIG.replace('  host: "127.0.0.1"\n', '  host: "127.0.0.1"\n  allowedHosts:\n    - a.example\n'));
  });

  it("adds a sibling mapping after the previous sibling's own trailing comments", () => {
    expect(edited(CONFIG, (doc) => { doc.connectors.discord = { botToken: "d" }; }))
      .toBe(CONFIG.replace("    #   enabled: true\n", "    #   enabled: true\n  discord:\n    botToken: d\n"));
  });

  it("appends a new top-level section at the end, set apart like the others", () => {
    expect(edited(CONFIG, (doc) => { doc.budgets = { employees: { "a-lead": 25 } }; }))
      .toBe(`${CONFIG}\nbudgets:\n  employees:\n    a-lead: 25\n`);
  });

  it("sets several new top-level sections apart from each other as well", () => {
    expect(edited(CONFIG, (doc) => { doc.sessions = { interruptOnNewMessage: true }; doc.stt = { enabled: true }; }))
      .toBe(`${CONFIG}\nsessions:\n  interruptOnNewMessage: true\n\nstt:\n  enabled: true\n`);
  });

  it("does not add a blank line to a file that uses none", () => {
    expect(edited("a: 1\nb: 2\n", (doc) => { doc.c = 3; })).toBe("a: 1\nb: 2\nc: 3\n");
  });

  it("removes a key together with its line and nothing else", () => {
    expect(edited(CONFIG, (doc) => { delete doc.portal.operatorDiscordId; }))
      .toBe(CONFIG.replace('  operatorDiscordId: "1543864208750542941"\n', ""));
    expect(edited(CONFIG, (doc) => { delete doc.connectors; }))
      .toBe(CONFIG.replace("connectors:\n  slack:\n    botToken: xoxb-1\n    allowFrom: [U1, U2]   # operators\n", ""));
  });

  it("writes {} when the last key of a mapping goes, so the mapping does not read back as null", () => {
    expect(edited(CONFIG, (doc) => { delete doc.logging.level; })).toBe(CONFIG.replace("logging:\n  level: info\n", "logging: {}\n"));
  });

  it("fills in a key that had only comments under it, and keeps those comments", () => {
    expect(edited(CONFIG, (doc) => { doc.cron = { alertChannel: "#alerts" }; }))
      .toBe(CONFIG.replace('cron:\n  # alertChannel: "#alerts"\n', "cron:\n  alertChannel: '#alerts'\n  # alertChannel: \"#alerts\"\n"));
  });

  it("adds an item to a list without touching the notes next to the others", () => {
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers.push("U2"); }))
      .toBe(CONFIG.replace('    - "1543864208750542941"\n', '    - "1543864208750542941"\n    - U2\n'));
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers.unshift("U2"); }))
      .toBe(CONFIG.replace("    - U0XXXXXXX   # Slack\n", "    - U2\n    - U0XXXXXXX   # Slack\n"));
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers.splice(1, 0, "U2", "3333"); }))
      .toBe(CONFIG.replace("    - U0XXXXXXX   # Slack\n", "    - U0XXXXXXX   # Slack\n    - U2\n    - '3333'\n"));
  });

  it("removes an item from a list together with its line and nothing else", () => {
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers.pop(); }))
      .toBe(CONFIG.replace('    - "1543864208750542941"\n', ""));
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers.shift(); }))
      .toBe(CONFIG.replace("    - U0XXXXXXX   # Slack\n", ""));
  });

  it("replaces one item and adds another in the same save", () => {
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers = ["U0XXXXXXX", "U7", "U8"]; }))
      .toBe(CONFIG.replace('    - "1543864208750542941"\n', "    - U7\n    - U8\n"));
  });

  it("adds and removes whole mappings in a list of them", () => {
    const raw = "instances:\n  - id: sales   # 営業\n    type: slack\n  - id: dev\n    type: discord   # 開発\n\nlogging:\n  level: info\n";
    expect(edited(raw, (doc) => { doc.instances.push({ id: "ops", type: "slack", allowFrom: ["U1"] }); }))
      .toBe(raw.replace("    type: discord   # 開発\n", "    type: discord   # 開発\n  - id: ops\n    type: slack\n    allowFrom:\n      - U1\n"));
    expect(edited(raw, (doc) => { doc.instances.shift(); }))
      .toBe(raw.replace("  - id: sales   # 営業\n    type: slack\n", ""));
  });

  it("rewrites the one key when no item of its list survives", () => {
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers = ["U1"]; }))
      .toBe(CONFIG.replace('  trustedSpeakers:\n    - U0XXXXXXX   # Slack\n    - "1543864208750542941"\n', "  trustedSpeakers:\n    - U1\n"));
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers = []; }))
      .toBe(CONFIG.replace('  trustedSpeakers:\n    - U0XXXXXXX   # Slack\n    - "1543864208750542941"\n', "  trustedSpeakers: []\n"));
  });

  it("keeps a flow list a flow list when it grows or shrinks, comment and all", () => {
    expect(edited(CONFIG, (doc) => { doc.connectors.slack.allowFrom = ["U1", "U2", "U3"]; }))
      .toBe(CONFIG.replace("    allowFrom: [U1, U2]   # operators\n", "    allowFrom: [U1, U2, U3]   # operators\n"));
    expect(edited(CONFIG, (doc) => { doc.connectors.slack.allowFrom = []; }))
      .toBe(CONFIG.replace("    allowFrom: [U1, U2]   # operators\n", "    allowFrom: []   # operators\n"));
    expect(edited("respondTo: {dm: always, channel: mention}   # gate\n", (doc) => { doc.respondTo.engagedThreads = false; delete doc.respondTo.dm; }))
      .toBe("respondTo: {channel: mention, engagedThreads: false}   # gate\n");
  });

  it("rewrites just the one key when a value changes kind", () => {
    expect(edited(CONFIG, (doc) => { doc.gateway.port = { http: 7777 }; doc.portal = "none"; }))
      .toBe(CONFIG
        .replace("  port: 7777          # where it listens\n", "  port:\n    http: 7777\n")
        .replace('portal:\n  portalName: Ryoko\n  operatorDiscordId: "1543864208750542941"\n  trustedSpeakers:\n    - U0XXXXXXX   # Slack\n    - "1543864208750542941"\n', "portal: none\n"));
  });

  it("adds a key to a mapping that sits inside a sequence item, aligned with its siblings", () => {
    const raw = "instances:\n  - id: sales\n    type: slack\n  - id: dev\n    type: discord\n";
    expect(edited(raw, (doc) => { doc.instances[0].employee = "aiko"; }))
      .toBe("instances:\n  - id: sales\n    type: slack\n    employee: aiko\n  - id: dev\n    type: discord\n");
  });

  it("applies several changes of different kinds at once", () => {
    const out = edited(CONFIG, (doc) => {
      doc.gateway.port = 7800;
      delete doc.gateway.host;
      doc.connectors.slack.appToken = "xapp-1";
      doc.connectors.discord = { botToken: "d", allowFrom: ["1"] };
      doc.stt = { enabled: true };
      delete doc.cron;
    });
    expect(out.split("\n").filter((line) => line.trimStart().startsWith("#")))
      .toEqual(CONFIG.split("\n").filter((line) => line.trimStart().startsWith("#")));
    expect(out).toContain("  port: 7800          # where it listens\n");
  });
});

describe("editYamlText: the file's own conventions", () => {
  it("keeps CRLF line endings, on the lines it writes too", () => {
    const raw = "a: 1\r\nb:\r\n  c: \"x\"   # c\r\n  d: 2\r\n";
    const out = edited(raw, (doc) => { doc.b.c = "y"; doc.b.e = { f: 1 }; doc.g = [1]; });
    expect(out).toBe("a: 1\r\nb:\r\n  c: \"y\"   # c\r\n  d: 2\r\n  e:\r\n    f: 1\r\ng:\r\n  - 1\r\n");
  });

  it("leaves a four-space file alone and indents what it adds to match the mapping it joins", () => {
    const raw = "b:\n    c: 1\n    d:\n        e: 2\nlist:\n- x\n- y\n";
    expect(edited(raw, (doc) => { doc.b.d.e = 3; doc.b.d.f = 4; doc.list[1] = "z"; }))
      .toBe("b:\n    c: 1\n    d:\n        e: 3\n        f: 4\nlist:\n- x\n- z\n");
  });

  it("handles a file that does not end with a newline", () => {
    expect(edited("a: 1\nb:\n  c: 2", (doc) => { doc.b.c = 3; })).toBe("a: 1\nb:\n  c: 3");
    expect(edited("a: 1\nb:\n  c: 2", (doc) => { doc.b.d = 4; doc.e = 5; })).toBe("a: 1\nb:\n  c: 2\n  d: 4\ne: 5\n");
    expect(edited("a: 1\nb: 2", (doc) => { delete doc.b; })).toBe("a: 1\n");
  });

  it("stays inside the document markers", () => {
    expect(edited("---\na: 1\nb: 2\n...\n", (doc) => { doc.b = 3; doc.c = 4; })).toBe("---\na: 1\nb: 3\nc: 4\n...\n");
  });

  it("keeps the comments of a file that configures nothing yet, and writes below them", () => {
    const out = edited("# nothing here yet\n# gateway:\n#   port: 7777\n", (doc) => { doc.gateway = { port: 7777 }; });
    expect(out).toBe("# nothing here yet\n# gateway:\n#   port: 7777\ngateway:\n  port: 7777\n");
    expect(edited("", (doc) => { doc.a = 1; })).toBe("a: 1\n");
  });

  it("replaces a multi-line scalar or a block scalar without disturbing its neighbours", () => {
    const raw = "a: one\n  two\nb: |\n  line1\n  line2\nc: 3   # keep\n";
    expect(edited(raw, (doc) => { doc.a = "x"; doc.b = "plain text"; })).toBe("a: x\nb: plain text\nc: 3   # keep\n");
  });
});

describe("editYamlText: when it must decline", () => {
  it("declines when the two parsers read the file differently (a date js-yaml turns into a Date)", () => {
    expect(edit("when: 2026-01-01\nname: a\n", (doc) => { doc.name = "b"; }).out).toBeNull();
  });

  it("declines a file that uses merge keys", () => {
    expect(edit("base: &b {x: 1}\nm:\n  <<: *b\n  y: 2\nname: a\n", (doc) => { doc.name = "b"; }).out).toBeNull();
  });

  it("declines an edit that an alias would repeat somewhere else", () => {
    expect(edit("a: &shared\n  k: 1\nb: *shared\n", (doc) => { doc.a = { k: 2 }; }).out).toBeNull();
  });

  it("still edits a file with anchors when the change does not touch them", () => {
    expect(edited("a: &shared\n  k: 1\nb: *shared\nname: old   # n\n", (doc) => { doc.name = "new"; }))
      .toBe("a: &shared\n  k: 1\nb: *shared\nname: new   # n\n");
  });

  it("replaces an alias by its own value when only that key changes", () => {
    expect(edited("a: &shared\n  k: 1\nb: *shared\n", (doc) => { doc.b = { k: 2 }; })).toBe("a: &shared\n  k: 1\nb:\n  k: 2\n");
  });

  it("declines to empty the whole document or to edit a document that is not a block mapping", () => {
    expect(edit("a: 1\n", (doc) => { delete doc.a; }).out).toBeNull();
    expect(edit("{a: 1, b: 2}\n", (doc) => { doc.c = 3; }).out).toBeNull();
  });

  it("declines rather than guess around an explicit tag", () => {
    expect(edit("a: !!str 123\nb: 1\n", (doc) => { doc.a = "456"; }).out).not.toBe("a: !!str 456\nb: 1\n");
  });

  it("never throws on text it cannot make sense of", () => {
    expect(editYamlText("a: [unclosed\n", {}, { a: 1 })).toBeNull();
    expect(editYamlText("a: 1\na: 2\n", { a: 2 }, { a: 3 })).toBeNull();
    expect(editYamlText("a: 1\n---\nb: 2\n", { a: 1 }, { a: 2 })).toBeNull();
    expect(editYamlText("a: 1\n", { a: 1 }, { a: undefined })).toBeNull();
  });
});

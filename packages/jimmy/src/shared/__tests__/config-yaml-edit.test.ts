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

  it("changes one item of a flow sequence on its line, keeping the comment about the list", () => {
    expect(edited(CONFIG, (doc) => { doc.connectors.slack.allowFrom[1] = "U3"; }))
      .toBe(CONFIG.replace("    allowFrom: [U1, U2]   # operators\n", "    allowFrom: [U1, U3]   # operators\n"));
  });

  it("replaces one item of a block sequence as a line: the note written next to the old value does not pass to the new one", () => {
    // "# Slack" said what U0XXXXXXX is. It says nothing about U9.
    expect(edited(CONFIG, (doc) => { doc.portal.trustedSpeakers[0] = "U9"; }))
      .toBe(CONFIG.replace("    - U0XXXXXXX   # Slack\n", "    - U9\n"));
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

describe("editYamlText: lists whose items carry notes", () => {
  const ALLOW = [
    "allowFrom:",
    "  - U01AAAAAAA   # alice",
    "  - U02BBBBBBB   # bob",
    "  - U03CCCCCCC   # ryosuke",
    "other: 1",
    "",
  ].join("\n");

  /** value → the note on its line, for every list line that has one. */
  const notes = (text: string) => Object.fromEntries(
    [...text.matchAll(/^\s*- (\S+)\s+# (.+)$/gm)].map((match) => [match[1], match[2]]),
  );

  it.each([
    [["U03CCCCCCC", "U01AAAAAAA", "U02BBBBBBB"]],
    [["U02BBBBBBB", "U01AAAAAAA", "U03CCCCCCC"]],
    [["U03CCCCCCC", "U02BBBBBBB", "U01AAAAAAA"]],
    [["U02BBBBBBB", "U03CCCCCCC", "U01AAAAAAA"]],
  ])("reordering to %j never leaves a note next to a value it was not written for", (order) => {
    const out = edited(ALLOW, (doc) => { doc.allowFrom = order; });
    const original = notes(ALLOW);
    for (const [value, note] of Object.entries(notes(out))) expect(note).toBe(original[value]);
    expect(out.endsWith("other: 1\n")).toBe(true);
  });

  it("moves one item by removing its line and adding it elsewhere; the items that stay keep their lines", () => {
    expect(edited(ALLOW, (doc) => { doc.allowFrom = ["U03CCCCCCC", "U01AAAAAAA", "U02BBBBBBB"]; }))
      .toBe("allowFrom:\n  - U03CCCCCCC\n  - U01AAAAAAA   # alice\n  - U02BBBBBBB   # bob\nother: 1\n");
  });

  it("swapping two values in place of each other swaps nothing but the notes' absence", () => {
    const out = edited(ALLOW, (doc) => { doc.allowFrom = ["U01AAAAAAA", "U03CCCCCCC", "U02BBBBBBB"]; });
    expect(out).not.toContain("U03CCCCCCC   # bob");
    expect(out).not.toContain("U02BBBBBBB   # ryosuke");
    expect(out).toContain("  - U01AAAAAAA   # alice\n");
  });

  const INSTANCES = [
    "instances:",
    "  - id: sales        # 営業チーム",
    "    type: slack",
    "    botToken: tok-sales   # rotated 2026-09",
    "  - id: dev          # 開発チーム",
    "    type: discord",
    "    botToken: tok-dev",
    "",
  ].join("\n");

  it("edits a mapping in place while its id stays the same", () => {
    expect(edited(INSTANCES, (doc) => { doc.instances[0].botToken = "tok-new"; }))
      .toBe(INSTANCES.replace("    botToken: tok-sales   # rotated 2026-09", "    botToken: tok-new   # rotated 2026-09"));
  });

  it("keeps each mapping's notes with its id when two mappings change places", () => {
    const out = edited(INSTANCES, (doc) => { doc.instances.reverse(); });
    expect(out).not.toMatch(/id: dev\s+# 営業チーム/);
    expect(out).not.toMatch(/id: sales\s+# 開発チーム/);
    expect(out).not.toContain("tok-dev   # rotated 2026-09");
    // One of the two stays where it was, lines untouched; the other is written anew.
    const keptSales = out.includes("  - id: sales        # 営業チーム\n    type: slack\n    botToken: tok-sales   # rotated 2026-09\n");
    const keptDev = out.includes("  - id: dev          # 開発チーム\n    type: discord\n    botToken: tok-dev\n");
    expect(keptSales || keptDev).toBe(true);
  });

  it("does not edit one mapping into another when the id at that position changed", () => {
    const out = edited(INSTANCES, (doc) => { doc.instances[0] = { id: "ops", type: "slack", botToken: "tok-ops" }; });
    expect(out).not.toMatch(/id: ops\s+# 営業チーム/);
    expect(out).not.toContain("tok-ops   # rotated 2026-09");
    expect(out).toContain("  - id: dev          # 開発チーム\n    type: discord\n    botToken: tok-dev\n");
  });

  it("treats mappings without an identifier as different once any field differs", () => {
    const raw = "routes:\n  - url: http://a   # primary\n    weight: 1\n  - url: http://b\n    weight: 2\n";
    const out = edited(raw, (doc) => { doc.routes[0].url = "http://c"; });
    expect(out).not.toContain("http://c   # primary");
    expect(out).toContain("  - url: http://b\n    weight: 2\n");
  });
});

describe("editYamlText: notes written above or under a list item", () => {
  /* A note is as often on a line of its own as at the end of the item's line:
   * above the item it is about, or indented under it. Lists used to be edited
   * as if only the items' own lines existed, so a new first item landed between
   * "# alice" and alice's ID, and a new item after one with a note under it
   * took that note over. The lines directly above an item, and the lines
   * indented under it, are part of that item: they go when it goes, and
   * nothing is put between them and it. */
  const NOTED = [
    "allowFrom:",
    "  # alice",
    "  - U111",
    "  # bob — two lines",
    "  # of notes",
    "  - U222",
    "    # on call this week",
    "  - U333   # carol",
    "logging:",
    "  level: info   # quiet",
    "",
  ].join("\n");

  it("puts a new first item above the note on top of the old first item", () => {
    expect(edited(NOTED, (doc) => { doc.allowFrom.unshift("U000"); }))
      .toBe(NOTED.replace("  # alice\n", "  - U000\n  # alice\n"));
  });

  it("takes the note on top of an item away with the item, and leaves the next item's note on top of that one", () => {
    expect(edited(NOTED, (doc) => { doc.allowFrom[0] = "U999"; }))
      .toBe(NOTED.replace("  # alice\n  - U111\n", "  - U999\n"));
  });

  it("removes an item with every line of notes above it and under it", () => {
    expect(edited(NOTED, (doc) => { doc.allowFrom.splice(1, 1); }))
      .toBe(NOTED.replace("  # bob — two lines\n  # of notes\n  - U222\n    # on call this week\n", ""));
  });

  it("puts a new item after the note indented under the item before it", () => {
    expect(edited(NOTED, (doc) => { doc.allowFrom.splice(2, 0, "U250"); }))
      .toBe(NOTED.replace("    # on call this week\n", "    # on call this week\n  - U250\n"));
  });

  it("moves the last item to the front without coming between another item and its note", () => {
    expect(edited(NOTED, (doc) => { doc.allowFrom = ["U333", "U111", "U222"]; }))
      .toBe(NOTED.replace("  # alice\n", "  - U333\n  # alice\n").replace("  - U333   # carol\n", ""));
  });

  it("appends after the last item", () => {
    expect(edited(NOTED, (doc) => { doc.allowFrom.push("U444"); }))
      .toBe(NOTED.replace("  - U333   # carol\n", "  - U333   # carol\n  - U444\n"));
  });

  it("does the same for a list of mappings", () => {
    const raw = [
      "instances:",
      "  # the sales workspace",
      "  - id: sales",
      "    type: slack",
      "    # rotated in March",
      "  # ops, on Discord",
      "  - id: ops",
      "    type: discord",
      "",
    ].join("\n");
    expect(edited(raw, (doc) => { doc.instances.unshift({ id: "support", type: "slack" }); }))
      .toBe(raw.replace("  # the sales workspace\n", "  - id: support\n    type: slack\n  # the sales workspace\n"));
    expect(edited(raw, (doc) => { doc.instances.shift(); }))
      .toBe("instances:\n  # ops, on Discord\n  - id: ops\n    type: discord\n");
    expect(edited(raw, (doc) => { doc.instances.splice(1, 0, { id: "support", type: "slack" }); }))
      .toBe(raw.replace("    # rotated in March\n", "    # rotated in March\n  - id: support\n    type: slack\n"));
    expect(edited(raw, (doc) => { doc.instances[0].type = "discord"; }))
      .toBe(raw.replace("    type: slack\n", "    type: discord\n"));
  });

  it("keeps a note with its item across blank lines that set groups apart", () => {
    const raw = "list:\n  # group one\n  - a\n\n  # group two\n  - b\n  - c\nnext: 1\n";
    expect(edited(raw, (doc) => { doc.list.splice(1, 0, "x"); }))
      .toBe("list:\n  # group one\n  - a\n  - x\n\n  # group two\n  - b\n  - c\nnext: 1\n");
    expect(edited(raw, (doc) => { doc.list.splice(1, 1); }))
      .toBe("list:\n  # group one\n  - a\n\n  - c\nnext: 1\n");
  });

  it("works the same in a file with CRLF line endings, and one whose dashes sit under the key", () => {
    const crlf = NOTED.replace(/\n/g, "\r\n");
    expect(edited(crlf, (doc) => { doc.allowFrom.unshift("U000"); }))
      .toBe(crlf.replace("  # alice\r\n", "  - U000\r\n  # alice\r\n"));
    const flush = "allowFrom:\n# alice\n- U111\n# bob\n- U222\n  # on call\nother: 1\n";
    expect(edited(flush, (doc) => { doc.allowFrom.unshift("U000"); }))
      .toBe(flush.replace("# alice\n", "- U000\n# alice\n"));
    expect(edited(flush, (doc) => { doc.allowFrom.push("U333"); }))
      .toBe(flush.replace("  # on call\n", "  # on call\n- U333\n"));
  });

  /** "<note>" → the line it stands directly on top of, for every note written above an item. */
  const notesOnTop = (text: string) => {
    const lines = text.split("\n");
    return new Map(lines.flatMap((line, at) => (line.startsWith("  # note on ") ? [[line.trim(), (lines[at + 1] ?? "").trim()] as const] : [])));
  };
  /** "<note>" → the line it is indented under, for every note written under an item. */
  const notesUnder = (text: string) => {
    const lines = text.split("\n");
    return new Map(lines.flatMap((line, at) => (line.startsWith("    # under ") ? [[line.trim(), (lines[at - 1] ?? "").trim()] as const] : [])));
  };

  it("never leaves a note on top of an item it was not written above, whatever is added, removed or moved", () => {
    let seed = 20261013;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = (count: number) => Math.floor(random() * count);
    for (let round = 0; round < 600; round++) {
      const items = Array.from({ length: 1 + pick(6) }, (_, n) => `item${round}x${n}`);
      const raw = `before: 1   # kept\nlist:\n${items.map((item, n) => `${random() < 0.6 ? `  # note on ${item}\n` : ""}  - ${item}\n${random() < 0.3 ? `    # under ${item}\n` : ""}${n < items.length - 1 && random() < 0.2 ? "\n" : ""}`).join("")}after: 2   # kept too\n`;
      const next = [...items];
      for (let change = 0, changes = 1 + pick(3); change < changes; change++) {
        const kind = pick(3);
        if (kind === 0) next.splice(pick(next.length + 1), 0, `new${round}x${change}`);
        else if (kind === 1 && next.length > 1) next.splice(pick(next.length), 1);
        else if (next.length > 1) next.splice(pick(next.length), 0, next.splice(pick(next.length), 1)[0]);
      }
      const { out } = edit(raw, (doc) => { doc.list = next; });
      expect(out).not.toBeNull();
      // Every note that is still there stands where it stood: on top of, or under, the same item.
      const onTop = notesOnTop(raw);
      for (const [note, item] of notesOnTop(out as string)) expect(`${note} → ${item}`).toBe(`${note} → ${onTop.get(note)}`);
      const under = notesUnder(raw);
      for (const [note, item] of notesUnder(out as string)) expect(`${note} ← ${item}`).toBe(`${note} ← ${under.get(note)}`);
      expect(out).toContain("before: 1   # kept\n");
      expect(out).toContain("after: 2   # kept too\n");
    }
  });
});

describe("editYamlText: a note nobody can place", () => {
  /* Some comments in a list cannot be said to belong to one item: one that a
   * blank line separates from the item below it, or one at an indentation of
   * its own. When the list changes right next to such a comment, guessing
   * would put it next to the wrong thing — so that one list is written out
   * again, without its comments, and the rest of the file is left alone. */
  const FLOATING = [
    "# who may talk to the bot",
    "allowFrom:   # by Slack ID",
    "  - U111",
    "  # temporarily off:",
    "",
    "  - U222",
    "  # carol",
    "  - U333",
    "logging:",
    "  level: info   # quiet",
    "",
  ].join("\n");
  const rewritten = (...ids: string[]) =>
    `# who may talk to the bot\nallowFrom:\n${ids.map((id) => `  - ${id}\n`).join("")}logging:\n  level: info   # quiet\n`;

  it("rewrites the list when an item is added next to it", () => {
    expect(edited(FLOATING, (doc) => { doc.allowFrom.splice(1, 0, "U150"); })).toBe(rewritten("U111", "U150", "U222", "U333"));
  });

  it("rewrites the list when an item next to it is removed", () => {
    expect(edited(FLOATING, (doc) => { doc.allowFrom.splice(0, 1); })).toBe(rewritten("U222", "U333"));
    expect(edited(FLOATING, (doc) => { doc.allowFrom.splice(1, 1); })).toBe(rewritten("U111", "U333"));
  });

  it("still edits the list in place when the change is somewhere else in it", () => {
    expect(edited(FLOATING, (doc) => { doc.allowFrom.push("U444"); })).toBe(FLOATING.replace("  - U333\n", "  - U333\n  - U444\n"));
    expect(edited(FLOATING, (doc) => { doc.allowFrom.pop(); })).toBe(FLOATING.replace("  # carol\n  - U333\n", ""));
  });

  it.each([
    ["a comment at the edge of the page", "list:\n# FIXME\n  - a\n  - b\nnext: 1\n"],
    ["a comment indented under nothing", "list:\n      # odd\n  - a\n  - b\nnext: 1\n"],
    ["a comment a blank line away from the first item", "list:\n  # the operators\n\n  - a\n  - b\nnext: 1\n"],
  ])("rewrites the list for %s when an item is added in front", (_what, raw) => {
    expect(edited(raw, (doc) => { doc.list.unshift("x"); })).toBe("list:\n  - x\n  - a\n  - b\nnext: 1\n");
  });

  it("leaves a comment after the last item where it is: it may be about what comes next", () => {
    const raw = "list:\n  - a\n  - b\n  # - c (disabled)\n\n# Logging\nlogging:\n  level: info\n";
    expect(edited(raw, (doc) => { doc.list.push("x"); })).toBe(raw.replace("  - b\n", "  - b\n  - x\n"));
    expect(edited(raw, (doc) => { doc.list.pop(); })).toBe(raw.replace("  - b\n", ""));
  });
});

describe("editYamlText: a list that is written out again or removed", () => {
  /* The note indented under the last item of a list is about that item. When
   * the whole list is replaced or removed, it goes with the list — left
   * behind, it would be read as a note on whatever now stands above it. */
  const raw = "before: 1\nlist:\n  - a\n  - b\n    # b is temporary\nnext: 1   # kept\n";

  it("takes the note under the last item along when no item of the list survives", () => {
    expect(edited(raw, (doc) => { doc.list = ["x1", "x2"]; })).toBe("before: 1\nlist:\n  - x1\n  - x2\nnext: 1   # kept\n");
  });

  it("takes it along when the list is removed", () => {
    expect(edited(raw, (doc) => { delete doc.list; })).toBe("before: 1\nnext: 1   # kept\n");
  });

  it("takes it along when the list becomes something else", () => {
    expect(edited(raw, (doc) => { doc.list = "none"; })).toBe("before: 1\nlist: none\nnext: 1   # kept\n");
  });

  it("takes it along when the entry that goes is further up: the list is the last thing inside it", () => {
    const nested = "connectors:\n  slack:\n    token: t\n    allowFrom:\n      - U111\n      - U222\n        # leaving in May\n  discord:\n    token: d   # kept\n";
    expect(edited(nested, (doc) => { delete doc.connectors.slack; })).toBe("connectors:\n  discord:\n    token: d   # kept\n");
    expect(edited(nested, (doc) => { doc.connectors.slack = false; })).toBe("connectors:\n  slack: false\n  discord:\n    token: d   # kept\n");
  });

  it("takes it along for an item whose dash stands alone on the line above it", () => {
    const fourSpaces = "outer:\n    -\n        - a\n        - b\n          # under b\nnext: 1   # kept\n";
    expect(edited(fourSpaces, (doc) => { doc.outer = "none"; })).toBe("outer: none\nnext: 1   # kept\n");
  });

  it("leaves a comment at the list's own level, or shallower, where it is", () => {
    const withExamples = "list:\n  - a\n  # - b (an example)\n# Next section\nnext: 1\n";
    expect(edited(withExamples, (doc) => { doc.list = ["x"]; })).toBe("list:\n  - x\n  # - b (an example)\n# Next section\nnext: 1\n");
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

describe("editYamlText: very long lists", () => {
  /* Telling which items of a list stayed means comparing item against item,
   * and that grows with the square of the list. It is done only for the part
   * of a list that changed, and not at all once that part is large: the list
   * is then written out again as a whole, notes and all gone, like any entry
   * that cannot be edited in place. (The counting is in list-alignment.test.ts.) */
  const head = ["# who may talk to the bot", "allowFrom:", ""].join("\n");
  const item = (n: number) => `U${String(n).padStart(6, "0")}`;
  const long = (count: number) =>
    `${head}${Array.from({ length: count }, (_, n) => `  - ${item(n)}${n === 3 || n === count - 3 ? "   # an operator" : ""}\n`).join("")}\n# end of the list\nlogging:\n  level: info   # quiet\n`;

  it("adds one item to a list of thousands as one line, and keeps the note next to another", () => {
    const raw = long(5_000);
    const out = edited(raw, (doc) => { doc.allowFrom.push("U999999"); });
    expect(out).toBe(raw.replace(`  - ${item(4_999)}\n`, `  - ${item(4_999)}\n  - U999999\n`));
  });

  it("removes one item from the middle of a list of thousands as one line", () => {
    const raw = long(5_000);
    const out = edited(raw, (doc) => { doc.allowFrom.splice(2_500, 1); });
    expect(out).toBe(raw.replace(`  - ${item(2_500)}\n`, ""));
  });

  it("writes the list out again when thousands of its items changed places, and leaves the rest of the file alone", () => {
    const raw = long(2_000);
    // The two halves change places. Item by item, one half could stay where it
    // is, the note in it included — but finding that out is four million comparisons.
    const swapped = [...Array.from({ length: 1_000 }, (_, n) => item(1_000 + n)), ...Array.from({ length: 1_000 }, (_, n) => item(n))];
    const out = edited(raw, (doc) => { doc.allowFrom = [...doc.allowFrom.slice(1_000), ...doc.allowFrom.slice(0, 1_000)]; });
    expect(out).toBe(`${head}${swapped.map((value) => `  - ${value}\n`).join("")}\n# end of the list\nlogging:\n  level: info   # quiet\n`);
  });

  it("still keeps the notes of a reordered list of an ordinary size", () => {
    const raw = long(200);
    const out = edited(raw, (doc) => { doc.allowFrom.push(doc.allowFrom.shift()); }); // the first item goes last
    expect(out).toContain(`  - ${item(3)}   # an operator\n`);
    expect(out).toContain(`  - ${item(197)}   # an operator\n`);
    expect(out).toBe(raw.replace(`  - ${item(0)}\n`, "").replace(`  - ${item(199)}\n`, `  - ${item(199)}\n  - ${item(0)}\n`));
  });
});

describe("editYamlText: a key whose value is undefined", () => {
  /* Code that clears a setting writes `block.key = undefined` as readily as
   * `delete block.key`. js-yaml stores neither: a dump leaves such a key out,
   * and writes null for an undefined item of a list. The in-place edit has to
   * mean the same — otherwise one undefined anywhere in the document makes the
   * save fall back to rewriting the whole file, and every comment goes. */

  it("changes nothing for a key that is undefined and was never in the file", () => {
    expect(edited(CONFIG, (doc) => { doc.modelManagement = undefined; doc.gateway.tls = undefined; })).toBe(CONFIG);
  });

  it("takes the line of a key that is set to undefined, exactly as deleting the key does", () => {
    expect(edited(CONFIG, (doc) => { doc.portal.portalName = undefined; })).toBe(CONFIG.replace("  portalName: Ryoko\n", ""));
    expect(edited(CONFIG, (doc) => { doc.cron = undefined; })).toBe(edited(CONFIG, (doc) => { delete doc.cron; }));
  });

  it("edits the rest of the document in place around it", () => {
    const out = edited(CONFIG, (doc) => { doc.logging.file = undefined; doc.gateway.port = 7800; doc.connectors.slack.appToken = undefined; });
    expect(out).toBe(CONFIG.replace("  port: 7777          # where it listens", "  port: 7800          # where it listens"));
  });

  it("leaves an undefined key out of a block it adds", () => {
    const out = edited(CONFIG, (doc) => {
      doc.modelManagement = { notification: undefined, policies: { codex: { mode: "auto", effort: undefined } } };
    });
    expect(out).toBe(`${CONFIG}\nmodelManagement:\n  policies:\n    codex:\n      mode: auto\n`);
  });

  it("writes {} for a mapping whose only keys are undefined", () => {
    const out = edited(CONFIG, (doc) => { doc.logging = { level: undefined }; });
    expect(out).toBe(CONFIG.replace("logging:\n  level: info\n", "logging: {}\n"));
  });

  it("writes null for an undefined item of a list, as a dump does, and keeps the notes of the others", () => {
    const raw = "list:\n  - a   # first\n  - b   # second\n";
    const before = yaml.load(raw) as Doc;
    const out = editYamlText(raw, before, { list: ["a", undefined, "b"] });
    expect(out).toBe("list:\n  - a   # first\n  - null\n  - b   # second\n");
  });

  it("does not hand the caller's document back changed", () => {
    const before = yaml.load(CONFIG) as Doc;
    const after = { ...structuredClone(before), extra: undefined, gateway: { ...before.gateway, port: 7800, tls: undefined } };
    const keys = Object.keys(after.gateway);
    editYamlText(CONFIG, before, after);
    expect(Object.keys(after)).toContain("extra");
    expect(Object.keys(after.gateway)).toEqual(keys);
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

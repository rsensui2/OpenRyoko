import readline from "node:readline";
import { loadConfig } from "../shared/config.js";
import { readConfigSnapshot, writeConfigText } from "../shared/config-file.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Read engines.claude.interactive from config.yaml.
 * Returns undefined when the key is absent (= the user hasn't decided yet) or
 * when the config can't be read — callers treat undefined as "not configured".
 */
export function getInteractiveSetting(): boolean | undefined {
  try {
    const cfg = loadConfig() as { engines?: { claude?: { interactive?: boolean } } };
    return cfg.engines?.claude?.interactive;
  } catch {
    return undefined;
  }
}

/**
 * Set engines.claude.interactive in config.yaml via a LINE-BASED edit so the
 * file's comments + formatting survive (a yaml.dump round-trip would strip them).
 * Only the `claude` engine carries an `interactive:` key, so the first live or
 * commented match is unambiguous; otherwise the key is inserted under `claude:`.
 * Returns true if the file changed.
 *
 * Read and written through the shared config writer: a config.yaml that does
 * not parse is refused rather than edited blind (the error names no line of
 * it), and the edited text is staged next to the file and renamed into place,
 * so a full disk or a crash part-way leaves the previous file whole.
 */
export function setInteractiveSetting(enabled: boolean): boolean {
  const snapshot = readConfigSnapshot();
  if (snapshot.raw === null) throw new Error("config.yaml not found");
  const save = (edited: string[]): void => {
    writeConfigText(snapshot, edited.join("\n"));
  };
  const lines = snapshot.raw.split("\n");
  const indentOf = (l: string) => (l.match(/^(\s*)/)?.[1].length) ?? 0;

  // Locate the engines.claude block STRUCTURALLY so a stray `interactive:` in
  // another engine/section can't be matched (Codex review). engines: at col 0;
  // claude: is its 2-space child; the block runs until the next line indented
  // back to ≤ claude's indent (a sibling key) or column 0.
  const enginesIdx = lines.findIndex((l) => /^engines:\s*(#.*)?$/.test(l));
  if (enginesIdx < 0) throw new Error("engines block not found in config.yaml");

  let claudeIdx = -1;
  for (let i = enginesIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) === 0) break; // left the engines block
    if (/^\s{2}claude:\s*(#.*)?$/.test(lines[i])) { claudeIdx = i; break; }
  }
  if (claudeIdx < 0) throw new Error("engines.claude block not found in config.yaml");

  const claudeIndent = indentOf(lines[claudeIdx]);
  let blockEnd = lines.length;
  for (let i = claudeIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= claudeIndent) { blockEnd = i; break; }
  }
  const childIndent = " ".repeat(claudeIndent + 2);

  // 1) LIVE `interactive:` inside the claude block — replace the value token,
  //    keeping any trailing comment. Matches any value form (true/false/on/off/…).
  for (let i = claudeIdx + 1; i < blockEnd; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    if (/^\s*interactive:\s*\S/.test(lines[i])) {
      const next = lines[i].replace(/(interactive:\s*)\S+/, `$1${enabled}`);
      if (next === lines[i]) return false;
      lines[i] = next;
      save(lines);
      return true;
    }
  }

  // 2) COMMENTED hint inside the block — uncomment + set, keep indent + trailing comment.
  for (let i = claudeIdx + 1; i < blockEnd; i++) {
    const m = lines[i].match(/^(\s*)#\s*interactive:\s*\S+(\s*#.*)?$/);
    if (m) {
      lines[i] = `${m[1]}interactive: ${enabled}${m[2] ?? ""}`;
      save(lines);
      return true;
    }
  }

  // 3) Absent — insert as the first child of the claude block at the child indent.
  lines.splice(claudeIdx + 1, 0, `${childIndent}interactive: ${enabled}`);
  save(lines);
  return true;
}

function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? ` ${DIM}[Y/n]${RESET}` : ` ${DIM}[y/N]${RESET}`;
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

/**
 * Offer to enable the interactive (PTY) Claude engine, then persist the choice.
 *
 * - Skips silently in non-interactive shells (CI / cron / piped) — never blocks
 *   an automated `ryoko update`.
 * - By default only asks when the user hasn't decided yet (key absent). Pass
 *   `{ force: true }` to re-ask even when already set (e.g. fresh `ryoko setup`).
 */
export async function promptInteractive(opts: { force?: boolean } = {}): Promise<void> {
  // Never prompt in automation: no TTY, or a CI runner that allocated a fake one.
  if (!process.stdin.isTTY || process.env.CI) return;
  const current = getInteractiveSetting();
  if (!opts.force && current !== undefined) return;

  console.log("");
  console.log(`  ${YELLOW}Claude をインタラクティブ PTY で動かしますか？${RESET}`);
  console.log(`  ${DIM}ON にすると Claude の作業ターンを PTY（cc_entrypoint=cli）で実行し、Max${RESET}`);
  console.log(`  ${DIM}サブスクリプション課金になります（API 従量課金を回避）。${RESET}`);
  console.log(`  ${DIM}注意: SSH リモート実行の従業員は headless 'claude -p' にフォールバックします。${RESET}`);
  console.log(`  ${DIM}OFF（既定）は従来どおり headless 'claude -p'。後から 'ryoko config interactive on|off' で変更可。${RESET}`);

  const enable = await askYesNo("有効にしますか？", current === true);
  const changed = setInteractiveSetting(enable);
  if (changed) {
    console.log(`  ${GREEN}interactive を ${enable ? "on" : "off"} に設定しました。${RESET} ${DIM}ゲートウェイ再起動で反映されます。${RESET}`);
  } else {
    console.log(`  ${DIM}interactive は既に ${enable ? "on" : "off"} です。${RESET}`);
  }
  console.log("");
}

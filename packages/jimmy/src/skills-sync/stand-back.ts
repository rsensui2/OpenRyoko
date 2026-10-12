import fs from "node:fs";
import path from "node:path";
import { readBounded } from "./bounded-read.js";
import { writeReceipt } from "./receipt.js";

/** Beside the receipt, which belongs to the newer OpenRyoko and is not written to. */
const STAND_BACK_FILE = ".shipped-skills.stood-back.json";

/**
 * A receipt from a newer OpenRyoko switches this one's sync off. That has to be said
 * — the receipt is a file anyone with the home can write, so a forged one is a way to
 * stop bundled skills updating — but not on every start. This remembers what was
 * last said, and answers whether the same thing still needs saying.
 */
export function shouldAnnounceStandBack(skillsRoot: string, notice: { reason: string; ours: string; theirs: string }): boolean {
  const file = path.join(skillsRoot, STAND_BACK_FILE);
  const text = `${JSON.stringify(notice)}\n`;
  try {
    if (readBounded(file, 4096).toString("utf8") === text) return false;
  } catch { /* nothing said yet */ }
  try { writeReceipt(file, text); } catch { /* it will be said again next time */ }
  return true;
}

/** A normal sync ran: the next time this one has to stand back is news again. */
export function forgetStandBack(skillsRoot: string): void {
  const file = path.join(skillsRoot, STAND_BACK_FILE);
  try { fs.lstatSync(file); } catch { return; }
  try { fs.rmSync(file, { force: true }); } catch { /* not ours to insist on */ }
}

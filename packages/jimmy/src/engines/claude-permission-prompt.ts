export interface PermissionPromptOption { position: number; printed: number; label: string; selected: boolean }
export interface ParsedPermissionPrompt { reason?: string; options: PermissionPromptOption[]; selectedPosition: number }

const QUESTION = /^\s*Do you want to proceed\?\s*$/;
const OPTION = /^\s*(❯)?\s*(\d+)\.\s+(\S.*?)\s*$/;
const AFFIRMATIVE = /^yes\b/i;
const NEGATIVE = /^(no|cancel|exit|abort|stop|don'?t|do not|reject|deny)\b/i;

export function parsePermissionPrompt(viewport: readonly string[]): ParsedPermissionPrompt | null {
  let questionRow = -1;
  for (let index = viewport.length - 1; index >= 0; index--) {
    if (QUESTION.test(viewport[index])) { questionRow = index; break; }
  }
  if (questionRow < 0) return null;
  const options: PermissionPromptOption[] = [];
  for (let row = questionRow + 1; row < viewport.length; row++) {
    const match = OPTION.exec(viewport[row]);
    if (!match) {
      if (!viewport[row].trim() && options.length === 0) continue;
      break;
    }
    options.push({ position: options.length, printed: Number(match[2]), label: match[3], selected: match[1] === "❯" });
  }
  const selected = options.filter((option) => option.selected);
  if (options.length < 2 || selected.length !== 1) return null;
  let reason: string | undefined;
  for (let row = questionRow - 1; row >= 0; row--) {
    if (viewport[row].trim()) { reason = viewport[row].trim(); break; }
  }
  return { reason, options, selectedPosition: selected[0].position };
}

export function chooseApproval(prompt: ParsedPermissionPrompt): PermissionPromptOption | null {
  const approvals = prompt.options.filter((option) => AFFIRMATIVE.test(option.label) && !NEGATIVE.test(option.label));
  if (approvals.length === 1) return approvals[0];
  const exact = approvals.filter((option) => option.label.toLowerCase() === "yes");
  return exact.length === 1 ? exact[0] : null;
}

export function keystrokesToSelect(from: number, to: number): string[] {
  const step = to > from ? "\x1b[B" : "\x1b[A";
  return [...Array(Math.abs(to - from)).fill(step), "\r"];
}

export function terminalTextLines(raw: Buffer): string[] {
  return raw.toString("utf8")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .slice(-100);
}

/**
 * Name personalization for the instruction / persona Markdown files.
 * Must match BOTH the Japanese templates ("# X — 運用指示書", "あなたは **X**")
 * and the upstream English forms ("You are **X**", "You are X, the COO ...") —
 * the Web onboarding previously only knew the English forms, so renames from
 * the UI never reached the Japanese files.
 */

/** Pick the name the workspace should carry after an onboarding POST:
 *  the explicitly requested one, else the name already configured, else the
 *  default. Falling back straight to the default would let a language-only
 *  update silently rename a customized assistant back to "Ryoko". */
export function resolveEffectiveName(requested: unknown, current: unknown): string {
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  return pick(requested) ?? pick(current) ?? "Ryoko";
}

export function personalizeInstructionMd(md: string, name: string): string {
  let out = md.replace(
    /^(# ).+( — 運用指示書)$/m,
    (_m, p1: string, p2: string) => p1 + name + p2,
  );
  out = out.replace(
    /^(あなたは \*\*)[^*]+(\*\*)/m,
    (_m, p1: string, p2: string) => p1 + name + p2,
  );
  out = out.replace(/You are \*\*[^*]+\*\*/, () => `You are **${name}**`);
  out = out.replace(
    /^You are \w+, the COO of the user's AI organization\.$/m,
    () => `You are ${name}, the COO of the user's AI organization.`,
  );
  return out;
}

export function personalizeIdentityMd(md: string, name: string): string {
  return md
    .replace(/^(# IDENTITY — ).+$/m, (_m, p1: string) => p1 + name)
    // \n+ tolerates a blank line the onboarding agent may have inserted
    // between the heading and the value; (?!#) refuses to eat the next
    // heading when the section is empty.
    .replace(/^(## Name\n+)(?!#)(.+)$/m, (_m, p1: string) => p1 + name);
}

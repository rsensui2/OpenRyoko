const SECRET_KEY_RE = /(token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?secret|auth)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function redactJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactJson(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? "[REDACTED]" : redactJson(item);
    }
    return out as T;
  }
  return value;
}

export function redactText(input: string): string {
  let text = String(input ?? "");
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  text = text.replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, "$1[REDACTED]");
  text = text.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)[^\s]+/gi, "$1[REDACTED]");
  text = text.replace(/\b((?:sk|pk|rk|xox[baprs]|gh[pousr]|glpat|hf|api)[-_][A-Za-z0-9._-]{8,})\b/g, "[REDACTED]");
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1$2:[REDACTED]@");
  text = text.replace(/("(?:token|secret|password|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?secret|auth)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
  text = text.replace(/^(\s*(?!authorization\b)[\w.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?secret|auth)[\w.-]*\s*:\s*)[^\n#]+/gim, "$1[REDACTED]");
  return text;
}

/** Conservative bound for request Content-Type parsing. Node applies its own
 * header limit on the wire; this also keeps direct handler callers bounded. */
const MEDIA_TYPE_MAX_CHARS = 1024;

function isTokenChar(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9!#$%&'*+.^_`|~-]$/.test(char);
}

function skipSpaces(value: string, start: number): number {
  let index = start;
  while (value[index] === " ") index++;
  return index;
}

function readToken(value: string, start: number): { token: string; next: number } | undefined {
  let next = start;
  while (isTokenChar(value[next])) next++;
  if (next === start) return undefined;
  return { token: value.slice(start, next), next };
}

/** Strict Content-Type predicate for JSON request bodies.
 *
 * Accepts application/json and application/*+json with RFC token or non-empty
 * quoted-string parameters. Parameter names are case-insensitively unique.
 * Controls, malformed quoting, empty values, and comma-joined media types are
 * rejected instead of guessed at. */
export function isJsonMediaType(value: string | string[] | undefined): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MEDIA_TYPE_MAX_CHARS) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;

  let index = skipSpaces(value, 0);
  const type = readToken(value, index);
  if (!type || type.token.toLowerCase() !== "application" || value[type.next] !== "/") return false;
  index = type.next + 1;

  const subtype = readToken(value, index);
  if (!subtype) return false;
  const normalizedSubtype = subtype.token.toLowerCase();
  if (normalizedSubtype !== "json" && !(normalizedSubtype.length > 5 && !normalizedSubtype.startsWith("+") && normalizedSubtype.endsWith("+json"))) {
    return false;
  }
  index = skipSpaces(value, subtype.next);

  const parameterNames = new Set<string>();
  while (index < value.length) {
    if (value[index] !== ";") return false;
    index = skipSpaces(value, index + 1);

    const name = readToken(value, index);
    if (!name) return false;
    const normalizedName = name.token.toLowerCase();
    if (parameterNames.has(normalizedName)) return false;
    parameterNames.add(normalizedName);

    index = skipSpaces(value, name.next);
    if (value[index] !== "=") return false;
    index = skipSpaces(value, index + 1);

    if (value[index] === '"') {
      index++;
      let decodedChars = 0;
      let closed = false;
      while (index < value.length) {
        const char = value[index];
        if (char === '"') {
          index++;
          closed = true;
          break;
        }
        if (char === "\\") {
          index++;
          if (index >= value.length) return false;
        }
        decodedChars++;
        index++;
      }
      if (!closed || decodedChars === 0) return false;
    } else {
      const parameterValue = readToken(value, index);
      if (!parameterValue) return false;
      index = parameterValue.next;
    }
    index = skipSpaces(value, index);
  }
  return true;
}

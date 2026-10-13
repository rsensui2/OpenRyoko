import { terminalText } from "./terminal.js";

/** What a login CLI asked the operator to do, as far as its output shows. */
export interface Discovery {
  url?: string;
  deviceCode?: string;
}

export interface DiscoveryOptions {
  /** The output has gone quiet or ended: a trailing value is complete. */
  final?: boolean;
  /** Hosts the provider signs in on. A link there wins over any other link. */
  preferredHosts?: readonly string[];
  /** Whether this provider shows a device code at all. */
  deviceCode?: boolean;
}

/**
 * A link counts only once whitespace follows it. PTY output arrives in
 * arbitrary chunks, and a link cut off mid-way is still a well-formed link —
 * to the wrong page.
 */
const COMPLETE_HTTPS_URL = /https:\/\/[^\s"'<>`\u0000-\u001f\u007f]+(?=\s)/gi;
const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/g;
/** Any URL-shaped token, finished or not — masked before looking for a code. */
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

const CODE_LABEL = /device[\s_-]*code|user[\s_-]*code|one-time\s+code|verification\s+code|authentication\s+code|access\s+code/gi;
/** Upper case only, and not the tail of a longer token. */
const DEVICE_CODE = /(?<![A-Za-z0-9-])([A-Z0-9]{4}-[A-Z0-9]{4,5})(?=\s)/g;
/** How far after its label a code may start. */
const CODE_WINDOW = 120;

export function isKnownHost(url: string | undefined, hosts: readonly string[]): boolean {
  if (!url) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function isHttpsUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function findUrls(text: string): string[] {
  return [...text.matchAll(COMPLETE_HTTPS_URL)]
    .map((match) => match[0].replace(TRAILING_PUNCTUATION, ""))
    .filter(isHttpsUrl);
}

/**
 * The last device code that follows a label naming it. A bare `ABCD-EFGH`
 * elsewhere in the output is not a code, and neither is one inside a link.
 */
function findDeviceCode(text: string): string | undefined {
  let code: string | undefined;
  for (const label of text.matchAll(CODE_LABEL)) {
    const start = label.index + label[0].length;
    const pattern = new RegExp(DEVICE_CODE.source, "g");
    pattern.lastIndex = start;
    const found = pattern.exec(text);
    if (found && found.index - start <= CODE_WINDOW) code = found[1];
  }
  return code;
}

export function extractDiscovery(raw: string, options: DiscoveryOptions = {}): Discovery {
  const text = terminalText(raw) + (options.final ? "\n" : "");
  const urls = findUrls(text);
  const hosts = options.preferredHosts ?? [];
  const url = urls.filter((candidate) => isKnownHost(candidate, hosts)).at(-1) ?? urls.at(-1);
  const deviceCode = options.deviceCode ? findDeviceCode(text.replace(URL_TOKEN, " ")) : undefined;
  return { ...(url ? { url } : {}), ...(deviceCode ? { deviceCode } : {}) };
}

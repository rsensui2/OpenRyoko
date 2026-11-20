// Sends Slack's install answer (code + state, or error) on to the OpenRyoko
// gateway that started it. Slack only redirects to HTTPS, and most gateways
// run on plain http at a local address, so this static page stands between.
// Nothing is stored or sent anywhere else: the gateway address rides in the
// state, after the last dot, and the code is useless without the app's client
// secret, which only the gateway holds.

export const CALLBACK_PATH = "/api/onboarding/slack/oauth/callback";

function decodeBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The gateway origin carried in the state, or null. */
export function returnOrigin(state) {
  const dot = typeof state === "string" ? state.lastIndexOf(".") : -1;
  if (dot < 0) return null;
  try {
    const url = new URL(decodeBase64Url(state.slice(dot + 1)));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Addresses that can only be the person's own machine or network: forwarded
 *  without a click. Host names are never on the list (anyone can get a public
 *  *.ts.net or similar name), so every name asks for a click first. */
export function isNearbyHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Where to send the browser, or null when the link is not one of ours. */
export function relayTarget(search) {
  const params = new URLSearchParams(search);
  const origin = returnOrigin(params.get("state"));
  if (!origin) return null;
  const forward = new URLSearchParams();
  for (const key of ["code", "state", "error"]) {
    const value = params.get(key);
    if (value !== null) forward.set(key, value);
  }
  return { url: `${origin}${CALLBACK_PATH}?${forward.toString()}`, origin, nearby: isNearbyHost(new URL(origin).hostname) };
}

function show(id) {
  for (const el of document.querySelectorAll("[data-view]")) el.hidden = el.dataset.view !== id;
}

if (typeof document !== "undefined") {
  const target = relayTarget(window.location.search);
  if (!target) {
    show("broken");
  } else if (target.nearby) {
    show("going");
    window.location.replace(target.url);
  } else {
    document.getElementById("origin").textContent = target.origin;
    document.getElementById("continue").href = target.url;
    show("confirm");
  }
}

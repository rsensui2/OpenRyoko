import { describe, expect, it } from "vitest";
import { extractDiscovery, isKnownHost } from "../discovery.js";
import { appendTail, terminalText } from "../terminal.js";

const OPENAI = ["openai.com", "chatgpt.com"];

/** `codex login --device-auth` as a PTY delivers it: ONLCR line ends, SGR colors. */
const CODEX_DEVICE_OUTPUT =
  "\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n"
  + "1. Open this link in your browser and sign in to your account\r\n"
  + "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\r\n\r\n"
  + "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\r\n"
  + "   \u001b[94mFHI3-TCJKF\u001b[0m\r\n\r\n"
  + "\u001b[90mDevice codes are a common phishing target. Never share this code.\u001b[0m\r\n\r\n";

describe("terminalText", () => {
  it("drops color sequences without splitting the token they wrap", () => {
    expect(terminalText("\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\r\n"))
      .toBe("https://auth.openai.com/codex/device\n");
  });

  it("turns cursor movement into a separator so adjacent cells do not fuse", () => {
    const text = terminalText("https://auth.example/device\u001b[1B\u001b[1G2. Enter the code");
    expect(text).toMatch(/https:\/\/auth\.example\/device\s+2\. Enter the code/);
  });

  it("keeps the target of an OSC 8 hyperlink as its own token", () => {
    const text = terminalText("Open \u001b]8;;https://claude.ai/oauth/authorize?state=abc\u001b\\this link\u001b]8;;\u001b\\ now\r\n");
    expect(text).toMatch(/\shttps:\/\/claude\.ai\/oauth\/authorize\?state=abc\s/);
    expect(text).toContain("this link");
    expect(text).not.toContain("\u001b");
  });

  it("removes other OSC sequences and stray control bytes", () => {
    expect(terminalText("\u001b]0;claude\u0007ready\u0007\u001b(B\u001b=\n")).toBe("ready\n");
  });

  it("treats a bare carriage return as a new line (terminal redraws)", () => {
    expect(terminalText("first\rsecond\r\nthird")).toBe("first\nsecond\nthird");
  });
});

describe("appendTail", () => {
  it("keeps only the newest bytes and never splits a UTF-8 character", () => {
    const tail = appendTail("", `Ж${"x".repeat(4095)}`, 4096);
    expect(tail).not.toContain("�");
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
    expect(appendTail("abc", "def", 4)).toBe("cdef");
  });
});

describe("extractDiscovery", () => {
  it("reads the sign-in link and device code from the Codex device flow", () => {
    expect(extractDiscovery(CODEX_DEVICE_OUTPUT, { deviceCode: true, preferredHosts: OPENAI })).toEqual({
      url: "https://auth.openai.com/codex/device",
      deviceCode: "FHI3-TCJKF",
    });
  });

  it("reads the device code across terminal redraws", () => {
    const output = "https://auth.openai.com/codex/device\rEnter this one-time code (expires in 15 minutes)\rAB12-CD345\rContinue only if you started this login in Codex.";
    expect(extractDiscovery(output, { deviceCode: true })).toEqual({
      url: "https://auth.openai.com/codex/device",
      deviceCode: "AB12-CD345",
    });
  });

  it("reports a value only once the terminal has finished writing it", () => {
    const url = "https://auth.openai.com/codex/device?state=secret-state";
    const code = "ABCD-EFGH";
    const output = `Open ${url}\nDevice code: ${code}\n`;
    for (let split = 1; split < output.length; split += 1) {
      const prefix = output.slice(0, split);
      const partial = extractDiscovery(prefix, { deviceCode: true });
      expect(partial.url).toBe(prefix.includes(`${url}\n`) ? url : undefined);
      expect(partial.deviceCode).toBe(prefix.includes(`${code}\n`) ? code : undefined);
    }
    expect(extractDiscovery(output, { deviceCode: true })).toEqual({ url, deviceCode: code });
  });

  it("accepts an unterminated trailing link only when told the output is final", () => {
    expect(extractDiscovery("Open https://auth.example/device").url).toBeUndefined();
    expect(extractDiscovery("Open https://auth.example/device", { final: true }).url).toBe("https://auth.example/device");
  });

  it("does not read half of an escape sequence into the link before it", () => {
    for (const unfinished of ["\u001b", "\u001b[", "\u001b[0", "\u001b]8;;", "\u001b]8;;\u001b"]) {
      expect(extractDiscovery(`Open https://auth.example/device${unfinished}`, { final: true }).url, JSON.stringify(unfinished))
        .toBe("https://auth.example/device");
    }
  });

  it("prefers the provider's own host over a later help link", () => {
    const output = "Open https://auth.openai.com/codex/device\nTrouble? See https://example.com/help\n";
    expect(extractDiscovery(output, { preferredHosts: OPENAI }).url).toBe("https://auth.openai.com/codex/device");
    expect(extractDiscovery("Visit https://docs.example/help\nOpen https://auth.example/device\n", { preferredHosts: OPENAI }).url)
      .toBe("https://auth.example/device");
  });

  it("matches hosts by label, not by suffix", () => {
    expect(isKnownHost("https://auth.openai.com/codex/device", OPENAI)).toBe(true);
    expect(isKnownHost("https://openai.com/", OPENAI)).toBe(true);
    expect(isKnownHost("https://evil-openai.com/device", OPENAI)).toBe(false);
    expect(isKnownHost("https://openai.com.evil.example/device", OPENAI)).toBe(false);
    expect(isKnownHost("not a url", OPENAI)).toBe(false);
  });

  it("strips sentence punctuation from the end of a link", () => {
    expect(extractDiscovery("Open (https://auth.example/device). Then wait\n").url).toBe("https://auth.example/device");
  });

  it("only reads a device code that follows a code label", () => {
    expect(extractDiscovery("warning\nABCD-EFGH\n", { deviceCode: true }).deviceCode).toBeUndefined();
    expect(extractDiscovery("https://example.test/?code=ABCD-EFGH\n", { deviceCode: true }).deviceCode).toBeUndefined();
    expect(extractDiscovery("one-time code: XABCD-EFGH\n", { deviceCode: true }).deviceCode).toBeUndefined();
    expect(extractDiscovery("one-time code: abcd-efgh\n", { deviceCode: true }).deviceCode).toBeUndefined();
  });

  it("does not look for a device code unless the provider uses one", () => {
    expect(extractDiscovery(CODEX_DEVICE_OUTPUT).deviceCode).toBeUndefined();
  });

  it("reads a long OAuth link that arrives as an OSC 8 hyperlink", () => {
    const url = "https://claude.ai/oauth/authorize?code=true&client_id=client123&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=challenge123&state=state123";
    const output = `Sign in: \u001b]8;;${url}\u0007click here\u001b]8;;\u0007\r\n`;
    expect(extractDiscovery(output, { preferredHosts: ["claude.ai"] }).url).toBe(url);
  });
});

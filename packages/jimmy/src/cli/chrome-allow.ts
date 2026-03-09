import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

/** Wildcard TLD patterns — *.com matches anything ending in .com */
const TLDS = [
  "com", "org", "net", "io", "dev", "co", "ai", "app", "me", "us",
  "uk", "de", "fr", "es", "it", "nl", "se", "no", "dk", "fi",
  "jp", "kr", "cn", "in", "au", "nz", "ca", "br", "mx", "ar",
  "ru", "pl", "cz", "at", "ch", "be", "pt", "ie", "bg",
  "edu", "gov", "mil", "info", "biz", "pro", "xyz", "site",
  "online", "tech", "store", "cloud", "design", "world", "today",
  "life", "space", "fun", "club", "page", "so", "is", "im", "la",
  "tv", "fm", "am", "ly", "to", "cc", "gg", "sh", "gl", "tf",
  "ws", "cx", "sx", "ag", "vc", "mobi", "tel", "coop", "aero",
  "jobs", "eu", "asia", "africa", "run", "tools", "systems",
  "software", "solutions", "services", "network", "digital",
  "agency", "studio", "media", "group", "team", "work", "zone",
  "live", "rocks", "ninja", "guru", "land", "house", "center",
  "academy", "link", "click", "help", "how", "watch", "review",
  "guide", "news", "blog", "wiki", "email", "chat", "social",
  "video", "photo", "music", "game", "games", "travel", "health",
  "bio", "eco", "green", "shop", "boutique", "fashion", "style",
  "art", "gallery", "photography", "builders", "construction",
  "energy", "technology", "computer", "mobile", "hosting",
  "domains", "website", "web", "codes", "engineering", "science",
  "legal", "law", "consulting", "training", "education", "school",
  "realty", "estate", "properties", "delivery", "express", "direct",
  "supply", "parts", "tools", "repair", "support", "care",
  "recipes", "restaurant", "bar", "cafe", "pub", "pizza", "coffee",
  "deals", "cheap", "discount", "sale", "rent", "loan", "credit",
  "insurance", "finance", "capital", "fund", "exchange", "market",
  "co.uk", "co.jp", "co.kr", "co.in", "co.nz", "co.za",
  "com.au", "com.br", "com.mx", "com.ar", "com.cn", "com.tw",
  "org.uk", "net.au", "ac.uk",
];

interface BrowserConfig {
  name: string;
  processName: string;
  macAppName: string;
  macDataDir: string;
  linuxDataDir: string;
  winDataDir: string;
}

const BROWSERS: Record<string, BrowserConfig> = {
  chrome: {
    name: "Google Chrome",
    processName: "Google Chrome",
    macAppName: "Google Chrome",
    macDataDir: path.join("Google", "Chrome"),
    linuxDataDir: "google-chrome",
    winDataDir: path.join("Google", "Chrome", "User Data"),
  },
  comet: {
    name: "Comet",
    processName: "Comet",
    macAppName: "Comet",
    macDataDir: "Comet",
    linuxDataDir: "comet",
    winDataDir: "Comet",
  },
};

function getExtensionDbPath(browser: BrowserConfig): string | null {
  const home = os.homedir();
  const platform = os.platform();

  const candidates: string[] = [];
  const profiles = ["Default", "Profile 1", "Profile 2"];

  if (platform === "darwin") {
    for (const profile of profiles) {
      candidates.push(
        path.join(home, "Library", "Application Support", browser.macDataDir, profile, "Local Extension Settings", EXTENSION_ID),
      );
    }
  } else if (platform === "linux") {
    for (const profile of profiles) {
      candidates.push(
        path.join(home, ".config", browser.linuxDataDir, profile, "Local Extension Settings", EXTENSION_ID),
      );
    }
  } else if (platform === "win32") {
    const appData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    for (const profile of profiles) {
      candidates.push(
        path.join(appData, browser.winDataDir, profile, "Local Extension Settings", EXTENSION_ID),
      );
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isBrowserRunning(browser: BrowserConfig): boolean {
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      execSync(`pgrep -x '${browser.processName}'`, { stdio: "ignore" });
    } else if (platform === "linux") {
      execSync(`pgrep -x '${browser.processName.toLowerCase()}'`, { stdio: "ignore" });
    } else if (platform === "win32") {
      const exe = browser.processName.toLowerCase().replace(/ /g, "") + ".exe";
      execSync(`tasklist /FI "IMAGENAME eq ${exe}" | findstr ${exe}`, { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function quitBrowser(browser: BrowserConfig): boolean {
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      execSync(`osascript -e 'tell application "${browser.macAppName}" to quit'`, { stdio: "ignore", timeout: 10000 });
    } else if (platform === "linux") {
      execSync(`pkill -TERM '${browser.processName.toLowerCase()}'`, { stdio: "ignore" });
    } else if (platform === "win32") {
      const exe = browser.processName.toLowerCase().replace(/ /g, "") + ".exe";
      execSync(`taskkill /IM ${exe}`, { stdio: "ignore" });
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!isBrowserRunning(browser)) return true;
      execSync("sleep 0.5");
    }
    return !isBrowserRunning(browser);
  } catch {
    return false;
  }
}

function openBrowser(browser: BrowserConfig): void {
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      execSync(`open -a '${browser.macAppName}'`, { stdio: "ignore" });
    } else if (platform === "linux") {
      execSync(`${browser.processName.toLowerCase()} &`, { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync(`start ${browser.processName.toLowerCase().replace(/ /g, "")}`, { stdio: "ignore" });
    }
  } catch {
    // User can open browser manually
  }
}

async function allowAllForBrowser(browser: BrowserConfig, ClassicLevel: any, opts: { restart?: boolean }): Promise<void> {
  const label = browser.name;

  // Find the extension DB
  const dbPath = getExtensionDbPath(browser);
  if (!dbPath) {
    console.log(`${YELLOW}⚠${RESET} Claude extension not found for ${label} — skipping.`);
    return;
  }

  // Browser must be closed to write to LevelDB
  const wasRunning = isBrowserRunning(browser);
  if (wasRunning) {
    if (opts.restart === false) {
      console.error(`${RED}Error:${RESET} ${label} is running. Close it first or remove ${DIM}--no-restart${RESET}.`);
      process.exit(1);
    }
    console.log(`${YELLOW}Closing ${label}...${RESET}`);
    const closed = quitBrowser(browser);
    if (!closed) {
      console.error(`${RED}Error:${RESET} Failed to close ${label}. Please close it manually and try again.`);
      process.exit(1);
    }
    console.log(`${GREEN}${label} closed.${RESET}`);
  }

  // Open LevelDB and write permissions
  const db = new ClassicLevel(dbPath, { keyEncoding: "utf8", valueEncoding: "utf8" });

  let data: { permissions: any[] };
  try {
    const raw = await db.get("permissionStorage");
    data = JSON.parse(raw);
  } catch {
    data = { permissions: [] };
  }

  const existingNetlocs = new Set(
    data.permissions
      .filter((p: any) => p.scope?.type === "netloc")
      .map((p: any) => p.scope.netloc),
  );

  const now = Date.now();
  let added = 0;
  for (const tld of TLDS) {
    const netloc = `*.${tld}`;
    if (!existingNetlocs.has(netloc)) {
      data.permissions.push({
        action: "allow",
        createdAt: now,
        duration: "always",
        id: randomUUID(),
        scope: { netloc, type: "netloc" },
      });
      added++;
    }
  }

  if (added === 0) {
    console.log(`${GREEN}[${label}]${RESET} All ${TLDS.length} TLD wildcards already present. Nothing to do.`);
  } else {
    await db.put("permissionStorage", JSON.stringify(data));
    console.log(`${GREEN}[${label}]${RESET} ✓ Added ${added} wildcard permissions (${TLDS.length} TLDs covered)`);
  }

  await db.close();

  // Restart browser if it was running
  if (wasRunning && opts.restart !== false) {
    console.log(`${DIM}Reopening ${label}...${RESET}`);
    openBrowser(browser);
    console.log(`${GREEN}[${label}]${RESET} ✓ Restarted. All sites pre-approved.`);
  }
}

export async function runChromeAllow(opts: { restart?: boolean; cometBrowser?: boolean }): Promise<void> {
  // Check for classic-level
  let ClassicLevel: any;
  try {
    const mod = await import("classic-level");
    ClassicLevel = mod.ClassicLevel;
  } catch {
    console.error(`${RED}Error:${RESET} classic-level is required but not installed.`);
    console.error(`Run: ${DIM}npm install -g classic-level${RESET} or ${DIM}pnpm add classic-level${RESET}`);
    process.exit(1);
  }

  const targets: BrowserConfig[] = [];

  if (opts.cometBrowser) {
    targets.push(BROWSERS.comet);
  } else {
    // Default: Chrome only
    targets.push(BROWSERS.chrome);
  }

  for (const browser of targets) {
    await allowAllForBrowser(browser, ClassicLevel, opts);
  }

  console.log(`\n${GREEN}✓${RESET} Done. All sites will be pre-approved for the Claude extension.`);
}

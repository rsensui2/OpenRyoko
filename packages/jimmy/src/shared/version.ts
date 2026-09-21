import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CONFIG_PATH, TEMPLATE_DIR } from "./paths.js";

const DOTTED_NUMERIC_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Return true for migration/package versions represented as three numeric
 * dot-separated segments. This accepts both historical semver-like versions
 * (0.9.0) and OpenRyoko CalVer versions (2026.5.7).
 */
export function isDottedNumericVersion(v: string): boolean {
  return DOTTED_NUMERIC_VERSION.test(v);
}

/**
 * Compare two three-part numeric version strings. Returns negative if a < b,
 * 0 if equal, positive if a > b. Supports both semver-like versions and
 * OpenRyoko CalVer versions such as 2026.10.1.
 */
export function compareSemver(a: string, b: string): number {
  // Local prereleases must retain their numeric version: treating them as
  // 0.0.0 advertises older stable packages as upgrades.
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    return { core: match ? match.slice(1, 4).map(Number) : [0, 0, 0], pre: match?.[4]?.split(".") };
  };
  const va = parse(a), vb = parse(b);
  const pa = va.core, pb = vb.core;
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!va.pre && !vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const left = va.pre[i], right = vb.pre[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln && rn) { const diff = Number(left) - Number(right); if (diff) return diff; continue; }
    if (ln !== rn) return ln ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** Read the package version from jinn-cli's package.json. */
export function getPackageVersion(): string {
  const pkgPath = path.join(TEMPLATE_DIR, "..", "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
}

/** Read the instance version from config.yaml. Returns "0.0.0" if not set. */
export function getInstanceVersion(): string {
  if (!fs.existsSync(CONFIG_PATH)) return "0.0.0";
  try {
    const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
    return config?.jinn?.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * List migration version directories shipped in the template that apply
 * between fromVersion (exclusive) and toVersion (inclusive).
 * Returns sorted ascending by numeric dotted version order.
 */
export function getPendingMigrations(fromVersion: string, toVersion: string): string[] {
  const migrationsDir = path.join(TEMPLATE_DIR, "migrations");
  if (!fs.existsSync(migrationsDir)) return [];

  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((v) => {
      // Only include valid migration version directories. OpenRyoko has
      // historical semver-like migrations and current CalVer migrations; both
      // intentionally use the same three-part numeric shape.
      if (!isDottedNumericVersion(v)) return false;
      return compareSemver(v, fromVersion) > 0 && compareSemver(v, toVersion) <= 0;
    })
    .sort(compareSemver);
}

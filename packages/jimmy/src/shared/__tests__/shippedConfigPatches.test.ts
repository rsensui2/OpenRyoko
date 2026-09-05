import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigPatch } from "../configPatch.js";

/**
 * Guardrail: every `config-patch.json` we ship must parse and validate. A
 * malformed shipped patch would be silently skipped at `ryoko migrate --auto`
 * time (the version still stamps), so the config evolution would be lost with
 * no retry. Catch it here at build/test time instead.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../../../template/migrations");

function shippedPatchFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(MIGRATIONS_DIR, e.name, "config-patch.json"))
    .filter((f) => fs.existsSync(f));
}

describe("shipped config-patch.json files", () => {
  const files = shippedPatchFiles();

  it("has a discoverable migrations directory", () => {
    expect(fs.existsSync(MIGRATIONS_DIR)).toBe(true);
  });

  it.each(files)("parses and validates: %s", (file) => {
    const ops = parseConfigPatch(fs.readFileSync(file, "utf-8"));
    expect(Array.isArray(ops)).toBe(true);
    for (const op of ops) {
      expect(typeof op.path).toBe("string");
      expect(op.path.length).toBeGreaterThan(0);
      expect(Object.prototype.hasOwnProperty.call(op, "to")).toBe(true);
    }
  });
});

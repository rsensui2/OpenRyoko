import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/* What `pnpm build` compiles is what `npm publish` ships: package.json lists
 * dist/ whole. Test code compiled into dist/ therefore lands on every install —
 * the helpers under shared/test-support/ did, and they import vitest, which is
 * not there at runtime. The build's file set is what tsconfig.build.json says
 * it is, so that is what is checked here, with TypeScript's own reading of it;
 * running the build in a test would take a minute and prove no more. */

const packageDir = path.resolve(import.meta.dirname, "..", "..", "..");

/** The files a tsconfig makes tsc start from, relative to the package, as tsc itself works them out. */
function rootFiles(configName: string): string[] {
  const configPath = path.join(packageDir, configName);
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config, ts.sys, packageDir).fileNames.map((file) => path.relative(packageDir, file).split(path.sep).join("/"));
}

/** Where test code lives, by name. */
const TEST_CODE = [/(^|\/)__tests__\//, /(^|\/)test-support\//, /(^|\/)fixtures?\//, /\.(test|spec)\.[cm]?tsx?$/];
const isTestCode = (file: string) => TEST_CODE.some((pattern) => pattern.test(file));
const read = (file: string) => fs.readFileSync(path.join(packageDir, file), "utf-8");
/** Every module specifier a source file imports from, statically or with import(). */
const importsOf = (file: string) =>
  [...read(file).matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((match) => match[1]);

const built = rootFiles("tsconfig.build.json");

describe("what the build compiles, and so what the package ships", () => {
  it("is the product's source: several hundred files, the CLI entry point among them", () => {
    expect(built.length).toBeGreaterThan(200);
    expect(built).toContain("bin/jimmy.ts");
    expect(built).toContain("src/gateway/server.ts");
  });

  it("includes no test code: nothing under __tests__/, test-support/ or fixtures/, and no *.test.* or *.spec.* file", () => {
    expect(built.filter(isTestCode)).toEqual([]);
  });

  it("includes nothing that imports vitest", () => {
    expect(built.filter((file) => importsOf(file).some((specifier) => specifier === "vitest" || specifier.startsWith("vitest/")))).toEqual([]);
  });

  it("does not include the mock engine, which exists for tests and which nothing in the product imports", () => {
    expect(built).not.toContain("src/engines/mock.ts");
    expect(built.filter((file) => importsOf(file).some((specifier) => /(^|\/)mock\.js$/.test(specifier)))).toEqual([]);
  });

  it("reaches no test code by importing it either — an import pulls a file into the build whatever `exclude` says", () => {
    const reaching = built.flatMap((file) => importsOf(file).filter((specifier) => isTestCode(`${specifier.replace(/\.js$/, ".ts")}`)).map((specifier) => `${file} imports ${specifier}`));
    expect(reaching).toEqual([]);
  });

  it("still type-checks the tests: they are left out of the build, not out of the project", () => {
    const checked = rootFiles("tsconfig.json");
    expect(checked).toContain("src/shared/test-support/confined-removals.ts");
    expect(checked).toContain("src/shared/__tests__/build-contents.test.ts");
    expect(checked.filter(isTestCode).length).toBeGreaterThan(100);
  });
});

describe("the other directories the package ships", () => {
  const listed = (dir: string) =>
    fs.readdirSync(path.join(packageDir, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(packageDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));

  it("ships dist/, template/ and scripts/, and nothing else by name", () => {
    expect(JSON.parse(read("package.json")).files).toEqual(["dist/", "template/", "scripts/"]);
  });

  it("has no test code in template/", () => {
    expect(listed("template").filter(isTestCode)).toEqual([]);
  });
});

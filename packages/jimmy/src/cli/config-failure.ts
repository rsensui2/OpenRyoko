import { ConfigNotFoundError, ConfigSyntaxError } from "../shared/config-error.js";
import { CONFIG_PATH } from "../shared/paths.js";

/**
 * What the CLI prints when config.yaml cannot be loaded, or null for any other
 * error: what is wrong and where, then what to do about it.
 *
 * Three errors mean that, and each already words the first line without
 * quoting the file: a config.yaml that does not parse (loadConfig), one a
 * command refused to write over because it could not read it (the config
 * writer), and one that is not there.
 */
export function configFailureLines(error: unknown, configPath: string = CONFIG_PATH): string[] | null {
  if (!(error instanceof Error)) return null;
  if (error instanceof ConfigNotFoundError) return [`エラー: ${error.message}`];
  const unreadable = error instanceof ConfigSyntaxError || (error as { code?: unknown }).code === "CONFIG_UNREADABLE";
  if (!unreadable) return null;
  return [
    `エラー: ${error.message}`,
    `  ${configPath} を修正するか、バックアップから戻して（ryoko backup list / ryoko backup restore <id> --only config）、もう一度実行してください。`,
  ];
}

/**
 * How a CLI command ends when config.yaml cannot be loaded: those lines on
 * stderr and exit code 1. No stack trace — the file is the operator's to fix,
 * and a trace through the CLI's own source says nothing about it. Any other
 * error is thrown on unchanged, to fail the way it always has.
 */
export function exitOnConfigFailure(error: unknown): never {
  const lines = configFailureLines(error);
  if (lines === null) throw error;
  for (const line of lines) console.error(line);
  process.exit(1);
}

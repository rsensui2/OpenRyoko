/**
 * What may be said — logged, printed, sent back by an API route — about a
 * failure to load config.yaml. js-yaml's message for a file it cannot parse
 * quotes the lines around the error, and its reason can name an alias or a tag
 * taken from them. The file holds the bot tokens, so of a parse error only the
 * position is passed on. Any other failure is reported as it is.
 */
export function configErrorForLog(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // By shape, not `instanceof`: the error may come from another copy of js-yaml.
  if (err.name !== "YAMLException" && !("mark" in err)) return err.message;
  const { line, column } = (err as { mark?: { line?: unknown; column?: unknown } }).mark ?? {};
  return typeof line === "number" && typeof column === "number"
    ? `config.yaml is not valid YAML (line ${line + 1}, column ${column + 1})`
    : "config.yaml is not valid YAML";
}

/**
 * config.yaml could not be parsed. Made afresh from the parser's error — which
 * is not kept, not even as `cause`: its message, its stack and its mark all
 * carry a snippet of the file, and callers print errors in every way there is.
 */
export class ConfigSyntaxError extends Error {
  constructor(parserError: unknown) {
    super(configErrorForLog(parserError));
    this.name = "ConfigSyntaxError";
  }
}

/** There is no config.yaml where one is expected: the instance was never set up. */
export class ConfigNotFoundError extends Error {
  constructor(configPath: string) {
    super(`Ryoko config not found at ${configPath}. Run "ryoko setup" first.`);
    this.name = "ConfigNotFoundError";
  }
}

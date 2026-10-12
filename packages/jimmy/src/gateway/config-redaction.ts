/** What GET /api/config shows in place of a secret. PUT /api/config leaves a
 *  value it gets back as this placeholder alone (see SANITIZED_KEYS in api.ts). */
const REDACTED = "***";

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

/** Nothing to hide in an empty value — and nothing to put back for it later. */
const holdsSomething = (value: unknown): boolean => value !== undefined && value !== null && value !== "";

/**
 * The two blocks of a custom MCP server entry that hold secrets as a rule: the
 * environment of the server process (API keys, tokens) and the HTTP headers
 * sent to a remote server (Authorization). The names in them are the
 * operator's own, so no list of key names can tell which values are secret:
 * every value is hidden, and the names stay readable.
 */
const CUSTOM_SERVER_SECRET_BLOCKS = new Set(["env", "headers"]);

/** Every `apiKey` under `value` that holds something, hidden. */
function hideApiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => hideApiKeys(item));
  if (!isMapping(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, key === "apiKey" && child ? REDACTED : hideApiKeys(child)]),
  );
}

/** An env or headers block with its values hidden. Written in a shape nobody
 *  expects (a string, a list), it is hidden whole rather than read. */
function hideBlock(block: unknown): unknown {
  if (!isMapping(block)) return block ? REDACTED : block;
  return Object.fromEntries(Object.entries(block).map(([name, value]) => [name, holdsSomething(value) ? REDACTED : value]));
}

function hideCustomServers(custom: unknown): unknown {
  if (!isMapping(custom)) return custom;
  return Object.fromEntries(
    Object.entries(custom).map(([name, server]) => [
      name,
      isMapping(server)
        ? Object.fromEntries(Object.entries(server).map(([key, value]) => [key, CUSTOM_SERVER_SECRET_BLOCKS.has(key) ? hideBlock(value) : value]))
        : server,
    ]),
  );
}

/**
 * A copy of the config's `mcp` block with its secrets hidden: every `apiKey`
 * (today that is mcp.search.apiKey), and every value of a custom server's
 * `env` and `headers`. Only a value that holds something is replaced; nothing
 * is added where there is none.
 */
export function redactMcpSecrets<T>(mcp: T): T {
  const hidden = hideApiKeys(mcp);
  if (!isMapping(hidden) || !("custom" in hidden)) return hidden as T;
  return { ...hidden, custom: hideCustomServers(hidden.custom) } as T;
}

/**
 * What to store for an env or headers block the request sent, given the block
 * config.yaml holds: the stored value wherever the request still carries the
 * placeholder. A placeholder with nothing stored behind it is left out — "***"
 * is what GET shows, never what a server should be started with. Returns
 * undefined when that leaves nothing to add to a block config.yaml lacks.
 */
function restoreBlock(sent: unknown, stored: unknown): unknown {
  if (sent === REDACTED) return holdsSomething(stored) ? stored : undefined;
  if (!isMapping(sent)) return sent;
  const held = isMapping(stored) ? stored : {};
  const entries = Object.entries(sent).flatMap(([name, value]): [string, unknown][] => {
    if (value !== REDACTED) return [[name, value]];
    return holdsSomething(held[name]) ? [[name, held[name]]] : [];
  });
  const onlyPlaceholders = entries.length === 0 && Object.keys(sent).length > 0;
  return onlyPlaceholders && !isMapping(stored) ? undefined : Object.fromEntries(entries);
}

/**
 * The body of a PUT /api/config with the placeholders under
 * mcp.custom.<server>.env and .headers replaced by what config.yaml holds
 * there. Run before the merge: the merge knows a secret by the name of its key
 * (botToken, apiKey, ...), and these have no such name — left alone, the
 * placeholder would be merged in and stored as the value.
 */
export function restoreCustomMcpSecrets(body: Mapping, onDisk: Mapping): Mapping {
  const mcp = body.mcp;
  if (!isMapping(mcp) || !isMapping(mcp.custom)) return body;
  const diskMcp = onDisk.mcp;
  const stored = isMapping(diskMcp) && isMapping(diskMcp.custom) ? diskMcp.custom : {};
  const custom = Object.fromEntries(
    Object.entries(mcp.custom).map(([name, server]) => {
      if (!isMapping(server)) return [name, server];
      const storedServer = stored[name];
      const held = isMapping(storedServer) ? storedServer : {};
      const restored = Object.entries(server).flatMap(([key, value]): [string, unknown][] => {
        if (!CUSTOM_SERVER_SECRET_BLOCKS.has(key)) return [[key, value]];
        const block = restoreBlock(value, held[key]);
        return block === undefined ? [] : [[key, block]];
      });
      return [name, Object.fromEntries(restored)];
    }),
  );
  return { ...body, mcp: { ...mcp, custom } };
}

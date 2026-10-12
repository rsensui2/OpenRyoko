/** What GET /api/config shows in place of a secret. PUT /api/config leaves a
 *  value it gets back as this placeholder alone (see SANITIZED_KEYS in api.ts). */
const REDACTED = "***";

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What `mapping` itself holds under `key`. Never what every object answers to
 * without holding it — "constructor", "toString", "__proto__": a key in a
 * request is the caller's choice of name, and a built-in is not a stored value.
 */
const own = (mapping: Mapping, key: string): unknown => (Object.hasOwn(mapping, key) ? mapping[key] : undefined);

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

/**
 * Every `apiKey` under `value` that holds something, hidden — but not inside a
 * list. A hidden value has to be put back on PUT from the stored item it was
 * taken from, and a list item has no name to find that item by: hidden, the
 * keys of two items came back swapped for one another. No list in the `mcp`
 * schema carries a key, so nothing that is meant to be there goes unhidden.
 */
function hideApiKeys(value: unknown): unknown {
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
 * outside a list (today that is mcp.search.apiKey), and every value of a
 * custom server's `env` and `headers`. Only a value that holds something is
 * replaced; nothing is added where there is none.
 */
export function redactMcpSecrets<T>(mcp: T): T {
  const hidden = hideApiKeys(mcp);
  if (!isMapping(hidden) || !("custom" in hidden)) return hidden as T;
  return { ...hidden, custom: hideCustomServers(hidden.custom) } as T;
}

/**
 * The item of the stored list that `item` is an update of: the mapping with
 * the same `id`. An item that carries no id is not an update of any stored
 * item — it must not be taken for the first one, whose tokens and fields it
 * would then be given.
 */
export function storedItemWithSameId(stored: unknown, item: unknown): Mapping | undefined {
  if (!Array.isArray(stored) || !isMapping(item)) return undefined;
  const id = item.id;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  return stored.find((candidate): candidate is Mapping => isMapping(candidate) && candidate.id === id);
}

/**
 * `value` without its placeholders: every "***" under one of `secretKeys` is
 * left out, at any depth. For what a request adds where config.yaml has
 * nothing — "***" means "keep what is stored", and with nothing stored the
 * placeholder itself would be saved as the token.
 */
export function withoutPlaceholders(value: unknown, secretKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutPlaceholders(item, secretKeys));
  if (!isMapping(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]): [string, unknown][] =>
      secretKeys.has(key) && child === REDACTED ? [] : [[key, withoutPlaceholders(child, secretKeys)]],
    ),
  );
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
    const kept = own(held, name);
    return holdsSomething(kept) ? [[name, kept]] : [];
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
      const storedServer = own(stored, name);
      const held = isMapping(storedServer) ? storedServer : {};
      const restored = Object.entries(server).flatMap(([key, value]): [string, unknown][] => {
        if (!CUSTOM_SERVER_SECRET_BLOCKS.has(key)) return [[key, value]];
        const block = restoreBlock(value, own(held, key));
        return block === undefined ? [] : [[key, block]];
      });
      return [name, Object.fromEntries(restored)];
    }),
  );
  return { ...body, mcp: { ...mcp, custom } };
}

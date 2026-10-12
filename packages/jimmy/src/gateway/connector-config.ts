/**
 * The settings a connector is constructed with: everything config.yaml says
 * about it — the block under its key (`connectors.slack`), or its entry in
 * `connectors.instances`.
 *
 * The gateway makes connectors in three places: at the top level, for each
 * instance at boot, and for each instance again when the config is reloaded.
 * Each used to hand the settings over in its own way. The top-level Slack
 * connector got a hand-written list of keys, so a key missing from the list
 * was silently ignored there and honoured for an instance: `respondTo` and
 * `maxAttachmentMb` did nothing at the top level, where the documentation
 * shows them. An instance, in turn, never got its `employee`. Every place
 * goes through here now, so a setting cannot reach a connector from one of
 * them and not from another.
 *
 * Only `type` is left out — it says which connector to make, not how. The
 * result is a copy: a connector that tidies its settings (Discord turns its
 * IDs into strings) does not edit the gateway's own config.
 */
export function connectorConfig<T extends object>(written: T): Omit<T, "type"> {
  const { type: _type, ...settings } = written as T & { type?: unknown };
  return settings;
}

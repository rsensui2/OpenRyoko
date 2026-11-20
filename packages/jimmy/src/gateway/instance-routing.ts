import { logger } from "../shared/logger.js";
import type { Employee } from "../shared/types.js";
import type { RouteOptions } from "../sessions/manager.js";

/**
 * How a message that arrived on a named connector instance is routed: to the
 * employee (or peer Ryoko) the instance is bound to, or to the main assistant
 * when it names none. null means drop it without a reply: the instance names
 * an employee that does not exist (deleted, renamed, or a YAML that no longer
 * parses). Falling through to the main assistant would answer that bot's
 * users as a different assistant, with that assistant's memory.
 */
export function instanceRouteOptions(
  instanceId: string,
  employee: string | undefined,
  registry: ReadonlyMap<string, Employee>,
): RouteOptions | null {
  if (!employee) return {};
  const found = registry.get(employee);
  if (!found) {
    logger.warn(`Connector instance "${instanceId}" is bound to employee "${employee}", which does not exist — message dropped without a reply`);
    return null;
  }
  return { employee: found };
}

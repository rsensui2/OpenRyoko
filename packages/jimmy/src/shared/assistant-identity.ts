import type { Employee } from "./types.js";

/** The same assistant name must identify the routing gate and the worker. */
export function resolveAssistantName(
  portalName?: string,
  employee?: Pick<Employee, "displayName" | "name">,
): string {
  return employee?.displayName?.trim() || employee?.name?.trim() || portalName?.trim() || "Ryoko";
}

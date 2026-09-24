import type { ModelInfo } from "../shared/types.js";
import type { ManagedEngine } from "./discovery.js";

/** Family names come from the installed CLI catalog, not a release-specific list. */
export function modelFamily(engine: string, id: string): string | undefined {
  if (engine === "codex") return /^gpt-(?:\d+(?:\.\d+)*|future)-([a-z][a-z0-9]*)(?:-|$)/.exec(id)?.[1];
  if (engine === "claude") return /^claude-([a-z][a-z0-9]*)-/.exec(id)?.[1] ?? /^(opus|sonnet|haiku|fable)(?:\[1m\])?$/.exec(id)?.[1];
  return undefined;
}

/** Compare numeric generations; retain CLI order for variants of the same version. */
export function familyModel<T extends ModelInfo>(engine: string, models: T[], family: string): T | undefined {
  const version = (id: string) => (engine === "codex" ? /^gpt-([0-9.]+)/.exec(id)?.[1] : /^claude-[a-z0-9]+-([0-9.-]+)/.exec(id)?.[1])?.split(/[.-]/).map(Number);
  return models.filter(m => modelFamily(engine, m.id) === family).sort((a, b) => {
    const av = version(a.id), bv = version(b.id);
    if (!av || !bv) return 0;
    for (let i = 0; i < Math.max(av.length, bv.length); i++) { const diff = (bv[i] ?? 0) - (av[i] ?? 0); if (diff) return diff; }
    return 0;
  })[0];
}
export function modelFamilies(engine: string, models: ModelInfo[]) {
  return [...new Set(models.map(m => modelFamily(engine, m.id)).filter((f): f is string => Boolean(f)))].sort((a, b) => {
    const order = Object.keys(defaultFamilyFallbacks[engine as ManagedEngine] ?? {});
    const rank = (f: string) => order.includes(f) ? order.indexOf(f) : order.length;
    return rank(a) - rank(b);
  }).map(family => ({
    family, label: family[0].toUpperCase() + family.slice(1), model: familyModel(engine, models, family)!.id,
  }));
}
export const defaultFamilyFallbacks: Record<ManagedEngine, Record<string, string>> = {
  codex: { astra: "fable", sol: "opus", terra: "sonnet", luna: "haiku" },
  claude: { fable: "astra", opus: "sol", sonnet: "terra", haiku: "luna" },
};
export const effortOrder = ["low", "medium", "high", "xhigh", "max"] as const;
/** Preserve the requested depth when supported; otherwise round down, never up. */
export function compatibleEffort(requested: string | undefined, levels: string[]): string | undefined {
  if (!levels.length) return undefined;
  if (requested && levels.includes(requested)) return requested;
  const rank = effortOrder.indexOf((requested ?? "medium") as typeof effortOrder[number]);
  return [...effortOrder].reverse().find((level) => effortOrder.indexOf(level) <= (rank < 0 ? 1 : rank) && levels.includes(level)) ?? effortOrder.find(level => levels.includes(level));
}

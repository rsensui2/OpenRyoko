/** Shared by API settings, onboarding and model management. */
let chain: Promise<void> = Promise.resolve();
export function withConfigLock<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

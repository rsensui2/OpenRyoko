import { logger } from "../shared/logger.js";
import { onProviderAuthFailure } from "./failure-signal.js";
import { resolveProviderCommand, runStatusCommand, spawnLoginPty, SYSTEM_CLOCK } from "./runtime.js";
import { ProviderAuthService } from "./service.js";

export { PROVIDERS, AUTH_PROVIDERS, isAuthProvider } from "./providers.js";
export { looksLikeAuthSecret, parseAuthInput } from "./input.js";
export { ProviderAuthService } from "./service.js";
export type {
  AuthFailureNotifier, AuthProvider, FlowListener, FlowOutcome, FlowPrompt, InputResult, ProviderAuthPort, StartResult,
} from "./types.js";

let shared: ProviderAuthService | undefined;

/**
 * The gateway's one flow engine. A provider's credentials are a property of
 * the host, not of a connector, so "one login per provider at a time" has to
 * hold across every connector that can start one.
 *
 * Created on first use — that is, when a connector opts in. Until then nothing
 * listens to the engine run path and no login can be started.
 */
export function getProviderAuthService(): ProviderAuthService {
  if (shared) return shared;
  const service = new ProviderAuthService({
    resolveCommand: (provider) => resolveProviderCommand(provider),
    spawnPty: spawnLoginPty,
    runCommand: runStatusCommand,
    clock: SYSTEM_CLOCK,
    logger,
  });
  onProviderAuthFailure((provider) => service.reportAuthFailure(provider));
  shared = service;
  return service;
}

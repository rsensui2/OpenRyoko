/** TypeSafe-specific view of the decision-provider credential store. Never place keys in config or logs. */
import { JINN_HOME } from "./paths.js";
import {
  DecisionCredentialError, decisionCredentialPath, deleteDecisionApiKey, getDecisionCredentialStatus,
  resolveDecisionApiKey, saveDecisionApiKey, type DecisionCredentialStatus,
} from "./decision-credentials.js";

export type TypeSafeCredentialStatus = DecisionCredentialStatus;
export { DecisionCredentialError as TypeSafeCredentialError };

export function typeSafeCredentialPath(home = JINN_HOME): string {
  return decisionCredentialPath("typesafe", home);
}

/** Default env uses the UI credential first. A custom env is an explicit isolated choice. */
export function resolveTypeSafeApiKey(apiKeyEnv?: string, home = JINN_HOME): string | undefined {
  return resolveDecisionApiKey("typesafe", apiKeyEnv, home);
}

export function getTypeSafeCredentialStatus(home = JINN_HOME): TypeSafeCredentialStatus {
  return getDecisionCredentialStatus("typesafe", home);
}

export function saveTypeSafeApiKey(apiKey: unknown, home = JINN_HOME): TypeSafeCredentialStatus {
  return saveDecisionApiKey("typesafe", apiKey, home);
}

/** Remove only the dashboard credential. Existing environment configuration is retained. */
export function deleteTypeSafeApiKey(home = JINN_HOME): TypeSafeCredentialStatus {
  return deleteDecisionApiKey("typesafe", home);
}

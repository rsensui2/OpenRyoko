/** Legacy TypeSafe key routes; delegates to the generic decision-provider key handler. */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleProviderCredentialApi, testDecisionProvider,
  type DecisionTestResult, type IntegrationContext,
} from "./integrations-decision-keys-api.js";
import type { ParsedRoute } from "./route-helpers.js";

const ROOT = "/api/integrations/typesafe";
export type TypeSafeTestResult = DecisionTestResult;

/** Fixed-origin connection probe. No Slack data, API key, or provider output is returned. */
export function testTypeSafeConnection(): Promise<TypeSafeTestResult> {
  return testDecisionProvider("typesafe");
}

export function handleTypeSafeIntegrationApi(
  req: IncomingMessage, res: ServerResponse, route: ParsedRoute, context: IntegrationContext,
): Promise<boolean> {
  return handleProviderCredentialApi(req, res, route, context, "typesafe", ROOT);
}

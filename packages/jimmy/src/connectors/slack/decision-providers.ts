/**
 * Decision-model provider profiles for Jev triage. Each profile pins a fixed
 * HTTPS endpoint, accepted model ids and the wire adapters between the internal
 * System One (Jev) shape and the provider's request/response shape.
 * Adapters never guess: anything they cannot map exactly yields `undefined`.
 */
import { isDecisionProvider, type DecisionProvider } from "../../shared/decision-credentials.js";

export { isDecisionProvider, type DecisionProvider };

export interface SystemOneQuestion {
  readonly type: "choice" | "noul";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}
export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Readonly<Record<string, SystemOneQuestion>>;
}

export interface DecisionProviderProfile {
  /** Fixed destination. Slack text is only ever sent here (or to a loopback endpoint). */
  endpoint: string;
  defaultModel: string;
  /** Configured model ids accepted for the request. */
  requestModel: RegExp;
  /** Model ids accepted in the response body. */
  responseModel: RegExp;
  /** Whose credential is sent; it is never sent to another provider's endpoint. */
  credential: DecisionProvider;
  toWire(request: SystemOneRequest): unknown;
  /** Returns a System One response (`answers` keyed by name), or undefined when malformed/refused. */
  fromWire(raw: unknown, request: SystemOneRequest): unknown;
}

const JEV_MODEL = /^jev-[\w.-]{1,64}$/;
const OPENROUTER_MODEL = /^(?:~?typesafe\/)?jev-[\w.-]{1,64}$/;
const OPENAI_MODEL = /^gpt-6-luna$/;
const OPENAI_RESPONSE_MODEL = /^gpt-6-luna[\w.-]{0,64}$/;
// Local Jev-compatible servers (e.g. Ollama decision models) use their own model names such as "nimble" or "tev1:0.8b".
const LOCAL_MODEL = /^[A-Za-z0-9][\w.:-]{0,63}$/;

const identity = (value: unknown) => value;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Jev questions → OpenAI Decisions `questions` array. A Noul becomes a predicate with its criteria spelled out. */
export function toOpenAiDecisionsRequest(request: SystemOneRequest) {
  return {
    model: request.model,
    input: JSON.stringify(request.state),
    questions: Object.entries(request.questions).map(([name, question]) => question.type === "noul"
      ? {
        type: "predicate" as const, name,
        instructions: `${question.instructions} Answer true when: ${question.criteria.true} Answer false when: ${question.criteria.false}`,
      }
      : {
        type: "choice" as const, name, instructions: question.instructions,
        choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })),
      }),
  };
}

function choiceProbabilities(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return;
  const entries: [string, unknown][] = [];
  for (const item of value) {
    if (!record(item) || typeof item.value !== "string" || entries.some(([seen]) => seen === item.value)) return;
    entries.push([item.value, item.probability]);
  }
  return Object.fromEntries(entries);
}

function fromOpenAiAnswer(answer: Record<string, unknown>, question: SystemOneQuestion): Record<string, unknown> | undefined {
  // A refusal (or any unknown answer type) must never become a decision.
  if (answer.type === "predicate" && question.type === "noul") {
    return { type: "noul", noul: answer.probability };
  }
  if (answer.type === "choice" && question.type === "choice") {
    const probabilities = choiceProbabilities(answer.probabilities);
    if (!probabilities || typeof answer.choice !== "string") return;
    return { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities };
  }
  return undefined;
}

/**
 * OpenAI Decisions response → System One response. Numeric ranges and
 * distributions are validated afterwards by the shared Jev parser.
 */
export function fromOpenAiDecisionsResponse(raw: unknown, request: SystemOneRequest): Record<string, unknown> | undefined {
  if (!record(raw) || !Array.isArray(raw.answers) || !record(raw.usage)) return;
  const outputTokens = raw.usage.output_tokens ?? 0; // output tokens are not charged and may be omitted
  if (!tokenCount(raw.usage.input_tokens) || !tokenCount(outputTokens)) return;
  const answers: Record<string, unknown> = {};
  for (const answer of raw.answers) {
    if (!record(answer) || typeof answer.name !== "string" || !Object.hasOwn(request.questions, answer.name)
      || Object.hasOwn(answers, answer.name)) return;
    const converted = fromOpenAiAnswer(answer, request.questions[answer.name]);
    if (!converted) return;
    answers[answer.name] = converted;
  }
  return { model: raw.model, answers, usage: { input_tokens: raw.usage.input_tokens, output_tokens: outputTokens } };
}

export const DECISION_PROVIDER_PROFILES: Readonly<Record<DecisionProvider, DecisionProviderProfile>> = {
  typesafe: {
    endpoint: "https://api.typesafe.ai/v1/systemone",
    defaultModel: "jev-1.13.0",
    requestModel: JEV_MODEL,
    responseModel: JEV_MODEL,
    credential: "typesafe",
    toWire: identity,
    fromWire: identity,
  },
  openrouter: {
    // Same System One shape; extra response fields (id, provider, usage.cost) are ignored by the parser.
    endpoint: "https://openrouter.ai/api/v1/systemone",
    defaultModel: "typesafe/jev-1.13",
    requestModel: OPENROUTER_MODEL,
    responseModel: OPENROUTER_MODEL,
    credential: "openrouter",
    toWire: identity,
    fromWire: identity,
  },
  openai: {
    endpoint: "https://api.openai.com/v1/decisions",
    defaultModel: "gpt-6-luna",
    requestModel: OPENAI_MODEL,
    responseModel: OPENAI_RESPONSE_MODEL,
    credential: "openai",
    toWire: toOpenAiDecisionsRequest,
    fromWire: fromOpenAiDecisionsResponse,
  },
};

/** Loopback System One server: no credential, its own model names. Endpoint is supplied by config. */
export const LOCAL_DECISION_PROFILE: Omit<DecisionProviderProfile, "endpoint" | "credential"> = {
  defaultModel: "jev-1.13.0",
  requestModel: LOCAL_MODEL,
  responseModel: LOCAL_MODEL,
  toWire: identity,
  fromWire: identity,
};

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildJevTriageRequest, evaluateJevTriage, JEV_TRIAGE_QUESTIONS } from "../triage-jev.js";
import {
  DECISION_PROVIDER_PROFILES, fromOpenAiDecisionsResponse, toOpenAiDecisionsRequest,
} from "../decision-providers.js";
import { decisionCredentialPath, saveDecisionApiKey } from "../../../shared/decision-credentials.js";
import type { TriagePromptInput } from "../triage-prompt.js";

const KEYS = {
  typesafe: "typesafe-test-key-fixture",
  openrouter: "openrouter-test-key-fixture",
  openai: "openai-test-key-fixture",
} as const;
const input: TriagePromptInput = {
  botName: "Ryoko", persona: "仕事を手伝うAI", operatorName: "亮介",
  channelType: "channel", channelDescription: "#general", speakerName: "太郎",
  speakerIsOperator: false, wasMentioned: false, recentThread: [],
  messageText: "田中さん、明日の予定を確認お願いします",
};
const CHOICES: Record<string, string> = {
  recipient: "other_human", intent: "request", relation: "unrelated", acknowledgment: "none",
};

/** System One (TypeSafe/OpenRouter) body: confident "addressed to another human" → silent. */
function systemOneBody(model = "jev-1.13.0"): any {
  return {
    model,
    answers: Object.fromEntries(Object.entries(JEV_TRIAGE_QUESTIONS).map(([axis, question]) => {
      if (question.type === "noul") return [axis, { type: "noul", noul: 0 }];
      const keys = Object.keys(question.criteria);
      return [axis, { type: "choice", choice: CHOICES[axis], confidence: 1,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === CHOICES[axis] ? 1 : 0])) }];
    })),
    usage: { input_tokens: 500, output_tokens: 80 },
  };
}

/** The same decision in the OpenAI Decisions response shape. */
function openAiBody(model = "gpt-6-luna-2026-11-01"): any {
  const jev = systemOneBody();
  return {
    model,
    answers: Object.entries(jev.answers).map(([name, answer]: [string, any]) => answer.type === "noul"
      ? { type: "predicate", name, probability: answer.noul }
      : { type: "choice", name, choice: answer.choice, confidence: answer.confidence,
        probabilities: Object.entries(answer.probabilities).map(([value, probability]) => ({ value, probability })) }),
    usage: { input_tokens: 700 },
  };
}

const transport = (body: unknown) => vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
const sent = (fetchImpl: ReturnType<typeof transport>) => {
  const [url, init] = fetchImpl.mock.calls[0];
  return { url, init: init!, body: JSON.parse(init!.body as string) };
};

beforeEach(() => {
  fs.rmSync(path.dirname(decisionCredentialPath("typesafe")), { recursive: true, force: true });
  vi.stubEnv("TYPESAFE_API_KEY", KEYS.typesafe);
  vi.stubEnv("OPENROUTER_API_KEY", KEYS.openrouter);
  vi.stubEnv("OPENAI_API_KEY", KEYS.openai);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(path.dirname(decisionCredentialPath("typesafe")), { recursive: true, force: true });
});

describe("decision providers: request shape and destination", () => {
  it("defaults to TypeSafe with its own key", async () => {
    const fetchImpl = transport(systemOneBody());
    expect(await evaluateJevTriage(input, { fetchImpl })).toMatchObject({ status: "accepted", metadata: { provider: "typesafe" } });
    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEYS.typesafe}`, "Content-Type": "application/json" });
    expect(body).toEqual(JSON.parse(JSON.stringify(buildJevTriageRequest(input))));
  });

  it("sends the System One shape to OpenRouter with the OpenRouter key and ignores extra response fields", async () => {
    const response = { ...systemOneBody("typesafe/jev-1.13"), id: "gen-1", provider: "TypeSafe",
      usage: { input_tokens: 500, output_tokens: 80, cost: 0.0004 } };
    const fetchImpl = transport(response);
    const result = await evaluateJevTriage(input, { provider: "openrouter", fetchImpl });
    expect(result).toMatchObject({ status: "accepted", decision: { action: "silent" },
      metadata: { provider: "openrouter", model: "typesafe/jev-1.13", inputTokens: 500, outputTokens: 80 } });
    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEYS.openrouter}`, "Content-Type": "application/json" });
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.questions).toEqual(JSON.parse(JSON.stringify(buildJevTriageRequest(input).questions)));
  });

  it.each(["typesafe/jev-1.13", "jev-1.13.0", "~typesafe/jev-latest", "typesafe/jev-2.0-beta"])("accepts OpenRouter model %s", async (model) => {
    const fetchImpl = transport(systemOneBody(model));
    expect(await evaluateJevTriage(input, { provider: "openrouter", model, fetchImpl })).toMatchObject({ status: "accepted" });
    expect(sent(fetchImpl).body.model).toBe(model);
  });

  it.each(["openai/gpt-6-luna", "typesafe/other-1", "~jev-latest", "other/jev-1", "typesafe/jev-"])("rejects OpenRouter model %s", async (model) => {
    const fetchImpl = transport(systemOneBody());
    expect(await evaluateJevTriage(input, { provider: "openrouter", model, fetchImpl })).toMatchObject({ status: "fallback", reason: "invalid_config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an OpenRouter response from a non-Jev model", async () => {
    expect(await evaluateJevTriage(input, { provider: "openrouter", fetchImpl: transport(systemOneBody("openai/gpt-5")) }))
      .toMatchObject({ status: "fallback", reason: "invalid_response" });
  });

  it("sends the Decisions shape to OpenAI with the OpenAI key", async () => {
    const fetchImpl = transport(openAiBody());
    const result = await evaluateJevTriage(input, { provider: "openai", fetchImpl });
    expect(result).toMatchObject({ status: "accepted", decision: { action: "silent", reason: "jev_other_recipient" },
      metadata: { provider: "openai", model: "gpt-6-luna-2026-11-01", inputTokens: 700, outputTokens: 0 } });
    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEYS.openai}`, "Content-Type": "application/json" });
    expect(Object.keys(body).sort()).toEqual(["input", "model", "questions"]);
    expect(body.model).toBe("gpt-6-luna");
    expect(JSON.parse(body.input)).toEqual(JSON.parse(JSON.stringify(buildJevTriageRequest(input).state)));
    expect(body.questions.map((question: any) => question.name)).toEqual(Object.keys(JEV_TRIAGE_QUESTIONS));
  });

  it.each(["gpt-6", "gpt-6-luna-mini", "jev-1.13.0", "typesafe/jev-1.13"])("allows only gpt-6-luna for OpenAI, not %s", async (model) => {
    const fetchImpl = transport(openAiBody());
    expect(await evaluateJevTriage(input, { provider: "openai", model, fetchImpl })).toMatchObject({ status: "fallback", reason: "invalid_config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["OpenAI", "anthropic", "", 1, null])("treats an unknown provider %j as invalid config", async (provider) => {
    const fetchImpl = transport(systemOneBody());
    expect(await evaluateJevTriage(input, { provider: provider as never, fetchImpl }))
      .toMatchObject({ status: "fallback", reason: "invalid_config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects another provider's fixed endpoint as an override", async () => {
    const fetchImpl = transport(systemOneBody());
    expect(await evaluateJevTriage(input, { provider: "openrouter", endpoint: "https://api.typesafe.ai/v1/systemone", fetchImpl }))
      .toMatchObject({ status: "fallback", reason: "invalid_config" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const openai = transport(openAiBody());
    expect(await evaluateJevTriage(input, { provider: "openai", endpoint: "https://api.openai.com/v1/decisions", fetchImpl: openai }))
      .toMatchObject({ status: "accepted" });
    expect(sent(openai).url).toBe("https://api.openai.com/v1/decisions");
  });
});

describe("decision providers: credentials", () => {
  it.each(["typesafe", "openrouter", "openai"] as const)("sends only the %s key, only to its own endpoint", async (provider) => {
    const fetchImpl = transport(provider === "openai" ? openAiBody() : systemOneBody(provider === "openrouter" ? "typesafe/jev-1.13" : "jev-1.13.0"));
    await evaluateJevTriage(input, { provider, fetchImpl });
    const { url, init } = sent(fetchImpl);
    expect(url).toBe(DECISION_PROVIDER_PROFILES[provider].endpoint);
    const serialized = JSON.stringify(init);
    for (const [owner, key] of Object.entries(KEYS)) {
      if (owner === provider) expect(serialized).toContain(key);
      else expect(serialized).not.toContain(key);
    }
  });

  it("uses the stored per-provider key before the environment", async () => {
    saveDecisionApiKey("openai", "openai-stored-key-fixture");
    const fetchImpl = transport(openAiBody());
    await evaluateJevTriage(input, { provider: "openai", fetchImpl });
    expect(sent(fetchImpl).init.headers).toMatchObject({ Authorization: "Bearer openai-stored-key-fixture" });
  });

  it("never reads apiKeyEnv for non-TypeSafe providers", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchImpl = transport(openAiBody());
    expect(await evaluateJevTriage(input, { provider: "openai", apiKeyEnv: "TYPESAFE_API_KEY", fetchImpl }))
      .toMatchObject({ status: "fallback", reason: "missing_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps apiKeyEnv working for TypeSafe", async () => {
    vi.stubEnv("JEV_CUSTOM_KEY", "custom-typesafe-key-fixture");
    const fetchImpl = transport(systemOneBody());
    await evaluateJevTriage(input, { apiKeyEnv: "JEV_CUSTOM_KEY", fetchImpl });
    expect(sent(fetchImpl).init.headers).toMatchObject({ Authorization: "Bearer custom-typesafe-key-fixture" });
  });

  it.each(["typesafe", "openrouter", "openai"] as const)("a loopback endpoint takes precedence over %s and receives no key", async (provider) => {
    const fetchImpl = transport(systemOneBody("nimble"));
    const result = await evaluateJevTriage(input, { provider, endpoint: "http://127.0.0.1:11434/v1/systemone", model: "nimble", fetchImpl });
    expect(result).toMatchObject({ status: "accepted", metadata: { provider: "local" } });
    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe("http://127.0.0.1:11434/v1/systemone");
    expect(body).toHaveProperty("state");
    expect(body).not.toHaveProperty("input");
    const serialized = JSON.stringify(init);
    for (const key of Object.values(KEYS)) expect(serialized).not.toContain(key);
  });
});

describe("OpenAI Decisions adapter", () => {
  const request = buildJevTriageRequest(input);

  it("maps choice questions to choices and Noul to a predicate carrying its criteria", () => {
    const wire = toOpenAiDecisionsRequest(request);
    expect(wire.input).toBe(JSON.stringify(request.state));
    const recipient = wire.questions.find((question) => question.name === "recipient");
    expect(recipient).toEqual({ type: "choice", name: "recipient", instructions: request.questions.recipient.instructions,
      choices: Object.entries(request.questions.recipient.criteria).map(([value, description]) => ({ value, description })) });
    const predicate = wire.questions.find((question) => question.name === "response_value");
    expect(predicate).not.toHaveProperty("choices");
    expect(predicate).toMatchObject({ type: "predicate", name: "response_value" });
    expect(predicate!.instructions).toContain(request.questions.response_value.instructions);
    expect(predicate!.instructions).toContain(`Answer true when: ${JEV_TRIAGE_QUESTIONS.response_value.criteria.true}`);
    expect(predicate!.instructions).toContain(`Answer false when: ${JEV_TRIAGE_QUESTIONS.response_value.criteria.false}`);
  });

  it("maps answers back into the Jev shape keyed by name", () => {
    const converted = fromOpenAiDecisionsResponse(openAiBody(), request) as any;
    const expected = systemOneBody();
    expect(converted.model).toBe("gpt-6-luna-2026-11-01");
    expect(converted.answers).toEqual(expected.answers);
    expect(converted.usage).toEqual({ input_tokens: 700, output_tokens: 0 });
    const withOutput = openAiBody();
    withOutput.usage.output_tokens = 3;
    expect((fromOpenAiDecisionsResponse(withOutput, request) as any).usage.output_tokens).toBe(3);
  });

  const malformed: [string, (body: any) => void][] = [
    ["a refusal", (body) => { body.answers[0] = { type: "refusal", name: body.answers[0].name, refusal: "no" }; }],
    ["a predicate for a choice question", (body) => { body.answers[0] = { type: "predicate", name: "recipient", probability: 1 }; }],
    ["a choice for a Noul question", (body) => { body.answers[3] = { ...body.answers[0], name: "response_value" }; }],
    ["a duplicate answer", (body) => { body.answers[1] = { ...body.answers[0] }; }],
    ["an unknown name", (body) => { body.answers[0].name = "other"; }],
    ["a missing answer", (body) => { body.answers.pop(); }],
    ["duplicate choice values", (body) => { body.answers[0].probabilities[1].value = body.answers[0].probabilities[0].value; }],
    ["object probabilities", (body) => { body.answers[0].probabilities = { other_human: 1 }; }],
    ["an out-of-range predicate", (body) => { body.answers[3].probability = 1.5; }],
    ["answers as an object", (body) => { body.answers = {}; }],
    ["missing usage", (body) => { delete body.usage; }],
    ["fractional input tokens", (body) => { body.usage.input_tokens = 1.5; }],
    ["negative output tokens", (body) => { body.usage.output_tokens = -1; }],
    ["a non-OpenAI model", (body) => { body.model = "jev-1.13.0"; }],
    ["a different OpenAI model", (body) => { body.model = "gpt-6"; }],
  ];
  it.each(malformed)("falls back on %s instead of guessing", async (_label, mutate) => {
    const body = openAiBody();
    mutate(body);
    expect(await evaluateJevTriage(input, { provider: "openai", fetchImpl: transport(body) }))
      .toMatchObject({ status: "fallback", reason: "invalid_response" });
  });
});

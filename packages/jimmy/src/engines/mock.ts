import { randomUUID } from "node:crypto";
import type { Engine, EngineRunOpts, EngineResult } from "../shared/types.js";

const CANNED_RESPONSES = [
  "This is a mock engine response for testing purposes.",
  "The mock engine returns canned responses to simulate real engine behavior.",
  "Mock response: task completed successfully.",
];

/**
 * MockEngine — a zero-cost engine for E2E and integration tests.
 * Returns canned responses with simulated word-by-word streaming.
 * Cost is fixed at $0.001 per run for budget tracking tests.
 */
export class MockEngine implements Engine {
  name = "mock" as const;

  private responseIndex = 0;
  private fixedResponse?: string;

  constructor(opts?: { fixedResponse?: string }) {
    this.fixedResponse = opts?.fixedResponse;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const startMs = Date.now();
    const sessionId = opts.resumeSessionId || opts.sessionId || randomUUID();

    // Pick the next canned response (cycles through the list)
    const response =
      this.fixedResponse ??
      CANNED_RESPONSES[this.responseIndex++ % CANNED_RESPONSES.length];

    if (opts.onStream) {
      // Simulate word-by-word streaming with small delays
      const words = response.split(" ");
      for (let i = 0; i < words.length; i++) {
        const chunk = i === 0 ? words[i] : " " + words[i];
        opts.onStream({ type: "text", content: chunk });
        // Simulate network/processing delay between words
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Emit a final snapshot so clients can reconcile
      opts.onStream({ type: "text_snapshot", content: response });
    }

    const durationMs = Date.now() - startMs;

    return {
      sessionId,
      result: response,
      cost: 0.001,
      durationMs,
      numTurns: 1,
    };
  }
}

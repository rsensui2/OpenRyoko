# ICI-419: Gemini CLI Engine — Design Spec

**Date**: 2026-03-21
**Author**: jimmy-dev
**Ticket**: ICI-419
**Status**: Approved

## Summary

Add `GeminiEngine` to the Jinn gateway — a third engine alongside Claude and Codex
that spawns Google's Gemini CLI (`@google/gemini-cli`) as a child process.

## Design Decisions

### System Prompt Handling
**Prepend to user prompt** (same as CodexEngine). No GEMINI.md file manipulation.
Rationale: simplest, no filesystem side effects, consistent with Codex pattern.

### Architecture Pattern
**Hybrid of Claude + Codex patterns**:
- InterruptibleEngine interface (like both existing engines)
- LiveProcess tracking with kill/isAlive/killAll (identical pattern)
- System prompt prepended to user prompt (like Codex)
- Stream-JSON parsing with adaptive event handling (like Claude's streaming mode)
- No retry logic initially (like Codex — add later if needed)
- No rate limit tracking initially (Gemini uses different quota system)
- Clean environment (filter GEMINI_* env vars to prevent child conflicts)

### CLI Flags Mapping

| Purpose | Claude | Codex | Gemini |
|---------|--------|-------|--------|
| Non-interactive | `-p` | `exec` | `-p` |
| Model | `--model` | `--model` | `--model` |
| Output format | `--output-format stream-json` | `--json` | `--output-format stream-json` |
| Resume | `--resume ID` | `exec resume ID` | `--resume ID` |
| System prompt | `--append-system-prompt` | (prepend) | (prepend) |
| Auto-approve | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--sandbox false` |
| MCP config | `--mcp-config PATH` | N/A | N/A (uses settings.json) |

### Fresh Session Args
```
gemini -p --output-format stream-json --model <model> --sandbox false <prompt>
```

### Resume Session Args
```
gemini -p --output-format stream-json --model <model> --sandbox false --resume <sessionId> <prompt>
```

### Stream Event Parsing
Gemini CLI `stream-json` emits newline-delimited JSON. The parser will:
1. Try to parse each line as JSON
2. Recognize known event types (text output, tool use, errors, result)
3. Silently skip unrecognized event types (defensive/adaptive)
4. Extract session ID from initial events
5. Extract final result text from completion events

Since Gemini CLI's exact stream format may differ from Claude's, the parser
handles events defensively — logging unknown types at debug level rather than
failing.

### Config Integration
```typescript
engines: {
  default: "claude" | "codex" | "gemini";
  claude: { bin, model, effortLevel?, childEffortOverride? };
  codex: { bin, model, effortLevel?, childEffortOverride? };
  gemini: { bin, model, effortLevel?, childEffortOverride? };
}
```

### File Changes
1. `src/engines/gemini.ts` — GeminiEngine class (new file)
2. `src/engines/__tests__/gemini.test.ts` — unit tests (new file)
3. `src/shared/types.ts` — add `gemini` to engine config type
4. `src/gateway/server.ts` — instantiate and register GeminiEngine

### What's NOT in scope
- MCP support for Gemini (uses its own settings.json, not --mcp-config)
- Retry logic (add in follow-up if needed)
- Rate limit tracking (different quota system)
- Effort level mapping (Gemini CLI may not support this flag)

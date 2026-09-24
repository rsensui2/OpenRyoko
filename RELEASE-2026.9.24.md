# OpenRyoko 2026.9.24 — GPT-6 Sol and Luna

OpenRyoko now offers **GPT-6 Sol** and **GPT-6 Luna** alongside Astra. New installations use **`gpt-6-sol` with medium effort** for Codex; an unspecified model also resolves to Sol.

The model pickers and backend registry recognize both new model IDs, their published 1,050,000-token context windows, and Codex effort levels from `low` through `max`. Changing between GPT-6 models retains a supported `max` setting. The same capability check also preserves Opus 5.5's supported `max` setting.

Existing explicit defaults, employee/job pins, and custom model registries are preserved. To switch an existing installation, select GPT-6 Sol in Settings and update an explicit `models.codex` registry if present. Per-job overrides remain independent. GPT-5.6 Terra is still available; OpenAI's published GPT-6 family contains Astra, Sol, and Luna, with no GPT-6 Terra entry.

## Availability and pricing

Use an up-to-date Codex CLI and an account with access to the selected model. The API's published maximum context is not a change to Codex's own active context limit or compaction settings. API-only `none` and Codex's separate Ultra orchestration mode are not exposed as OpenRyoko effort options.

Standard API rates for prompts up to 272K input tokens, per million tokens:

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GPT-6 Sol | $2 | $0.20 | $10 |
| GPT-6 Luna | $0.10 | $0.01 | $0.50 |

Cache writes, longer prompts, and other processing tiers have separate rates. These are API prices, not a formula for ChatGPT subscription quota. This release does not add Codex billing estimates to the cost dashboard.

Sources: [OpenAI model catalog](https://developers.openai.com/api/docs/models), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Codex models and effort](https://learn.chatgpt.com/docs/models).

## Validation

- 2,371 backend tests and 123 Web tests passed; type checking and production builds passed.
- Package contents verified to include the compiled registry, Web UI, and configuration template.
- GPT-6 Sol and Luna live smoke tests passed with Codex CLI 0.155.1 on the host. Sol also passed on the deployment account when 0.155.1 was launched directly; the older 0.153.4 CLI rejected that model. These checks verify connectivity, not task quality or subscription savings.

## Update

```sh
npm install -g openryoko@2026.9.24
ryoko migrate --auto
```

Restart the gateway using your deployment's normal process. For a read-only Docker deployment, rebuild the image with the same published package and local tarball before recreating the container.

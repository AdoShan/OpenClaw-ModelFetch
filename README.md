# OpenClaw Model Fetch

OpenClaw tool plugin for refreshing a configured model provider's model list and writing the selected models to `models.providers.<providerId>.models`, where the WebUI can select them.

Each provider has an independent persisted filter strategy. The same `model_fetch` tool can refresh OpenRouter with one regex and Ollama with another manual selection without the two providers sharing settings.

## Features

- Fetches model lists from:
  - OpenAI-compatible providers (`openai-completions`, `openai-responses`, `openai-chatgpt-responses`)
  - Anthropic-compatible providers (`anthropic-messages`)
  - Ollama (`ollama`, using `/api/tags`)
  - OpenRouter (`openrouter`, using `https://openrouter.ai/api/v1/models`)
- Persists selected models through OpenClaw's config mutation API with automatic post-write reload.
- Supports include regex, exclude regex, and exact manual model IDs per provider.
- Supports one-call refresh using only the provider's persisted strategy.
- Supports temporary filters, `replace`, and `dryRun` in tool calls.
- Preserves existing model entries when an ID already exists, including custom names, costs, modalities, and other model fields.
- Does not expose API keys in tool results.
- Uses OpenClaw's SSRF-guarded fetch and bounded response reader.

## Requirements

- Node.js 24.16 or newer
- OpenClaw with plugin API support (`2026.5.17` or newer; validated with OpenClaw `2026.10.5`)
- A provider already configured under `models.providers`
- Provider authentication configured through OpenClaw's normal model auth flow

## Installation

```bash
npm install
npm run plugin:build
npm run plugin:validate
```

Install from this checkout:

```bash
openclaw plugins install /absolute/path/to/OpenClaw-ModelFetch
```

For local development, link the checkout instead of copying it:

```bash
openclaw plugins install /absolute/path/to/OpenClaw-ModelFetch --link
```

Use `openclaw plugins list` and `openclaw plugins doctor` to confirm the plugin is discovered and healthy.

## Provider Filter Configuration

Filters live in the `model-fetch` plugin config and are keyed by provider ID:

```json
{
  "plugins": {
    "entries": {
      "model-fetch": {
        "config": {
          "providers": {
            "openrouter": {
              "filter": {
                "includeRegex": "^(openai|anthropic)/",
                "excludeRegex": "(embed|rerank)",
                "manualIds": ["openai/gpt-4o-mini"],
                "replace": false
              }
            },
            "ollama": {
              "filter": {
                "manualIds": ["qwen3:latest", "llama3.1:8b"]
              }
            }
          }
        }
      }
    }
  }
}
```

Filter semantics:

- `includeRegex`: when set, only fetched IDs matching this JavaScript regex are selected.
- `excludeRegex`: matching IDs are removed from the regex-selected set.
- `manualIds`: exact IDs to select. When `includeRegex` is not set, only these IDs are selected. When `includeRegex` is set, these IDs bypass include/exclude matching. A manual ID is retained during `replace` if it already exists in config.
- `replace`: when `false` or omitted, existing models are preserved and new selected models are added. When `true`, models not in the selected fetched set and not manually selected are removed.
- Invalid regexes fail the tool call with a clear error.

Temporary tool arguments override the persisted values for that call only. Omitted arguments fall back to the provider's persisted strategy.

## Tool Usage

Refresh a provider with its already-persisted strategy:

```json
{
  "provider": "openrouter"
}
```

Preview a temporary regex without changing config:

```json
{
  "provider": "openrouter",
  "includeRegex": "anthropic/",
  "dryRun": true
}
```

Use a temporary manual selection:

```json
{
  "provider": "ollama",
  "manualIds": ["qwen3:latest", "llama3.1:8b"]
}
```

Synchronize the configured model list and remove stale entries:

```json
{
  "provider": "ollama",
  "replace": true
}
```

The result reports the provider, fetched count, selected model IDs, added/unchanged/removed counts, whether `replace` was active, whether it was a dry run, the config path, and whether the config was persisted.

## Provider Prerequisites

Example:

```json
{
  "models": {
    "providers": {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "api": "openai-responses",
        "models": []
      }
    }
  }
}
```

For Ollama or another private/local endpoint, explicitly opt in to private-network requests:

```json
{
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434",
        "api": "ollama",
        "request": {
          "allowPrivateNetwork": true
        },
        "models": []
      }
    }
  }
}
```

## Development

```bash
npm test
npm run plugin:build
npm run plugin:validate
```

The generated `openclaw.plugin.json` should list `model_fetch` under `contracts.tools`.

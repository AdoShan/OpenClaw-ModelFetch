# Configuration Reference

English | [中文](../zh-CN/configuration.md) | [Back to README](../../README.md)

This page explains filtering, configuration writes, Agent synchronization, and the `model_fetch` tool. For installation and basic usage, start with the [README](../../README.md).

## Provider prerequisites

Each provider must already exist under `models.providers.<providerId>` and have a valid `baseUrl`. Provider authentication can come from:

- A provider `apiKey` configured in OpenClaw.
- An environment variable referenced by the provider configuration.
- The OpenClaw authentication store used by the provider.

Ollama does not require an API key. A local or private-network endpoint must also allow private network requests in the provider configuration.

## Filter strategy

Every provider has an independent saved strategy.

| Field | Required | Behavior |
| --- | --- | --- |
| `includeRegex` | No | Selects model IDs matching a JavaScript regular expression. Empty means no include restriction. |
| `excludeRegex` | No | Removes matching model IDs from the regular-expression selection. |
| `manualIds` | No | Exact model IDs in the manual whitelist. |
| `replace` | No | Removes existing provider models that are absent from the final selection. Defaults to `true`. |

The selection order is:

1. Compile `includeRegex` and `excludeRegex`. An invalid expression blocks saving and applying.
2. If `manualIds` is non-empty and `includeRegex` is empty, select only the whitelisted model IDs.
3. Otherwise, select models included by `includeRegex` and not matched by `excludeRegex`.
4. Add every manual whitelist ID, even when it matches `excludeRegex`.
5. Keep a manually selected model that still exists in configuration even if the remote endpoint no longer returns it.

The settings UI always uses replacement mode. The Agent tool can explicitly pass `replace: false` for additive behavior; when the parameter is omitted, the effective default is still `true`.

Filter results update when a regex input loses focus or when Enter is pressed.

## Saved strategy

The settings UI stores strategies under the plugin config:

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
                "replace": true
              },
              "targetAgents": ["main"]
            },
            "ollama": {
              "filter": {
                "manualIds": ["qwen3:latest", "llama3.1:8b"],
                "replace": true
              }
            }
          }
        }
      }
    }
  }
}
```

`targetAgents` and each provider's `filter` are stored independently.

## Applying a strategy

Applying a strategy performs these steps:

1. Fetch the provider's current remote model list again.
2. Reapply the saved Provider strategy and recompute additions, deletions, and protected models.
3. Require confirmation when existing models will be deleted. The dialog lists the exact model IDs.
4. Abort the write if the remote list, saved strategy, provider models, or protected references changed after preview.
5. Write the confirmed model list to `models.providers.<providerId>.models`.
6. Synchronize applicable Agent model allowlists.
7. Reset stale model selections in affected sessions unless a session has locked its model selection.

Existing model definitions retain fields such as name, cost, reasoning support, input modalities, context window, and token limits when the model ID already exists.

### Reference protection

Replacement mode does not delete a model that is still referenced by a non-Agent model consumer. Examples include:

- Agent primary, utility, decision, image, media, voice, PDF, heartbeat, subagents, compaction, memory-flush, and embedded-Agent failover models.
- Agent entry exec reviewer and `tts.summaryModel` references, plus root `tts.summaryModel`.
- Tools exec reviewer and media preferred-model references.
- Hook, `channels.modelByChannel`, and Discord voice model references.

The deletion dialog lists the protected models and the exact configuration paths that kept each one.

### Agent allowlists

`agents.defaults.modelPolicy.allow` is reconciled whenever the allowlist is non-empty. Selected model references are added, and deselected exact references for this provider are removed.

For `agents.entries.<agentId>.modelPolicy.allow`, the settings UI can save target Agents explicitly. Checked Agents are synchronized even when their current allowlist has no provider-specific rule. Unchecked Agent entries with a matching provider rule can still be synchronized automatically.

For synchronized Agent entries, the plugin adds selected `provider/model` references and removes deselected exact references for that provider. Other providers and wildcard rules remain untouched.

The apply result includes `targetAgents`, `syncedAgents`, `sessionSelectionResets`, and `resetSessionKeys`.

## Agent tool

The plugin exposes the `model_fetch` tool.

| Parameter | Required | Behavior |
| --- | --- | --- |
| `provider` | Yes | Provider ID under `models.providers`. Only this provider's saved strategy is used. |
| `includeRegex` | No | Temporary include regex overriding the saved value for this call. |
| `excludeRegex` | No | Temporary exclude regex overriding the saved value for this call. |
| `manualIds` | No | Temporary exact whitelist overriding the saved value for this call. |
| `replace` | No | Removes unselected existing models. Defaults to `true`. |
| `dryRun` | No | Computes the result without writing configuration. |

Refresh using the saved strategy:

```json
{
  "provider": "openrouter"
}
```

Preview a temporary strategy without writing:

```json
{
  "provider": "openrouter",
  "includeRegex": "anthropic/",
  "excludeRegex": "(embed|rerank)",
  "manualIds": ["anthropic/claude-sonnet-4"],
  "dryRun": true
}
```

The result contains:

| Field | Meaning |
| --- | --- |
| `provider` | Provider ID used for the operation. |
| `fetched` | Number of remote models returned. |
| `selected` | Final selected model IDs. |
| `protectedModels` | Models kept by reference protection and their config paths. |
| `added` | Number of new models added to configuration. |
| `unchanged` | Number of existing models retained unchanged. |
| `removed` | Number of models removed from configuration. |
| `replace` | Whether replacement mode was used. |
| `dryRun` | Whether configuration was left unchanged. |
| `configPath` | Configuration file touched by the operation. |
| `persisted` | Whether the result was written. |

The Agent tool writes without an interactive deletion dialog. Use `dryRun: true` before a destructive call when the selection is not already reviewed in the settings UI.

## Provider examples

### OpenRouter

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

### Ollama

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

The plugin also supports OpenAI-compatible and Anthropic-compatible provider configurations. The exact `api` value must match the provider setup used by the installed OpenClaw version.

## Related links

- [Issues](https://github.com/AdoShan/OpenClaw-ModelFetch/issues)
- [Releases](https://github.com/AdoShan/OpenClaw-ModelFetch/releases)
- [npm package](https://www.npmjs.com/package/openclaw-plugin-model-fetch)

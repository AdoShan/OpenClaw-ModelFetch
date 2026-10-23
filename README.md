# OpenClaw Model Fetch

> English · [中文](./README-CN.md)

[![CI](https://github.com/AdoShan/OpenClaw-ModelFetch/actions/workflows/ci.yml/badge.svg)](https://github.com/AdoShan/OpenClaw-ModelFetch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/openclaw-plugin-model-fetch.svg)](https://www.npmjs.com/package/openclaw-plugin-model-fetch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Fetch a provider's remote model list inside the OpenClaw Control UI, apply a per-provider strategy built from include regexes, exclude regexes and a manual allowlist, then write the confirmed selection into `models.providers.<providerId>.models` for the WebUI to use.

## Features

- Supports OpenAI-compatible providers, Anthropic-compatible providers, Ollama and OpenRouter.
- Separates "fetch remote models" from "apply strategy to config": fetching never mutates configuration.
- Persists an independent filter strategy per provider, so switching providers never mixes regexes or allowlists.
- Combines include regex, exclude regex and manual allowlist; manually selected models survive the exclude regex.
- Refreshes results on blur or Enter; invalid regexes block saving and applying.
- Re-fetches and re-plans before applying, and aborts the write if the remote list or config changed during confirmation.
- Defaults to replace mode: the final config keeps only the models selected by the current strategy plus manually selected ones.
- Protects models still referenced by non-agent settings such as utility, decision, media, voice, PDF, embedded-agent failover and hook models; the delete dialog lists the config paths that kept them.
- Preserves existing per-model fields (name, cost, modalities and so on) for known IDs, and never exposes provider API keys.
- When "override agent" is selected, applying also syncs that agent's allowlist and model map: newly selected models are added and deselected exact entries for the same provider are removed, so the WebUI stops offering stale models.

## Requirements

- Node.js 24.16 or newer
- OpenClaw `2026.10.5` or newer
- At least one configured `models.providers.<providerId>` with working authentication

## Installation

Install the published npm package with OpenClaw. This is the recommended path for users; OpenClaw downloads the package, which already contains the built plugin under `dist/`. You do not need to clone this repository or run `npm install` and `npm run plugin:build`:

```bash
openclaw plugins install openclaw-plugin-model-fetch
```

To install a specific released version:

```bash
openclaw plugins install openclaw-plugin-model-fetch@0.2.4
```

When OpenClaw asks, review and accept the declared `model_fetch` tool capability. To upgrade an npm installation later:

```bash
openclaw plugins update model-fetch
```

Check plugin status with:

```bash
openclaw plugins list
openclaw plugins doctor
```

Source installations are for plugin development. Clone this repository, install dependencies, build and validate, then link the checkout:

```bash
npm install
npm run plugin:build
npm run plugin:validate
openclaw plugins install /absolute/path/to/OpenClaw-ModelFetch --link
npm run plugin:build
```

After source changes, run `npm run plugin:build` again so the linked installation picks up the rebuilt bundle.

## Enabling the settings UI

Custom plugin UIs are disabled by default. Open the Control UI served from the same origin as the Gateway, then go to:

**Settings → Labs → Custom plugin UI**

Enable it and reload the browser page. **Model Fetch** then appears in the Control UI sidebar. If the entry is missing, check in order:

1. `openclaw plugins list` shows the plugin enabled with no configuration errors.
2. Custom plugin UI is enabled.
3. An npm installation is current and was loaded by the Gateway; a source installation has been rebuilt with `npm run plugin:build`.
4. The Control UI shares the Gateway origin and is served over HTTPS or a browser-trusted loopback address.

The equivalent config entry is:

```json5
{
  gateway: {
    controlUi: {
      experimental: {
        customPlugins: true,
      },
    },
  },
}
```

The plugin does not draw OpenClaw's application sidebar itself; pages and navigation are managed by the Control UI host.

### Troubleshooting: the Model Fetch settings page is missing

Work through these in order:

1. Confirm the plugin is installed and enabled:

   ```bash
   openclaw plugins list
   openclaw plugins doctor
   ```

2. For an npm installation, reinstall or update the plugin if `doctor` reports a broken package. For a source installation, rebuild and make sure the Gateway picked up the latest `openclaw.plugin.json`:

   ```bash
   npm run plugin:build
   ```

3. Restart the Gateway or reload the Control UI page, then try:

   - Settings page: `/settings/plugins/model-fetch?view=settings`
   - Plugin page: `/plugin?plugin=model-fetch&id=model-fetch`

4. If the page opens but does nothing, check the browser console for errors and verify the plugin session action returns a JSON-compatible object (the current implementation already does).

## Usage

1. Open **Model Fetch** and pick the target provider from the provider dropdown.
2. Click **Fetch remote models**. This only reads the remote model list and never writes config.
3. Set the include regex and exclude regex, or tick allowlist models. Ticking only adds to the allowlist and does not modify OpenClaw config.
4. Under **Override agent**, tick the agents whose allowlist should be synced (only affects agents that already have `modelPolicy.allow` configured).
5. Click **Save strategy** to persist the per-provider filter and target agents.
6. Click **Apply strategy to config**. The plugin re-fetches remote models and re-checks the config.
7. If the operation would delete existing models, the confirmation dialog lists each one. Nothing is written until you confirm.
8. Return to the OpenClaw Models page and the newly written models are available.

If you use model policy allowlists (`agents.defaults.modelPolicy.allow` or a non-empty `agents.entries.<agent>.modelPolicy.allow`), applying the strategy also syncs the `provider/model` entries written in this run. For agents ticked under "Override agent", the sync removes deselected exact model entries for that provider; other providers, wildcard rules such as `provider/*`, and custom agent configs for retained models are left alone.

Applying uses replace mode by default: models for the current provider that the strategy did not select are removed. A model is kept when it is still referenced by a non-agent consumer such as `agents.defaults.utilityModel`, `agents.defaults.imageModel`, `agents.defaults.mediaModels.*`, `agents.defaults.voiceModel`, `agents.defaults.pdfModel`, `agents.defaults.embeddedAgent.cyberFailover.model`, `agents.entries.*.utilityModel`, `agents.entries.*.decisionModel`, `hooks.gmail.model` or `hooks.mappings[].model`. The confirmation dialog lists those references. If the remote list, filter strategy, protected references or other config changes after the preview, the write is aborted and a fresh preview is required.

## Filter rules

- `includeRegex`: select only model IDs matching this JavaScript regex. Empty means no regex restriction.
- `excludeRegex`: remove matching models from the regex-selected set.
- `manualIds`: exact manual allowlist. With an allowlist and no `includeRegex`, only allowlisted models are selected.
- Manual allowlist wins: allowlisted models are selected even if they match the exclude regex.
- Allowlisted models already present in config are retained even if the remote list no longer returns them.
- `replace`: the plugin defaults to `true`. The settings UI always runs in replace mode; agent tool calls may pass `false` to add models without removing old ones.
- Invalid regexes are neither saved nor applied.

Provider strategies are stored in the plugin config:

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
              }
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

## Agent tool

The tool is named `model_fetch`. Refresh and write using the persisted strategy only:

```json
{
  "provider": "openrouter"
}
```

Dry run with a temporary filter, without writing config:

```json
{
  "provider": "openrouter",
  "includeRegex": "anthropic/",
  "dryRun": true
}
```

Temporary manual selection:

```json
{
  "provider": "ollama",
  "manualIds": ["qwen3:latest", "llama3.1:8b"]
}
```

The result reports the provider, remote model count, the final selected model IDs, added/unchanged/removed counts, protected models with their reference paths, the config path and whether the config was persisted.

## Provider examples

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

Ollama or another local address needs explicit private-network access:

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
npm run typecheck
npm run plugin:build
npm run plugin:validate
```

The browser UI sources are `src/control-ui.ts` and `src/settings-view.ts`. `npm run plugin:build` generates content-hashed assets under `dist/control-ui/` and updates `openclaw.plugin.json.controlUi`.

## License

MIT

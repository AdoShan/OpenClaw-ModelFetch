# OpenClaw Model Fetch

English | [中文](./README-CN.md)

[![CI](https://github.com/AdoShan/OpenClaw-ModelFetch/actions/workflows/ci.yml/badge.svg)](https://github.com/AdoShan/OpenClaw-ModelFetch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/openclaw-plugin-model-fetch.svg)](https://www.npmjs.com/package/openclaw-plugin-model-fetch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Fetch a provider's remote model list in the OpenClaw Control UI, filter it per provider, and write the confirmed models into OpenClaw configuration for the WebUI to use.

## Features

- Fetches models from OpenAI-compatible, Anthropic-compatible, Ollama, and OpenRouter providers.
- Saves independent include regex, exclude regex, and manual whitelist strategies for each provider.
- Separates remote fetching from configuration writes and shows every model deletion before applying.
- Preserves models referenced by other OpenClaw settings and can synchronize Agent model allowlists.

## Requirements

- Node.js 24.16 or newer
- OpenClaw `2026.10.5` or newer
- At least one configured `models.providers.<providerId>` with a valid `baseUrl` and any authentication required by the provider

## Quick Start

### 1. Install

```bash
openclaw plugins install openclaw-plugin-model-fetch
```

### 2. Enable the settings UI

Custom plugin UIs are disabled by default. Open the Control UI from the same origin as the Gateway, then enable:

**Settings -> Labs -> Custom plugin UI**

Alternatively, enable it directly with the OpenClaw CLI:

```bash
openclaw config set gateway.controlUi.experimental.customPlugins true --strict-json
```

Reload the browser page. **Model Fetch** should now appear in the Control UI sidebar.

### 3. Verify the installation

```bash
openclaw plugins list
openclaw plugins doctor
```

The plugin should be enabled, loaded, and free of configuration errors.

## Usage

1. Open **Model Fetch** and select the target provider.
2. Click **Fetch remote models**. This only reads the remote model list.
3. Set the include and exclude regexes, or tick models to add them to the manual whitelist.
4. Select any Agents whose model allowlists should be synchronized.
5. Click **Save strategy**.
6. Click **Apply strategy to config**.
7. Review the deletion dialog when shown. No model configuration is written until you confirm.
8. Open the OpenClaw Models page and select the newly available models.

The settings interface follows the OpenClaw WebUI language: Chinese locales use Chinese, and other locales default to English.

### What each action changes

| Action | Changes plugin strategy | Changes provider models | Requires deletion confirmation |
| --- | --- | --- | --- |
| Fetch remote models | No | No | No |
| Save strategy | Yes | No | No |
| Apply strategy to config | No | Yes | Only when models will be deleted |

Replacement mode is the default. Applying a strategy removes existing provider models that are not selected, except models protected by other OpenClaw configuration references.

See the [configuration reference](https://github.com/AdoShan/OpenClaw-ModelFetch/blob/main/docs/en/configuration.md) for filter rules, protected references, Agent synchronization, the `model_fetch` tool, and provider examples.

## Troubleshooting

### Model Fetch is not listed or enabled

Run `openclaw plugins list` and `openclaw plugins doctor`. Reinstall the package if it is missing or reported as broken.

### The Model Fetch navigation entry is missing

Confirm that **Settings -> Labs -> Custom plugin UI** is enabled, then reload the Control UI. The direct settings route is `/settings/plugins/model-fetch?view=settings`.

### Fetching remote models fails

Confirm that the provider's `baseUrl`, `api`, and authentication work in OpenClaw. Local or private-network endpoints such as Ollama require `request.allowPrivateNetwork: true`.

### Old models are still visible after applying

Confirm that the apply operation completed and that the relevant Agents were selected for synchronization. Some models can remain intentionally because of reference protection. Reload the Models page or the affected session after checking the apply result.

## Documentation and Support

- [Configuration reference](https://github.com/AdoShan/OpenClaw-ModelFetch/blob/main/docs/en/configuration.md)
- [中文配置参考](https://github.com/AdoShan/OpenClaw-ModelFetch/blob/main/docs/zh-CN/configuration.md)
- [Report an issue](https://github.com/AdoShan/OpenClaw-ModelFetch/issues)
- [Releases](https://github.com/AdoShan/OpenClaw-ModelFetch/releases)
- [npm package](https://www.npmjs.com/package/openclaw-plugin-model-fetch)

## Development

For a source checkout, run:

```bash
npm ci
npm test
npm run plugin:validate
```

`plugin:validate` builds and validates the plugin. To use the checkout directly, install it with `openclaw plugins install /absolute/path/to/OpenClaw-ModelFetch --link`. Rebuild and reload the plugin after source changes.

## License

MIT

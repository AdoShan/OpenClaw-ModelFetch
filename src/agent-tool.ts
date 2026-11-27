import type { TSchema } from "typebox";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import {
  applyModelReferenceProtection,
  fetchProviderModels,
  getProvider,
  mergeModels,
  MODEL_FETCH_TOOL_NAME,
  resolveApiKey,
  resolveEffectiveFilter,
  resolveProviderFilter,
  resolveProviderTargetAgents,
  selectFetchedModels,
} from "./model-fetch.js";
import { mutateConfigFileWithRetry, replaceProviderModels } from "./model-replacement.js";
import {
  createModelFetchSessionCleanup,
  type ModelFetchSessionCleanup,
  type SessionSelectionScope,
} from "./session-cleanup.js";
import {
  modelFetchParameters,
  type ModelFetchConfig,
  type ModelFetchParams,
  type ModelFetchToolResult,
} from "./schemas.js";

const CONFIG_PATH = "models.providers.<providerId>.models";

function currentConfig(
  api: OpenClawPluginApi,
  toolContext?: OpenClawPluginToolContext,
): unknown {
  return (
    toolContext?.getRuntimeConfig?.() ??
    toolContext?.runtimeConfig ??
    toolContext?.config ??
    api.runtime.config.current()
  );
}

export async function runModelFetch({
  api,
  toolContext,
  factoryConfig,
  fetchModels = fetchProviderModels,
  params,
  signal,
  sessionCleanup,
}: {
  api: OpenClawPluginApi;
  toolContext?: OpenClawPluginToolContext;
  factoryConfig?: ModelFetchConfig;
  fetchModels?: typeof fetchProviderModels;
  params: ModelFetchParams;
  signal?: AbortSignal;
  sessionCleanup?: ModelFetchSessionCleanup;
}): Promise<ModelFetchToolResult> {
  const providerId = params.provider.trim();
  if (!providerId) throw new Error("Provider id is required.");

  const config = currentConfig(api, toolContext);
  const provider = getProvider(config, providerId);
  const persistedFilter = resolveProviderFilter(providerId, config, factoryConfig);
  const effectiveFilter = resolveEffectiveFilter(persistedFilter, params);
  const apiKey = await resolveApiKey(api, providerId, provider, config);
  const fetched = await fetchModels({
    providerId,
    provider,
    apiKey,
    signal,
  });
  const selected = selectFetchedModels(fetched, effectiveFilter);
  const existing = provider.models ?? [];
  const merge = mergeModels({
    existing,
    selected,
    filter: effectiveFilter,
  });
  let persisted = false;
  let configPath = CONFIG_PATH;
  let added = merge.added;
  let unchanged = merge.unchanged;
  let removedIds = existing
    .map((model) => model.id)
    .filter((id) => !merge.models.some((model) => model.id === id));
  let protectedModels: ModelFetchToolResult["protectedModels"] = [];
  if (!params.dryRun) {
    const result = await mutateConfigFileWithRetry(api.runtime, {
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const replacement = replaceProviderModels(draft, {
          providerId,
          provider,
          existingModels: existing,
          mergedModels: merge.models,
          targetAgents: resolveProviderTargetAgents(providerId, draft, factoryConfig),
        });
        const originalIds = new Set(existing.map((model) => model.id));
        added = replacement.finalModels.filter((model) => !originalIds.has(model.id)).length;
        unchanged = selected.filter((model) => originalIds.has(model.id)).length;
        removedIds = replacement.removedIds;
        protectedModels = replacement.protectedModels;
      },
    });
    configPath = result.path;
    persisted = true;
    await (sessionCleanup ?? createModelFetchSessionCleanup({
      currentConfig: () => api.runtime.config.current(),
    })).reset({
      providerId,
      removedIds,
      scope: toolContext as SessionSelectionScope | undefined,
    });
  } else {
    const protection = applyModelReferenceProtection({
      existing,
      merged: merge.models,
      providerId,
      config,
    });
    protectedModels = protection.protectedModels;
    const finalIds = new Set(protection.models.map((model) => model.id));
    removedIds = existing
      .map((model) => model.id)
      .filter((id) => !finalIds.has(id));
  }

  return {
    provider: providerId,
    fetched: fetched.length,
    selected: merge.selectedIds,
    protectedModels,
    added,
    unchanged,
    removed: removedIds.length,
    replace: effectiveFilter.replace === true,
    dryRun: params.dryRun === true,
    configPath,
    persisted,
  };
}

export function createModelFetchTool({
  api,
  toolContext,
  factoryConfig,
  fetchModels = fetchProviderModels,
  sessionCleanup,
}: {
  api: OpenClawPluginApi;
  toolContext: OpenClawPluginToolContext;
  factoryConfig?: ModelFetchConfig;
  fetchModels?: typeof fetchProviderModels;
  sessionCleanup?: ModelFetchSessionCleanup;
}): AnyAgentTool {
  return {
    name: MODEL_FETCH_TOOL_NAME,
    label: "Fetch Provider Models",
    description:
      "Fetch a configured provider's model list, apply that provider's independent regex/manual selection strategy, and persist the selected models to OpenClaw config for WebUI use.",
    parameters: modelFetchParameters as TSchema,
    resultContentSource: "network",
    execute: async (_toolCallId, params: ModelFetchParams, signal?: AbortSignal) => {
      return jsonResult(
        await runModelFetch({
          api,
          toolContext,
          factoryConfig,
          fetchModels,
          params,
          signal,
          sessionCleanup,
        }),
      );
    },
  };
}

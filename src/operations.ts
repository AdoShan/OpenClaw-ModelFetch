import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import type {
  OpenClawPluginApi,
  PluginJsonValue,
  PluginSessionActionContext,
} from "openclaw/plugin-sdk/core";
import { modelFetchContract } from "./contract.js";
import {
  fetchProviderModels,
  getProvider,
  mergeModels,
  resolveApiKey,
  resolveProviderFilter,
  runModelFetch,
  selectFetchedModels,
  syncConfiguredModelPolicyAllow,
  type ModelDefinitionLike,
  type ModelFetchConfig,
  type ModelFilterConfig,
  type ProviderLike,
} from "./model-fetch.js";
import type {
  ApplyPlan,
  ApplyStrategyInput,
  ApplyStrategyOutput,
  FetchModelsOutput,
  ListProvidersOutput,
  ModelFetchParams,
  ModelView,
  PreviewApplyOutput,
  ProviderSummary,
  SaveStrategyInput,
  SaveStrategyOutput,
} from "./schemas.js";

type MutableConfig = {
  models?: {
    providers?: Record<string, ProviderLike | undefined>;
  };
  plugins?: {
    entries?: Record<string, Record<string, unknown> | undefined>;
  };
};

type ComputedPlan = {
  providerId: string;
  provider: ProviderLike;
  filter: ModelFilterConfig;
  fetched: ModelDefinitionLike[];
  fetchedAt: string;
  existingIds: string[];
  addedIds: string[];
  removedIds: string[];
  selectedIds: string[];
  unchangedCount: number;
  models: ModelView[];
  fingerprint: string;
  finalModels: ModelDefinitionLike[];
};

export type ModelFetchOperations = ReturnType<typeof createModelFetchOperations>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toModelView(model: ModelDefinitionLike): ModelView {
  return {
    id: model.id,
    name: model.name || model.id,
    ...(typeof model.contextWindow === "number" && model.contextWindow > 0
      ? { contextWindow: Math.floor(model.contextWindow) }
      : {}),
  };
}

function normalizeFilter(filter: ModelFilterConfig): ModelFilterConfig {
  const normalized: ModelFilterConfig = {
    manualIds: [
      ...new Set(
        (filter.manualIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
      ),
    ],
    replace: true,
  };

  if (typeof filter.includeRegex === "string") normalized.includeRegex = filter.includeRegex;
  if (typeof filter.excludeRegex === "string") normalized.excludeRegex = filter.excludeRegex;

  return normalized;
}

function configPath(providerId: string): string {
  return `models.providers.${providerId}.models`;
}

function planFingerprint(input: {
  providerId: string;
  filter: ModelFilterConfig;
  fetchedIds: string[];
  existingIds: string[];
  selectedIds: string[];
  addedIds: string[];
  removedIds: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: input.providerId,
        filter: input.filter,
        fetched: input.fetchedIds,
        existing: input.existingIds,
        selected: input.selectedIds,
        added: input.addedIds,
        removed: input.removedIds,
      }),
    )
    .digest("hex");
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = sorted(left);
  const rightSorted = sorted(right);
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

function ensurePluginEntry(draft: MutableConfig, providerId: string, filter: ModelFilterConfig) {
  draft.plugins ??= {};
  draft.plugins.entries ??= {};

  const existingEntry = draft.plugins.entries["model-fetch"];
  const entry = isRecord(existingEntry) ? existingEntry : {};
  const pluginConfig = isRecord(entry.config) ? entry.config : {};
  const providers = isRecord(pluginConfig.providers) ? pluginConfig.providers : {};
  const existingProvider = isRecord(providers[providerId]) ? providers[providerId] : {};

  providers[providerId] = {
    ...existingProvider,
    filter,
  };
  pluginConfig.providers = providers;
  entry.config = pluginConfig;
  draft.plugins.entries["model-fetch"] = entry;
}

export function createModelFetchOperations({
  api,
  factoryConfig,
  fetchModels = fetchProviderModels,
  now = () => new Date(),
}: {
  api: OpenClawPluginApi;
  factoryConfig?: ModelFetchConfig;
  fetchModels?: typeof fetchProviderModels;
  now?: () => Date;
}) {
  const runtime = api.runtime;

  function currentConfig(): unknown {
    return runtime.config.current();
  }

  function savedFilter(providerId: string, config = currentConfig()): ModelFilterConfig {
    return normalizeFilter(resolveProviderFilter(providerId, config, factoryConfig));
  }

  async function fetchModelsForProvider(providerId: string): Promise<{
    provider: ProviderLike;
    fetched: ModelDefinitionLike[];
    fetchedAt: string;
    config: unknown;
  }> {
    const config = currentConfig();
    const provider = getProvider(config, providerId);
    const apiKey = await resolveApiKey(api, providerId, provider, config);
    const fetched = await fetchModels({
      providerId,
      provider,
      apiKey,
    });
    return {
      provider,
      fetched,
      fetchedAt: now().toISOString(),
      config,
    };
  }

  async function computePlan(providerId: string): Promise<ComputedPlan> {
    const { provider, fetched, fetchedAt } = await fetchModelsForProvider(providerId);
    const filter = savedFilter(providerId);
    selectFetchedModels(fetched, filter);

    const existing = provider.models ?? [];
    const selected = selectFetchedModels(fetched, filter);
    const merge = mergeModels({ existing, selected, filter });
    const existingIds = existing.map((model) => model.id);
    const finalIds = new Set(merge.models.map((model) => model.id));
    const existingSet = new Set(existingIds);
    const removedIds = existingIds.filter((id) => !finalIds.has(id));
    const addedIds = merge.models
      .filter((model) => !existingSet.has(model.id))
      .map((model) => model.id);
    const models = fetched.map(toModelView);
    const visibleIds = new Set(models.map((model) => model.id));
    const manualIds = new Set(filter.manualIds ?? []);
    for (const model of existing) {
      if (manualIds.has(model.id) && !visibleIds.has(model.id)) {
        models.push(toModelView(model));
        visibleIds.add(model.id);
      }
    }

    const fingerprint = planFingerprint({
      providerId,
      filter,
      fetchedIds: fetched.map((model) => model.id),
      existingIds,
      selectedIds: merge.selectedIds,
      addedIds,
      removedIds,
    });

    return {
      providerId,
      provider,
      filter,
      fetched,
      fetchedAt,
      existingIds,
      addedIds,
      removedIds,
      selectedIds: merge.selectedIds,
      unchangedCount: merge.unchanged,
      models,
      fingerprint,
      finalModels: merge.models,
    };
  }

  async function listProviders(): Promise<ListProvidersOutput> {
    const config = currentConfig();
    const providers = (config as MutableConfig | undefined)?.models?.providers ?? {};
    const result: ProviderSummary[] = [];

    for (const providerId of Object.keys(providers).sort((left, right) =>
      left.localeCompare(right),
    )) {
      let provider: ProviderLike;
      try {
        provider = getProvider(config, providerId);
      } catch {
        continue;
      }
      result.push({
        id: providerId,
        label: provider.name?.trim() || providerId,
        api: provider.api?.trim() || "unknown",
        baseUrl: provider.baseUrl,
        configPath: configPath(providerId),
        filter: savedFilter(providerId, config),
        configuredModels: (provider.models ?? []).map(toModelView),
      });
    }

    return { providers: result };
  }

  async function fetchModelsForUi(providerId: string): Promise<FetchModelsOutput> {
    const { fetched, fetchedAt } = await fetchModelsForProvider(providerId);
    return {
      provider: providerId,
      fetchedAt,
      models: fetched.map(toModelView),
    };
  }

  async function saveStrategy({
    provider,
    filter,
  }: SaveStrategyInput): Promise<SaveStrategyOutput> {
    const config = currentConfig();
    getProvider(config, provider);
    const nextFilter = normalizeFilter(filter);
    selectFetchedModels([], nextFilter);

    const result = await runtime.config.mutateConfigFile({
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        ensurePluginEntry(draft as MutableConfig, provider, nextFilter);
      },
    });

    return {
      provider,
      savedAt: now().toISOString(),
      configPath: result.path,
      filter: nextFilter,
    };
  }

  async function previewApply(provider: string): Promise<PreviewApplyOutput> {
    const computed = await computePlan(provider);
    const plan: ApplyPlan = {
      fingerprint: computed.fingerprint,
      fetchedAt: computed.fetchedAt,
      fetchedCount: computed.fetched.length,
      addedIds: computed.addedIds,
      removedIds: computed.removedIds,
      selectedIds: computed.selectedIds,
      unchangedCount: computed.unchangedCount,
    };
    return {
      provider,
      plan,
      models: computed.models,
    };
  }

  async function applyStrategy({
    provider,
    fingerprint,
    expectedRemovals,
  }: ApplyStrategyInput): Promise<ApplyStrategyOutput> {
    const computed = await computePlan(provider);
    if (computed.fingerprint !== fingerprint) {
      throw new Error("模型列表或筛选策略已变化，请重新预览后再确认应用。");
    }
    if (!sameStringSets(computed.removedIds, expectedRemovals)) {
      throw new Error("待删除模型与确认列表不一致，已取消写入。请重新预览。");
    }

    const result = await runtime.config.mutateConfigFile({
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const config = draft as MutableConfig;
        const target = getProvider(config, provider);
        const currentExistingIds = (target.models ?? []).map((model) => model.id);
        if (!sameStringSets(currentExistingIds, computed.existingIds)) {
          throw new Error("Provider 配置在确认后发生变化，已取消写入。请重新预览。");
        }
        const currentFilter = normalizeFilter(
          resolveProviderFilter(provider, config, factoryConfig),
        );
        if (JSON.stringify(currentFilter) !== JSON.stringify(computed.filter)) {
          throw new Error("Provider 筛选策略在确认后发生变化，已取消写入。请重新预览。");
        }
        target.models = computed.finalModels;
        syncConfiguredModelPolicyAllow(config, provider, computed.finalModels);
      },
    });

    return {
      provider,
      persisted: true,
      configPath: result.path,
      fetchedAt: computed.fetchedAt,
      fetchedCount: computed.fetched.length,
      added: computed.addedIds.length,
      unchanged: computed.unchangedCount,
      removed: computed.removedIds.length,
      selectedIds: computed.selectedIds,
      models: computed.models,
    };
  }

  async function refreshProvider(params: ModelFetchParams) {
    return runModelFetch({
      api,
      factoryConfig,
      fetchModels,
      params,
    });
  }

  return {
    listProviders,
    fetchModels: fetchModelsForUi,
    saveStrategy,
    previewApply,
    applyStrategy,
    refreshProvider,
  };
}

export function registerModelFetchOperations(
  api: OpenClawPluginApi,
  options: {
    factoryConfig?: ModelFetchConfig;
    fetchModels?: typeof fetchProviderModels;
    now?: () => Date;
  } = {},
): ModelFetchOperations {
  const operations = createModelFetchOperations({ api, ...options });
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {
    "providers.list": () => operations.listProviders(),
    "models.fetch": (input) =>
      operations.fetchModels((input as { provider: string }).provider),
    "strategy.save": (input) => operations.saveStrategy(input as SaveStrategyInput),
    "strategy.preview": (input) =>
      operations.previewApply((input as { provider: string }).provider),
    "strategy.apply": (input) =>
      operations.applyStrategy(input as ApplyStrategyInput),
    "provider.refresh": (input) =>
      operations.refreshProvider(input as ModelFetchParams),
  };

  for (const [id, operation] of Object.entries(modelFetchContract.operations)) {
    api.session.controls.registerSessionAction({
      id,
      description: operation.description,
      schema: operation.input as unknown as PluginJsonValue,
      requiredScopes: [operation.kind === "query" ? "operator.read" : "operator.write"],
      handler: async (context: PluginSessionActionContext) => {
        const payload = context.payload ?? {};
        if (!Value.Check(operation.input, payload)) {
          return {
            ok: false,
            error: `Invalid payload for ${id}.`,
            code: "INVALID_INPUT",
          };
        }
        try {
          const handler = handlers[id];
          if (!handler) {
            return {
              ok: false,
              error: `Missing handler for ${id}.`,
              code: "OPERATION_FAILED",
            };
          }
          return {
            ok: true,
            result: (await handler(payload)) as PluginJsonValue,
          };
        } catch (error) {
          return {
            ok: false,
            error: errorMessage(error),
            code: "OPERATION_FAILED",
          };
        }
      },
    });
  }

  return operations;
}

import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import type {
  OpenClawPluginApi,
  PluginJsonValue,
  PluginSessionActionContext,
} from "openclaw/plugin-sdk/core";
import { modelFetchContract } from "./contract.js";
import {
  applyModelReferenceProtection,
  collectCaseVariantRelations,
  collectModelReferenceUsages,
  fetchProviderModels,
  getProvider,
  listConfiguredAgentEntries,
  mergeModels,
  resolveDefaultModelRef,
  resolveApiKey,
  resolveProviderFilter,
  resolveProviderTargetAgents,
  selectFetchedModels,
  syncAgentModelEntries,
  syncConfiguredModelPolicyAllow,
  type ModelDefinitionLike,
  type ModelFetchConfig,
  type ModelFilterConfig,
  type ProviderLike,
} from "./model-fetch.js";
import { runModelFetch } from "./agent-tool.js";
import {
  mutateConfigFileWithRetry,
  replaceProviderModels,
  sameProviderModels,
} from "./model-replacement.js";
import {
  createModelFetchSessionCleanup,
  type SessionSelectionScope,
  type SessionStoreRuntime,
} from "./session-cleanup.js";
import type {
  ApplyPlan,
  AgentSummary,
  ApplyStrategyInput,
  ApplyStrategyOutput,
  CaseVariant,
  FetchModelsOutput,
  ListProvidersOutput,
  ModelFetchParams,
  ModelView,
  PreviewApplyOutput,
  ProviderSummary,
  ProtectedModel,
  ReferenceRewrite,
  SaveStrategyInput,
  SaveStrategyOutput,
} from "./schemas.js";

type MutableConfig = {
  agents?: {
    entries?: Record<
      string,
      | {
          modelPolicy?: {
            allow?: unknown;
          };
        }
      | undefined
    >;
  };
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
  protectedModels: ProtectedModel[];
  caseVariants: CaseVariant[];
  defaultModelRef?: string;
  models: ModelView[];
  fingerprint: string;
  finalModels: ModelDefinitionLike[];
  existingModels: ModelDefinitionLike[];
  mergedModels: ModelDefinitionLike[];
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

function normalizeTargetAgents(targetAgents: readonly string[] | undefined): string[] {
  if (!targetAgents || targetAgents.length === 0) return [];
  return [...new Set(targetAgents.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function configPath(providerId: string): string {
  return `models.providers.${providerId}.models`;
}

type NormalizedRewrite = {
  protectedModelId: string;
  fromRef: string;
  toRef: string;
};

/**
 * Validates the requested reference rewrites against the plan.
 *
 * A rewrite may only retarget a model that the plan protects, and it may only
 * point at a model that survives the replacement. Rewriting to a model that is
 * itself removed would leave the config with a dangling reference, so the
 * whole plan is rejected instead.
 */
function normalizeReferenceRewrites(
  requested: readonly ReferenceRewrite[] | undefined,
  computed: ComputedPlan,
): NormalizedRewrite[] {
  if (!requested || requested.length === 0) return [];

  const protectedIds = new Set(
    computed.protectedModels.map((entry) => entry.modelId),
  );
  const survivingIds = new Set(computed.finalModels.map((model) => model.id));
  const removedIds = new Set(computed.removedIds);
  const providerPrefix = `${computed.providerId}/`;

  const result: NormalizedRewrite[] = [];
  const seen = new Set<string>();
  for (const entry of requested) {
    const protectedModelId = entry.protectedModelId.trim();
    if (!protectedIds.has(protectedModelId)) {
      throw new Error(
        `引用改写目标 ${protectedModelId} 不在本次保留列表中，已取消写入。请重新预览。`,
      );
    }
    if (seen.has(protectedModelId)) continue;

    const targetRef = entry.targetRef.trim();
    if (!targetRef.startsWith(providerPrefix)) {
      throw new Error(
        `引用改写目标 ${targetRef} 不属于当前 Provider，已取消写入。请重新预览。`,
      );
    }
    const targetId = targetRef.slice(providerPrefix.length);
    if (!targetId) {
      throw new Error(
        `引用改写目标 ${targetRef} 无效，已取消写入。请重新预览。`,
      );
    }
    if (removedIds.has(targetId) || !survivingIds.has(targetId)) {
      throw new Error(
        `引用改写目标 ${targetRef} 也会被删除，已取消写入。请重新预览。`,
      );
    }

    seen.add(protectedModelId);
    result.push({
      protectedModelId,
      fromRef: `${computed.providerId}/${protectedModelId}`,
      toRef: targetRef,
    });
  }

  const rewrittenProtectedIds = new Set(
    result.map((entry) => entry.protectedModelId),
  );
  for (const entry of result) {
    const targetId = entry.toRef.slice(providerPrefix.length);
    if (
      targetId !== entry.protectedModelId &&
      rewrittenProtectedIds.has(targetId)
    ) {
      throw new Error(
        `引用改写目标 ${entry.toRef} 也会在本次操作中被改写，已取消写入。请改为一个最终保留的模型。`,
      );
    }
  }
  return result;
}

function planFingerprint(input: {
  providerId: string;
  filter: ModelFilterConfig;
  fetched: ModelDefinitionLike[];
  existing: ModelDefinitionLike[];
  selectedIds: string[];
  addedIds: string[];
  removedIds: string[];
  protectedModels: ProtectedModel[];
  defaultModelRef?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: input.providerId,
        filter: input.filter,
        fetched: input.fetched,
        existing: input.existing,
        selected: input.selectedIds,
        added: input.addedIds,
        removed: input.removedIds,
        protected: input.protectedModels.map((entry) => ({
          modelId: entry.modelId,
          references: entry.references,
        })),
        defaultModelRef: input.defaultModelRef,
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

function ensurePluginEntry(
  draft: MutableConfig,
  providerId: string,
  filter: ModelFilterConfig,
  targetAgents: readonly string[] = [],
) {
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
    targetAgents: normalizeTargetAgents(targetAgents),
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
  sessionStore,
}: {
  api: OpenClawPluginApi;
  factoryConfig?: ModelFetchConfig;
  fetchModels?: typeof fetchProviderModels;
  now?: () => Date;
  sessionStore?: Partial<SessionStoreRuntime>;
}) {
  const runtime = api.runtime;
  const sessionCleanup = createModelFetchSessionCleanup({
    currentConfig: () => runtime.config.current(),
    sessionStore,
  });

  function currentConfig(): unknown {
    return runtime.config.current();
  }

  function savedFilter(providerId: string, config = currentConfig()): ModelFilterConfig {
    return normalizeFilter(resolveProviderFilter(providerId, config, factoryConfig));
  }

  function savedTargetAgents(providerId: string, config = currentConfig()): string[] {
    return normalizeTargetAgents(resolveProviderTargetAgents(providerId, config, factoryConfig));
  }

  /**
   * Models kept only because of a reference are absent from `removedIds`, so the
   * protection set has to be recomputed over removals plus protected models.
   * Called against the write draft, this also catches references that appeared
   * after the user confirmed the preview.
   */
  function referenceProtectionDrift(
    config: unknown,
    providerId: string,
    computed: ComputedPlan,
  ): boolean {
    const current = collectModelReferenceUsages(config, providerId, [
      ...computed.removedIds,
      ...computed.protectedModels.map((entry) => entry.modelId),
    ]);
    return JSON.stringify(current) !== JSON.stringify(computed.protectedModels);
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
    const { provider, fetched, fetchedAt, config } = await fetchModelsForProvider(providerId);
    const filter = savedFilter(providerId, config);
    selectFetchedModels(fetched, filter);

    const existing = provider.models ?? [];
    const selected = selectFetchedModels(fetched, filter);
    const merge = mergeModels({ existing, selected, filter });
    const protection = applyModelReferenceProtection({
      existing,
      merged: merge.models,
      providerId,
      config,
    });
    const existingIds = existing.map((model) => model.id);
    const finalIds = new Set(protection.models.map((model) => model.id));
    const existingSet = new Set(existingIds);
    const removedIds = existingIds.filter((id) => !finalIds.has(id));
    const addedIds = merge.models
      .filter((model) => !existingSet.has(model.id))
      .map((model) => model.id);
    const models = fetched.map(toModelView);
    const visibleIds = new Set(models.map((model) => model.id));
    const manualIds = new Set(filter.manualIds ?? []);
    const protectedIds = new Set(protection.protectedModels.map((entry) => entry.modelId));
    for (const model of existing) {
      const keepVisible = manualIds.has(model.id) || protectedIds.has(model.id);
      if (keepVisible && !visibleIds.has(model.id)) {
        models.push(toModelView(model));
        visibleIds.add(model.id);
      }
    }

    const defaultModelRef = resolveDefaultModelRef(config);
    const fingerprint = planFingerprint({
      providerId,
      filter,
      fetched,
      existing,
      selectedIds: merge.selectedIds,
      addedIds,
      removedIds,
      protectedModels: protection.protectedModels,
      defaultModelRef,
    });

    const caseVariants = collectCaseVariantRelations(
      removedIds,
      protection.models.map((model) => model.id),
    );
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
      protectedModels: protection.protectedModels,
      caseVariants,
      defaultModelRef,
      models,
      fingerprint,
      finalModels: protection.models,
      existingModels: existing,
      mergedModels: merge.models,
    };
  }

  async function listProviders(): Promise<ListProvidersOutput> {
    const config = currentConfig();
    const providers = (config as MutableConfig | undefined)?.models?.providers ?? {};
    const result: ProviderSummary[] = [];
    const agents: AgentSummary[] = listConfiguredAgentEntries(config)
      .map(({ id, entry }) => ({
        id,
        hasModelAllowlist:
          Array.isArray(entry?.modelPolicy?.allow) && entry.modelPolicy.allow.length > 0,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

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
        targetAgents: savedTargetAgents(providerId, config),
        configuredModels: (provider.models ?? []).map(toModelView),
      });
    }

    return { providers: result, agents };
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
    targetAgents,
  }: SaveStrategyInput): Promise<SaveStrategyOutput> {
    const config = currentConfig();
    getProvider(config, provider);
    const nextFilter = normalizeFilter(filter);
    selectFetchedModels([], nextFilter);

    const nextTargetAgents =
      targetAgents === undefined
        ? savedTargetAgents(provider, config)
        : normalizeTargetAgents(targetAgents);

    const result = await mutateConfigFileWithRetry(runtime, {
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        ensurePluginEntry(draft as MutableConfig, provider, nextFilter, nextTargetAgents);
      },
    });

    return {
      provider,
      savedAt: now().toISOString(),
      configPath: result.path,
      filter: nextFilter,
      targetAgents: nextTargetAgents,
    };
  }

  async function previewApply(
    provider: string,
    scope: SessionSelectionScope = {},
  ): Promise<PreviewApplyOutput> {
    const computed = await computePlan(provider);
    const affectedSessions = await sessionCleanup.affectedSessions(
      provider,
      computed.removedIds,
      scope,
    );
    const plan: ApplyPlan = {
      fingerprint: computed.fingerprint,
      fetchedAt: computed.fetchedAt,
      fetchedCount: computed.fetched.length,
      addedIds: computed.addedIds,
      removedIds: computed.removedIds,
      protectedModels: computed.protectedModels,
      caseVariants: computed.caseVariants,
      ...(computed.defaultModelRef !== undefined
        ? { defaultModelRef: computed.defaultModelRef }
        : {}),
      selectedIds: computed.selectedIds,
      unchangedCount: computed.unchangedCount,
      affectedSessions,
    };
    return {
      provider,
      plan,
      models: computed.models,
    };
  }

  async function applyStrategy(
    {
      provider,
      fingerprint,
      expectedRemovals,
      referenceRewrites,
      targetAgents,
    }: ApplyStrategyInput,
    scope: SessionSelectionScope = {},
  ): Promise<ApplyStrategyOutput> {
    const computed = await computePlan(provider);
    if (computed.fingerprint !== fingerprint) {
      throw new Error("模型列表或筛选策略已变化，请重新预览后再确认应用。");
    }
    if (!sameStringSets(computed.removedIds, expectedRemovals)) {
      throw new Error("待删除模型与确认列表不一致，已取消写入。请重新预览。");
    }

    const rewrites = normalizeReferenceRewrites(
      referenceRewrites,
      computed,
    );

    const nextTargetAgents = normalizeTargetAgents(
      targetAgents ?? savedTargetAgents(provider),
    );
    let syncedAgents: string[] = [];
    let rewrittenReferences: string[] = [];
    let removedIds = computed.removedIds;
    let finalProtectedModels = computed.protectedModels;

    const result = await mutateConfigFileWithRetry(runtime, {
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        rewrittenReferences.length = 0;
        syncedAgents = [];
        removedIds = computed.removedIds;
        finalProtectedModels = computed.protectedModels;

        const config = draft as MutableConfig;
        const target = getProvider(config, provider);
        if (!sameProviderModels(
          target,
          target.models ?? [],
          computed.provider,
          computed.existingModels,
        )) {
          throw new Error("Provider 配置在确认后发生变化，已取消写入。请重新预览。");
        }
        const currentFilter = normalizeFilter(
          resolveProviderFilter(provider, config, factoryConfig),
        );
        if (JSON.stringify(currentFilter) !== JSON.stringify(computed.filter)) {
          throw new Error("Provider 筛选策略在确认后发生变化，已取消写入。请重新预览。");
        }
        if (referenceProtectionDrift(config, provider, computed)) {
          throw new Error("模型引用在确认后发生变化，已取消写入。请重新预览。");
        }

        const replacement = replaceProviderModels(config, {
          providerId: provider,
          provider: computed.provider,
          existingModels: computed.existingModels,
          mergedModels: computed.mergedModels,
          rewrites,
          caseVariants: computed.caseVariants,
          targetAgents: nextTargetAgents,
        });
        removedIds = replacement.removedIds;
        finalProtectedModels = replacement.protectedModels;
        rewrittenReferences = replacement.rewrittenReferences;
        syncedAgents = replacement.syncedAgents;
      },
    });

    // The session list is re-read after the write so the cleanup sees the
    // latest state and honours locks taken since the preview.
    const resetSessionKeys = await sessionCleanup.reset({
      providerId: provider,
      removedIds,
      scope,
    });

    return {
      provider,
      persisted: true,
      configPath: result.path,
      fetchedAt: computed.fetchedAt,
      fetchedCount: computed.fetched.length,
      added: computed.addedIds.length,
      unchanged: computed.unchangedCount,
      removed: removedIds.length,
      selectedIds: computed.selectedIds,
      protectedModels: finalProtectedModels,
      rewrittenReferences,
      targetAgents: nextTargetAgents,
      syncedAgents,
      sessionSelectionResets: resetSessionKeys.length,
      resetSessionKeys,
      models: computed.models,
    };
  }

  async function refreshProvider(params: ModelFetchParams) {
    return runModelFetch({
      api,
      factoryConfig,
      fetchModels,
      params,
      sessionCleanup,
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
  const handlers: Record<
    string,
    (input: unknown, context: PluginSessionActionContext) => Promise<unknown>
  > = {
    "providers.list": () => operations.listProviders(),
    "models.fetch": (input) =>
      operations.fetchModels((input as { provider: string }).provider),
    "strategy.save": (input) => operations.saveStrategy(input as SaveStrategyInput),
    "strategy.preview": (input, context) =>
      operations.previewApply((input as { provider: string }).provider, {
        sessionKey: context.sessionKey,
        agentId: context.agentId,
      }),
    "strategy.apply": (input, context) =>
      operations.applyStrategy(input as ApplyStrategyInput, {
        sessionKey: context.sessionKey,
        agentId: context.agentId,
      }),
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
            result: (await handler(payload, context)) as PluginJsonValue,
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

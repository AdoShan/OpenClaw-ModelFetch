import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import type {
  OpenClawPluginApi,
  PluginJsonValue,
  PluginSessionActionContext,
} from "openclaw/plugin-sdk/core";
import {
  getSessionEntryAsync,
  listSessionEntries,
  patchSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { modelFetchContract } from "./contract.js";
import {
  applyModelReferenceProtection,
  collectModelReferenceUsages,
  fetchProviderModels,
  getProvider,
  mergeModels,
  resolveApiKey,
  resolveProviderFilter,
  resolveProviderTargetAgents,
  runModelFetch,
  selectFetchedModels,
  syncAgentModelEntries,
  syncConfiguredModelPolicyAllow,
  type ModelDefinitionLike,
  type ModelFetchConfig,
  type ModelFilterConfig,
  type ProviderLike,
} from "./model-fetch.js";
import type {
  AffectedSession,
  ApplyPlan,
  AgentSummary,
  ApplyStrategyInput,
  ApplyStrategyOutput,
  FetchModelsOutput,
  ListProvidersOutput,
  ModelFetchParams,
  ModelView,
  PreviewApplyOutput,
  ProviderSummary,
  ProtectedModel,
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
  models: ModelView[];
  fingerprint: string;
  finalModels: ModelDefinitionLike[];
};

type SessionSelectionScope = {
  sessionKey?: string;
  agentId?: string;
};

type SessionStoreRuntime = {
  getSessionEntryAsync: typeof getSessionEntryAsync;
  patchSessionEntry: typeof patchSessionEntry;
  listSessionEntries: typeof listSessionEntries;
};

type SessionEntryCandidate = {
  sessionKey: string;
  agentId: string;
  entry: SessionEntry;
};

type SessionResetTarget = {
  sessionKey: string;
  agentId: string;
};

const AFFECTED_SESSION_LIMIT = 2_000;
const DEFAULT_AGENT_ID = "main";

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

function planFingerprint(input: {
  providerId: string;
  filter: ModelFilterConfig;
  fetchedIds: string[];
  existingIds: string[];
  selectedIds: string[];
  addedIds: string[];
  removedIds: string[];
  protectedModels: ProtectedModel[];
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
        protected: input.protectedModels.map((entry) => ({
          modelId: entry.modelId,
          references: entry.references,
        })),
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

function staleOverrideMatches(
  entry: SessionEntry,
  providerId: string,
  removedIds: readonly string[],
): boolean {
  if (entry.providerOverride) {
    return entry.providerOverride === providerId && removedIds.includes(entry.modelOverride ?? "");
  }
  if (entry.modelOverride) {
    return removedIds.some((modelId) => entry.modelOverride === `${providerId}/${modelId}`);
  }
  return entry.modelProvider === providerId && removedIds.includes(entry.model ?? "");
}

/**
 * Session keys are stored as `agent:<agentId>:<rest>`. The agent id prefix is
 * case insensitive, and only the leading ownership segment is parsed.
 */
function parseAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const raw = sessionKey?.trim() ?? "";
  if (raw.length < 7 || raw.slice(0, 6).toLowerCase() !== "agent:") return undefined;
  const separator = raw.indexOf(":", 6);
  if (separator === -1) return undefined;
  const agentId = raw.slice(6, separator).trim();
  const rest = raw.slice(separator + 1);
  if (!agentId || !rest || rest.startsWith(":")) return undefined;
  return agentId;
}

/**
 * The cleared fields of one stale session selection. A session that only kept
 * the runtime model also loses its runtime context bookkeeping.
 */
function staleSelectionResetUpdate(
  entry: SessionEntry,
  providerId: string,
  removedIds: readonly string[],
): Partial<SessionEntry> {
  const runtimeModelMatches =
    entry.modelProvider === providerId && removedIds.includes(entry.model ?? "");
  return {
    providerOverride: undefined,
    modelOverride: undefined,
    modelOverrideSource: undefined,
    modelOverrideRouteResolution: undefined,
    modelOverrideFallbackOriginProvider: undefined,
    modelOverrideFallbackOriginModel: undefined,
    ...(runtimeModelMatches
      ? {
          model: undefined,
          modelProvider: undefined,
          contextTokens: undefined,
          contextTokensSource: undefined,
          contextBudgetStatus: undefined,
        }
      : {}),
  };
}

/**
 * Clears the stale selection of every listed session. Each session is read
 * again right before it is patched so a lock taken after the preview is
 * honoured, and one failing session never stops the remaining ones.
 */
async function resetStaleSessionSelections({
  candidates,
  providerId,
  removedIds,
  sessionStore,
}: {
  candidates: readonly SessionResetTarget[];
  providerId: string;
  removedIds: readonly string[];
  sessionStore: SessionStoreRuntime;
}): Promise<string[]> {
  const resetSessionKeys: string[] = [];
  if (removedIds.length === 0) return resetSessionKeys;

  for (const candidate of candidates) {
    try {
      const latest = await sessionStore.getSessionEntryAsync({
        sessionKey: candidate.sessionKey,
        agentId: candidate.agentId,
      });
      if (!latest || latest.modelSelectionLocked === true) continue;
      if (!staleOverrideMatches(latest, providerId, removedIds)) continue;

      const updated = await sessionStore.patchSessionEntry({
        sessionKey: candidate.sessionKey,
        agentId: candidate.agentId,
        preserveActivity: true,
        update: () => staleSelectionResetUpdate(latest, providerId, removedIds),
      });
      if (updated) resetSessionKeys.push(candidate.sessionKey);
    } catch {
      // A single failing session must not abort the remaining cleanups.
    }
  }

  return resetSessionKeys;
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
  sessionStore = { getSessionEntryAsync, patchSessionEntry, listSessionEntries },
}: {
  api: OpenClawPluginApi;
  factoryConfig?: ModelFetchConfig;
  fetchModels?: typeof fetchProviderModels;
  now?: () => Date;
  sessionStore?: SessionStoreRuntime;
}) {
  const runtime = api.runtime;

  function currentConfig(): unknown {
    return runtime.config.current();
  }

  function savedFilter(providerId: string, config = currentConfig()): ModelFilterConfig {
    return normalizeFilter(resolveProviderFilter(providerId, config, factoryConfig));
  }

  function savedTargetAgents(providerId: string, config = currentConfig()): string[] {
    return normalizeTargetAgents(resolveProviderTargetAgents(providerId, config, factoryConfig));
  }

  function configuredAgentIds(config = currentConfig()): string[] {
    const entries = (config as MutableConfig | undefined)?.agents?.entries ?? {};
    return Object.keys(entries).filter((agentId) => agentId.trim().length > 0);
  }

  /**
   * Lists the sessions of every candidate agent. `listSessionEntries` is
   * agent scoped, so agents discovered inside the returned session keys are
   * scanned as well.
   */
  async function collectSessionEntries(
    agentIds: readonly string[],
  ): Promise<SessionEntryCandidate[]> {
    const candidates: SessionEntryCandidate[] = [];
    const visited = new Set<string>();
    const queue = [...agentIds];

    while (queue.length > 0) {
      const agentId = (queue.shift() ?? "").trim();
      if (!agentId) continue;
      const normalized = agentId.toLowerCase();
      if (visited.has(normalized)) continue;
      visited.add(normalized);

      let summaries: Awaited<ReturnType<SessionStoreRuntime["listSessionEntries"]>> = [];
      try {
        summaries = await sessionStore.listSessionEntries({
          agentId,
          readOnly: true,
        });
      } catch {
        // One unreadable agent store must not stop the remaining ones.
        continue;
      }

      for (const summary of summaries ?? []) {
        const sessionKey = summary?.sessionKey;
        if (!sessionKey) continue;
        const parsedAgentId = parseAgentIdFromSessionKey(sessionKey);
        candidates.push({
          sessionKey,
          agentId: parsedAgentId ?? agentId,
          entry: summary.entry,
        });
        if (parsedAgentId && !visited.has(parsedAgentId.toLowerCase())) {
          queue.push(parsedAgentId);
        }
      }
    }

    return candidates;
  }

  /**
   * Sessions whose persisted model selection points at a model that the plan
   * removes. Locked sessions are never reported as affected.
   */
  function collectAffectedSessions(
    candidates: readonly SessionEntryCandidate[],
    providerId: string,
    removedIds: readonly string[],
  ): AffectedSession[] {
    const affected: AffectedSession[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (affected.length >= AFFECTED_SESSION_LIMIT) break;
      const entry = candidate.entry;
      if (!entry) continue;
      if (entry.modelSelectionLocked === true) continue;
      if (!staleOverrideMatches(entry, providerId, removedIds)) continue;

      const dedupeKey = `${candidate.agentId.toLowerCase()}::${candidate.sessionKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      affected.push({
        sessionKey: candidate.sessionKey,
        agentId: candidate.agentId,
        label: entry.label || entry.displayName || candidate.sessionKey,
      });
    }

    return affected;
  }

  /**
   * Every session across the known agents whose selection becomes stale.
   * `main` is always scanned, the calling agent is added when known, and
   * agents are additionally derived from the session keys themselves.
   */
  async function affectedSessionsFor({
    providerId,
    removedIds,
    scope,
  }: {
    providerId: string;
    removedIds: readonly string[];
    scope: SessionSelectionScope;
  }): Promise<AffectedSession[]> {
    if (removedIds.length === 0) return [];

    const agentIds = new Set<string>([DEFAULT_AGENT_ID]);
    const scopeAgentId = scope.agentId?.trim();
    if (scopeAgentId) agentIds.add(scopeAgentId);
    const scopedKeyAgentId = scope.sessionKey
      ? parseAgentIdFromSessionKey(scope.sessionKey)
      : undefined;
    if (scopedKeyAgentId) agentIds.add(scopedKeyAgentId);
    for (const agentId of configuredAgentIds()) agentIds.add(agentId);

    const candidates = await collectSessionEntries([...agentIds]);

    const scopedSessionKey = scope.sessionKey?.trim();
    const scopedOwnerId = scopeAgentId ?? scopedKeyAgentId;
    if (scopedSessionKey && scopedOwnerId) {
      const known = candidates.some(
        (candidate) => candidate.sessionKey === scopedSessionKey,
      );
      if (!known) {
        try {
          const entry = await sessionStore.getSessionEntryAsync({
            sessionKey: scopedSessionKey,
            agentId: scopedOwnerId,
          });
          if (entry) {
            candidates.push({
              sessionKey: scopedSessionKey,
              agentId: scopedOwnerId,
              entry,
            });
          }
        } catch {
          // The scoped session is optional; ignore unreadable entries.
        }
      }
    }

    return collectAffectedSessions(candidates, providerId, removedIds);
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
    const filter = savedFilter(providerId);
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

    const fingerprint = planFingerprint({
      providerId,
      filter,
      fetchedIds: fetched.map((model) => model.id),
      existingIds,
      selectedIds: merge.selectedIds,
      addedIds,
      removedIds,
      protectedModels: protection.protectedModels,
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
      protectedModels: protection.protectedModels,
      models,
      fingerprint,
      finalModels: protection.models,
    };
  }

  async function listProviders(): Promise<ListProvidersOutput> {
    const config = currentConfig();
    const providers = (config as MutableConfig | undefined)?.models?.providers ?? {};
    const result: ProviderSummary[] = [];
    const agentEntries = (config as MutableConfig | undefined)?.agents?.entries ?? {};
    const agents: AgentSummary[] = Object.entries(agentEntries)
      .filter(([agentId]) => typeof agentId === "string" && agentId.trim().length > 0)
      .map(([agentId, entry]) => ({
        id: agentId,
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

    const result = await runtime.config.mutateConfigFile({
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
    const affectedSessions = await affectedSessionsFor({
      providerId: provider,
      removedIds: computed.removedIds,
      scope,
    });
    const plan: ApplyPlan = {
      fingerprint: computed.fingerprint,
      fetchedAt: computed.fetchedAt,
      fetchedCount: computed.fetched.length,
      addedIds: computed.addedIds,
      removedIds: computed.removedIds,
      protectedModels: computed.protectedModels,
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

    const nextTargetAgents = normalizeTargetAgents(
      targetAgents ?? savedTargetAgents(provider),
    );
    let syncedAgents: string[] = [];

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
        if (referenceProtectionDrift(config, provider, computed)) {
          throw new Error("模型引用在确认后发生变化，已取消写入。请重新预览。");
        }
        target.models = computed.finalModels;
        ensurePluginEntry(config, provider, computed.filter, nextTargetAgents);
        const syncResult = syncConfiguredModelPolicyAllow(config, provider, computed.finalModels, {
          targetAgents: nextTargetAgents,
        });
        syncedAgents = syncResult.syncedAgents;
        syncAgentModelEntries(config, provider, computed.finalModels, {
          targetAgents: syncedAgents,
        });
      },
    });

    // The session list is re-read after the write so the cleanup sees the
    // latest state and honours locks taken since the preview.
    const affectedSessions = await affectedSessionsFor({
      providerId: provider,
      removedIds: computed.removedIds,
      scope,
    });
    const resetSessionKeys = await resetStaleSessionSelections({
      candidates: affectedSessions.map((session) => ({
        sessionKey: session.sessionKey,
        agentId: session.agentId,
      })),
      providerId: provider,
      removedIds: computed.removedIds,
      sessionStore,
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
      protectedModels: computed.protectedModels,
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

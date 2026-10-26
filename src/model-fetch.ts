import type { TSchema } from "typebox";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/media-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  modelFetchConfigSchema,
  modelFetchFilterSchema,
  modelFetchParameters,
  modelFetchResultSchema,
  type ModelFetchConfig,
  type ModelFetchParams,
  type ModelFetchToolResult,
  type ModelFilterConfig,
  type ProtectedModel,
} from "./schemas.js";

export const MODEL_FETCH_TOOL_NAME = "model_fetch";
const CONFIG_PATH = "models.providers.<providerId>.models";
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export {
  modelFetchConfigSchema,
  modelFetchFilterSchema,
  modelFetchParameters,
  modelFetchResultSchema,
};
export type { ModelFetchConfig, ModelFetchParams, ModelFetchToolResult, ModelFilterConfig };

export type ModelDefinitionLike = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow?: number;
  maxTokens: number;
  [key: string]: unknown;
};

export type ProviderLike = {
  name?: string;
  baseUrl: string;
  api?: string;
  request?: {
    allowPrivateNetwork?: boolean;
  };
  models?: ModelDefinitionLike[];
};

type ConfigLike = {
  agents?: {
    defaults?: {
      modelPolicy?: {
        allow?: unknown;
      };
    };
    entries?: Record<
      string,
      | {
          modelPolicy?: {
            allow?: unknown;
          };
          models?: Record<string, Record<string, unknown> | undefined>;
        }
      | undefined
    >;
  };
  models?: {
    providers?: Record<string, ProviderLike | undefined>;
  };
  plugins?: {
    entries?: Record<
      string,
      | {
          config?: unknown;
        }
      | undefined
    >;
  };
};

export type AllowlistSyncResult = {
  defaultsUpdated: boolean;
  syncedAgents: string[];
};

export type AgentModelSyncResult = {
  syncedAgents: string[];
};

type GuardedFetchOptions = Parameters<typeof fetchWithSsrFGuard>[0];
type GuardedFetchResult = Awaited<ReturnType<typeof fetchWithSsrFGuard>>;

function toModelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function normalizeAllowList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const ref = item.trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    normalized.push(ref);
  }
  return normalized;
}

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function hasProviderScopedRule(allow: readonly string[], providerId: string): boolean {
  const prefix = `${providerId}/`;
  const wildcard = `${providerId}/*`;
  return allow.some((ref) => ref === wildcard || ref.startsWith(prefix));
}

function reconcileModelRefs(
  allowValue: unknown,
  providerId: string,
  modelRefs: readonly string[],
): { changed: boolean; next?: string[] } {
  if (!Array.isArray(allowValue) || allowValue.length === 0) {
    return { changed: false };
  }

  const selectedRefs = new Set(modelRefs);
  const providerPrefix = `${providerId}/`;
  const next: string[] = [];
  const existing = new Set<string>();
  let changed = false;

  for (const item of allowValue) {
    if (typeof item !== "string") {
      changed = true;
      continue;
    }
    const ref = item.trim();
    if (!ref || existing.has(ref)) {
      changed = true;
      continue;
    }
    existing.add(ref);
    if (
      ref.startsWith(providerPrefix) &&
      !ref.includes("*") &&
      !selectedRefs.has(ref)
    ) {
      changed = true;
      continue;
    }
    next.push(ref);
  }

  for (const ref of modelRefs) {
    if (existing.has(ref)) continue;
    existing.add(ref);
    next.push(ref);
    changed = true;
  }

  return changed ? { changed: true, next } : { changed: false };
}

export function syncConfiguredModelPolicyAllow(
  draft: unknown,
  providerId: string,
  models: ModelDefinitionLike[],
  options: {
    targetAgents?: readonly string[];
  } = {},
): AllowlistSyncResult {
  const cfg = draft as ConfigLike;
  const modelRefs = models.map((model) => toModelRef(providerId, model.id));

  const defaultsResult = reconcileModelRefs(
    cfg.agents?.defaults?.modelPolicy?.allow,
    providerId,
    modelRefs,
  );
  let defaultsUpdated = false;
  if (defaultsResult.changed) {
    cfg.agents ??= {};
    cfg.agents.defaults ??= {};
    cfg.agents.defaults.modelPolicy ??= {};
    cfg.agents.defaults.modelPolicy.allow = defaultsResult.next;
    defaultsUpdated = true;
  }

  const agentEntries = cfg.agents?.entries;
  if (!agentEntries) {
    return { defaultsUpdated, syncedAgents: [] };
  }

  const selectedAgents = normalizeAgentIds(options.targetAgents);
  const forcedAgentSet = selectedAgents.length > 0 ? new Set(selectedAgents) : null;
  const syncedAgents: string[] = [];
  for (const [agentId, entry] of Object.entries(agentEntries)) {
    if (!entry?.modelPolicy) continue;
    const normalized = normalizeAllowList(entry.modelPolicy.allow);
    const shouldSync =
      forcedAgentSet?.has(agentId) ?? hasProviderScopedRule(normalized, providerId);
    if (!shouldSync) continue;

    const result = reconcileModelRefs(entry.modelPolicy.allow, providerId, modelRefs);
    const selectedWithAllowlist =
      forcedAgentSet?.has(agentId) === true && normalized.length > 0;
    if (result.changed) {
      agentEntries[agentId] = {
        ...entry,
        modelPolicy: {
          ...entry.modelPolicy,
          allow: result.next,
        },
      };
    }
    if (result.changed || selectedWithAllowlist) {
      syncedAgents.push(agentId);
    }
  }

  return { defaultsUpdated, syncedAgents };
}

export function syncAgentModelEntries(
  draft: unknown,
  providerId: string,
  models: ModelDefinitionLike[],
  options: {
    targetAgents?: readonly string[];
  } = {},
): AgentModelSyncResult {
  const cfg = draft as ConfigLike;
  const modelRefs = models.map((model) => toModelRef(providerId, model.id));

  const selectedAgents = normalizeAgentIds(options.targetAgents);
  if (selectedAgents.length === 0) return { syncedAgents: [] };

  const agentEntries = cfg.agents?.entries;
  if (!agentEntries) return { syncedAgents: [] };

  const syncedAgents: string[] = [];
  for (const agentId of selectedAgents) {
    const entry = agentEntries[agentId];
    if (!entry) continue;
    const selectedRefs = new Set(modelRefs);
    const providerPrefix = `${providerId}/`;
    const modelsConfig = { ...(entry.models ?? {}) };
    let changed = false;

    for (const ref of Object.keys(modelsConfig)) {
      if (!ref.startsWith(providerPrefix) || selectedRefs.has(ref)) continue;
      delete modelsConfig[ref];
      changed = true;
    }

    for (const ref of modelRefs) {
      if (modelsConfig[ref]) continue;
      modelsConfig[ref] = {};
      changed = true;
    }
    if (!changed) continue;
    agentEntries[agentId] = {
      ...entry,
      models: modelsConfig,
    };
    syncedAgents.push(agentId);
  }

  return { syncedAgents };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFilter(value: unknown): ModelFilterConfig {
  if (!isRecord(value)) return {};
  const filter = value.filter;
  if (!isRecord(filter)) return {};

  const manualIds = Array.isArray(filter.manualIds)
    ? filter.manualIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : undefined;

  return {
    includeRegex: typeof filter.includeRegex === "string" ? filter.includeRegex : undefined,
    excludeRegex: typeof filter.excludeRegex === "string" ? filter.excludeRegex : undefined,
    manualIds,
    replace: typeof filter.replace === "boolean" ? filter.replace : undefined,
  };
}

function parseTargetAgents(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return normalizeAgentIds(value.targetAgents);
}

export function resolveProviderFilter(
  providerId: string,
  runtimeConfig: unknown,
  factoryConfig: ModelFetchConfig | undefined,
): ModelFilterConfig {
  const cfg = runtimeConfig as ConfigLike | undefined;
  const runtimeEntry = cfg?.plugins?.entries?.["model-fetch"];
  const runtimePluginConfig = isRecord(runtimeEntry) ? runtimeEntry.config : undefined;
  const source =
    isRecord(runtimePluginConfig) && isRecord(runtimePluginConfig.providers)
      ? runtimePluginConfig.providers
      : factoryConfig?.providers;
  const providerEntry = isRecord(source) ? source[providerId] : undefined;
  return parseFilter(providerEntry);
}

export function resolveProviderTargetAgents(
  providerId: string,
  runtimeConfig: unknown,
  factoryConfig: ModelFetchConfig | undefined,
): string[] {
  const cfg = runtimeConfig as ConfigLike | undefined;
  const runtimeEntry = cfg?.plugins?.entries?.["model-fetch"];
  const runtimePluginConfig = isRecord(runtimeEntry) ? runtimeEntry.config : undefined;
  const source =
    isRecord(runtimePluginConfig) && isRecord(runtimePluginConfig.providers)
      ? runtimePluginConfig.providers
      : factoryConfig?.providers;
  const providerEntry = isRecord(source) ? source[providerId] : undefined;
  return parseTargetAgents(providerEntry);
}

function compileRegex(pattern: string | undefined, field: string): RegExp | undefined {
  if (pattern === undefined || pattern === "") return undefined;
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${field} regex "${pattern}": ${message}`);
  }
}

export function selectFetchedModels(
  models: ModelDefinitionLike[],
  filter: ModelFilterConfig,
): ModelDefinitionLike[] {
  const include = compileRegex(filter.includeRegex, "includeRegex");
  const exclude = compileRegex(filter.excludeRegex, "excludeRegex");
  const manualIds = new Set((filter.manualIds ?? []).map((id) => id.trim()).filter(Boolean));
  const seen = new Set<string>();
  const selected: ModelDefinitionLike[] = [];

  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    const isManual = manualIds.has(id);
    const matchesInclude = include ? include.test(id) : true;
    const matchesExclude = exclude ? exclude.test(id) : false;
    const manualOnlySelection = include === undefined && manualIds.size > 0;
    if (manualOnlySelection ? !isManual : ((!matchesInclude || matchesExclude) && !isManual)) {
      continue;
    }
    seen.add(id);
    selected.push(model);
  }

  return selected;
}

export function resolveEffectiveFilter(
  persisted: ModelFilterConfig,
  temporary: ModelFetchParams,
): ModelFilterConfig {
  return {
    includeRegex: temporary.includeRegex ?? persisted.includeRegex,
    excludeRegex: temporary.excludeRegex ?? persisted.excludeRegex,
    manualIds: temporary.manualIds ?? persisted.manualIds,
    // Default to replacement mode. Persisted legacy `replace: false` should not disable
    // replacement unless the current tool call explicitly asks for additive mode.
    replace: temporary.replace ?? true,
  };
}

export function createDefaultModel(id: string, name?: string): ModelDefinitionLike {
  return {
    id,
    name: name?.trim() || id,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

export type ModelMergeResult = {
  models: ModelDefinitionLike[];
  added: number;
  unchanged: number;
  removed: number;
  selectedIds: string[];
};

export function mergeModels({
  existing,
  selected,
  filter,
}: {
  existing: ModelDefinitionLike[];
  selected: ModelDefinitionLike[];
  filter: ModelFilterConfig;
}): ModelMergeResult {
  const selectedById = new Map(selected.map((model) => [model.id, model]));
  const manualIds = new Set((filter.manualIds ?? []).map((id) => id.trim()).filter(Boolean));
  const existingById = new Map(existing.map((model) => [model.id, model]));
  const next: ModelDefinitionLike[] = [];

  const keepExisting = (model: ModelDefinitionLike): boolean => {
    if (!filter.replace) return true;
    return selectedById.has(model.id) || manualIds.has(model.id);
  };

  for (const model of existing) {
    if (!keepExisting(model)) continue;
    next.push(model);
  }

  let added = 0;
  for (const model of selected) {
    if (existingById.has(model.id)) continue;
    next.push(model);
    added += 1;
  }

  const selectedIds = [
    ...new Set([
      ...selected.map((model) => model.id),
      ...[...manualIds].filter((id) => existingById.has(id)),
    ]),
  ];
  const unchanged = selected.filter((model) => existingById.has(model.id)).length;
  const removed = existing.length - next.filter((model) => existingById.has(model.id)).length;

  return {
    models: next,
    added,
    unchanged,
    removed,
    selectedIds,
  };
}

type ModelReferenceVisitor = (ref: string, path: string) => void;

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readModelRefScalar(value: unknown, path: string, visit: ModelReferenceVisitor): void {
  if (typeof value !== "string") return;
  const ref = value.trim();
  if (ref) visit(ref, path);
}

/** Model settings accept either a bare `provider/model` string or `{ primary, fallbacks[] }`. */
function readModelRefSetting(value: unknown, path: string, visit: ModelReferenceVisitor): void {
  if (typeof value === "string") {
    readModelRefScalar(value, path, visit);
    return;
  }
  if (!isRecord(value)) return;
  readModelRefScalar(value.primary, `${path}.primary`, visit);
  if (!Array.isArray(value.fallbacks)) return;
  value.fallbacks.forEach((fallback, index) => {
    readModelRefScalar(fallback, `${path}.fallbacks[${index}]`, visit);
  });
}

/**
 * Walks the explicit model references that live outside the agent allowlist and
 * agent `models` sync. Those two collections are reconciled separately by the
 * apply operation; deleting a model named here would leave a dangling
 * `provider/model` reference behind.
 */
function forEachExplicitModelReference(config: unknown, visit: ModelReferenceVisitor): void {
  if (!isRecord(config)) return;

  const tools = isRecord(config.tools) ? config.tools : undefined;
  if (tools) {
    const exec = asOptionalRecord(tools.exec);
    const reviewer = asOptionalRecord(exec?.reviewer);
    readModelRefSetting(reviewer?.model, "tools.exec.reviewer.model", visit);

    if (isRecord(tools.media)) {
      for (const capability of ["image", "audio", "video"] as const) {
        readModelRefScalar(
          asOptionalRecord(tools.media[capability])?.preferredModel,
          `tools.media.${capability}.preferredModel`,
          visit,
        );
      }
    }
  }

  const agents = isRecord(config.agents) ? config.agents : undefined;
  const defaults = asOptionalRecord(agents?.defaults);
  if (defaults) visitAgentModelReferences("agents.defaults", defaults, false, visit);

  if (agents && isRecord(agents.entries)) {
    for (const agentId of Object.keys(agents.entries).sort((left, right) => left.localeCompare(right))) {
      const entry = agents.entries[agentId];
      if (isRecord(entry)) {
        visitAgentModelReferences(`agents.entries.${agentId}`, entry, true, visit);
      }
    }
  } else if (agents && Array.isArray(agents.list)) {
    agents.list.forEach((entry, index) => {
      if (isRecord(entry)) {
        visitAgentModelReferences(`agents.list[${index}]`, entry, true, visit);
      }
    });
  }

  const tts = asOptionalRecord(config.tts);
  if (tts) {
    readModelRefSetting(tts.summaryModel, "tts.summaryModel", visit);
  }

  const hooks = isRecord(config.hooks) ? config.hooks : undefined;
  if (hooks) {
    if (isRecord(hooks.gmail)) {
      readModelRefScalar(hooks.gmail.model, "hooks.gmail.model", visit);
    }
    if (Array.isArray(hooks.mappings)) {
      hooks.mappings.forEach((mapping, index) => {
        if (!isRecord(mapping)) return;
        readModelRefScalar(mapping.model, `hooks.mappings[${index}].model`, visit);
      });
    }
  }

  const channels = isRecord(config.channels) ? config.channels : undefined;
  if (channels) {
    const modelByChannel = isRecord(channels.modelByChannel) ? channels.modelByChannel : undefined;
    if (modelByChannel) {
      for (const channelId of Object.keys(modelByChannel).sort((left, right) => left.localeCompare(right))) {
        const channelMap = modelByChannel[channelId];
        if (!isRecord(channelMap)) continue;
        for (const targetId of Object.keys(channelMap).sort((left, right) => left.localeCompare(right))) {
          readModelRefSetting(
            channelMap[targetId],
            `channels.modelByChannel.${channelId}.${targetId}`,
            visit,
          );
        }
      }
    }

    const discord = isRecord(channels.discord) ? channels.discord : undefined;
    if (discord) {
      visitDiscordVoiceModelReferences("channels.discord.voice", discord.voice, visit);
      if (isRecord(discord.accounts)) {
        for (const accountId of Object.keys(discord.accounts).sort((left, right) => left.localeCompare(right))) {
          visitDiscordVoiceModelReferences(
            `channels.discord.accounts.${accountId}.voice`,
            asOptionalRecord(discord.accounts[accountId])?.voice,
            visit,
          );
        }
      }
    }
  }
}

function visitAgentModelReferences(
  path: string,
  agent: Record<string, unknown>,
  includeEntrySelectors: boolean,
  visit: ModelReferenceVisitor,
): void {
  readModelRefSetting(agent.model, `${path}.model`, visit);
  readModelRefScalar(agent.utilityModel, `${path}.utilityModel`, visit);
  readModelRefScalar(agent.decisionModel, `${path}.decisionModel`, visit);
  readModelRefSetting(agent.imageModel, `${path}.imageModel`, visit);
  readModelRefSetting(agent.voiceModel, `${path}.voiceModel`, visit);
  readModelRefSetting(agent.pdfModel, `${path}.pdfModel`, visit);

  const mediaModels = asOptionalRecord(agent.mediaModels);
  if (mediaModels) {
    for (const capability of ["image", "video", "music"] as const) {
      readModelRefSetting(mediaModels[capability], `${path}.mediaModels.${capability}`, visit);
    }
  }

  const cyberFailover = asOptionalRecord(asOptionalRecord(agent.embeddedAgent)?.cyberFailover);
  if (cyberFailover) {
    readModelRefSetting(cyberFailover.model, `${path}.embeddedAgent.cyberFailover.model`, visit);
  }

  readModelRefSetting(asOptionalRecord(agent.heartbeat)?.model, `${path}.heartbeat.model`, visit);
  readModelRefSetting(asOptionalRecord(agent.subagents)?.model, `${path}.subagents.model`, visit);

  const compaction = asOptionalRecord(agent.compaction);
  if (compaction) {
    readModelRefSetting(compaction.model, `${path}.compaction.model`, visit);
    readModelRefSetting(
      asOptionalRecord(compaction.memoryFlush)?.model,
      `${path}.compaction.memoryFlush.model`,
      visit,
    );
  }

  if (!includeEntrySelectors) return;
  const exec = asOptionalRecord(asOptionalRecord(agent.tools)?.exec);
  readModelRefSetting(asOptionalRecord(exec?.reviewer)?.model, `${path}.tools.exec.reviewer.model`, visit);
  readModelRefSetting(asOptionalRecord(agent.tts)?.summaryModel, `${path}.tts.summaryModel`, visit);
}

function visitDiscordVoiceModelReferences(
  path: string,
  voice: unknown,
  visit: ModelReferenceVisitor,
): void {
  const voiceConfig = asOptionalRecord(voice);
  if (!voiceConfig) return;
  readModelRefSetting(voiceConfig.model, `${path}.model`, visit);
  readModelRefSetting(
    asOptionalRecord(voiceConfig.tts)?.summaryModel,
    `${path}.tts.summaryModel`,
    visit,
  );
}

/**
 * Reports which of `modelIds` are still named by a non-agent model consumer,
 * together with the config paths that reference them.
 */
export function collectModelReferenceUsages(
  config: unknown,
  providerId: string,
  modelIds: readonly string[],
): ProtectedModel[] {
  const targets = new Map<string, ProtectedModel>();
  for (const modelId of modelIds) {
    const trimmed = modelId.trim();
    if (!trimmed) continue;
    const ref = toModelRef(providerId, trimmed);
    if (!targets.has(ref)) targets.set(ref, { modelId: trimmed, ref, references: [] });
  }
  if (targets.size === 0) return [];

  forEachExplicitModelReference(config, (ref, path) => {
    const usage = targets.get(ref);
    if (!usage) return;
    if (!usage.references.includes(path)) usage.references.push(path);
  });

  const usages = [...targets.values()].filter((usage) => usage.references.length > 0);
  for (const usage of usages) {
    usage.references.sort((left, right) => left.localeCompare(right));
  }
  return usages.sort((left, right) => left.modelId.localeCompare(right.modelId));
}

/**
 * Keeps referenced models in the replacement list instead of deleting them, and
 * returns the reference paths so the deletion plan can show what was protected.
 */
export function applyModelReferenceProtection({
  existing,
  merged,
  providerId,
  config,
}: {
  existing: readonly ModelDefinitionLike[];
  merged: readonly ModelDefinitionLike[];
  providerId: string;
  config: unknown;
}): { models: ModelDefinitionLike[]; protectedModels: ProtectedModel[] } {
  const mergedIds = new Set(merged.map((model) => model.id));
  const pendingIds: string[] = [];
  const seen = new Set<string>();
  for (const model of existing) {
    if (mergedIds.has(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    pendingIds.push(model.id);
  }

  const protectedModels = collectModelReferenceUsages(config, providerId, pendingIds);
  if (protectedModels.length === 0) return { models: [...merged], protectedModels };

  const protectedIds = new Set(protectedModels.map((entry) => entry.modelId));
  const models = [...merged];
  const restored = new Set<string>();
  for (const model of existing) {
    if (!protectedIds.has(model.id) || restored.has(model.id)) continue;
    restored.add(model.id);
    models.push(model);
  }

  return { models, protectedModels };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

export function buildModelsEndpoint(providerId: string, provider: ProviderLike): string {
  const api = provider.api;
  const base = normalizeBaseUrl(provider.baseUrl);

  if (api === "ollama") {
    const ollamaBase = base.replace(/\/v1$/i, "");
    return joinUrl(ollamaBase.endsWith("/api") ? ollamaBase : `${ollamaBase}/api`, "/tags");
  }

  if (api === "anthropic-messages") {
    return joinUrl(/\/v1$/i.test(base) ? base : `${base}/v1`, "/models");
  }

  const isOpenRouter =
    providerId.toLowerCase() === "openrouter" ||
    base.toLowerCase().endsWith("openrouter.ai/api/v1");
  if (isOpenRouter) {
    return joinUrl(base.endsWith("/api/v1") ? base : "https://openrouter.ai/api/v1", "/models");
  }

  return joinUrl(base.replace(/\/models$/i, ""), "/models");
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function readContextWindow(row: Record<string, unknown>): number | undefined {
  const direct =
    readNumber(row.context_window) ??
    readNumber(row.contextWindow) ??
    readNumber(row.context_length) ??
    readNumber(row.contextLength);
  if (direct !== undefined) return direct;
  if (isRecord(row.top_provider)) return readNumber(row.top_provider.context_length);
  if (isRecord(row.details)) return readNumber(row.details.context_length);
  return undefined;
}

export function mapFetchedRows(
  providerId: string,
  provider: ProviderLike,
  rows: unknown[],
): ModelDefinitionLike[] {
  const models: ModelDefinitionLike[] = [];
  const seen = new Set<string>();
  const isOllama = provider.api === "ollama";

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const rawId = isOllama ? row.name : row.id;
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    const id = rawId.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const model = createDefaultModel(
      id,
      typeof row.name === "string" && row.name.trim()
        ? row.name
        : typeof row.display_name === "string"
          ? row.display_name
          : undefined,
    );
    const contextWindow = readContextWindow(row);
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    models.push(model);
  }

  return models;
}

function extractRows(body: unknown, provider: ProviderLike): unknown[] {
  if (!isRecord(body)) return [];
  if (provider.api === "ollama") return Array.isArray(body.models) ? body.models : [];
  return Array.isArray(body.data) ? body.data : [];
}

type GuardedFetch = (params: GuardedFetchOptions) => Promise<GuardedFetchResult>;

export async function fetchProviderModels({
  providerId,
  provider,
  apiKey,
  signal,
  guardedFetch = fetchWithSsrFGuard,
}: {
  providerId: string;
  provider: ProviderLike;
  apiKey?: string;
  signal?: AbortSignal;
  guardedFetch?: GuardedFetch;
}): Promise<ModelDefinitionLike[]> {
  const endpoint = buildModelsEndpoint(providerId, provider);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    if (provider.api === "anthropic-messages") headers["x-api-key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";

  const guarded = await guardedFetch({
    url: endpoint,
    init: { method: "GET", headers },
    timeoutMs: REQUEST_TIMEOUT_MS,
    signal,
    policy: ssrfPolicyFromAllowPrivateNetwork(provider.request?.allowPrivateNetwork === true),
    auditContext: "model-fetch.models",
  });

  try {
    if (!guarded.response.ok) {
      const buffer = await readResponseWithLimit(guarded.response, 4096, { signal });
      const snippet = buffer.toString("utf8").slice(0, 500);
      throw new Error(`Model list request failed with HTTP ${guarded.response.status}: ${snippet}`);
    }
    const buffer = await readResponseWithLimit(guarded.response, RESPONSE_LIMIT_BYTES, { signal });
    let body: unknown;
    try {
      body = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new Error("Model list response was not valid JSON.");
    }
    return mapFetchedRows(providerId, provider, extractRows(body, provider));
  } finally {
    await guarded.release();
  }
}

export function getProvider(config: unknown, providerId: string): ProviderLike {
  const cfg = config as ConfigLike | undefined;
  const provider = cfg?.models?.providers?.[providerId];
  if (!provider) {
    throw new Error(
      `Provider "${providerId}" is not configured. Add it under models.providers before fetching models.`,
    );
  }
  if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) {
    throw new Error(`Provider "${providerId}" is missing a valid models.providers baseUrl.`);
  }
  return provider;
}

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

type MutableRuntimeApi = {
  runtime: {
    config: {
      current: () => unknown;
      mutateConfigFile: (params: {
        base?: "runtime" | "source";
        afterWrite: { mode: "auto" };
        mutate: (draft: unknown) => void;
      }) => Promise<{ path: string }>;
    };
    modelAuth?: {
      resolveApiKeyForProvider?: (params: {
        provider: string;
        cfg?: unknown;
      }) => Promise<{ apiKey?: string }>;
    };
  };
};

export async function resolveApiKey(
  api: OpenClawPluginApi,
  providerId: string,
  provider: ProviderLike,
  config: unknown,
): Promise<string | undefined> {
  if (provider.api === "ollama") return undefined;
  const runtime = (api as unknown as MutableRuntimeApi).runtime;
  const resolver = runtime.modelAuth?.resolveApiKeyForProvider;
  if (!resolver) return undefined;
  const auth = await resolver({ provider: providerId, cfg: config });
  return auth.apiKey;
}

export async function runModelFetch({
  api,
  toolContext,
  factoryConfig,
  fetchModels = fetchProviderModels,
  params,
  signal,
}: {
  api: OpenClawPluginApi;
  toolContext?: OpenClawPluginToolContext;
  factoryConfig?: ModelFetchConfig;
  fetchModels?: typeof fetchProviderModels;
  params: ModelFetchParams;
  signal?: AbortSignal;
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
  const protection = applyModelReferenceProtection({
    existing,
    merged: merge.models,
    providerId,
    config,
  });

  let persisted = false;
  let configPath = CONFIG_PATH;
  if (!params.dryRun) {
    const runtime = (api as unknown as MutableRuntimeApi).runtime;
    const result = await runtime.config.mutateConfigFile({
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const cfg = draft as ConfigLike;
        cfg.models ??= {};
        cfg.models.providers ??= {};
        const target = cfg.models.providers[providerId] ?? { ...provider };
        target.models = protection.models;
        cfg.models.providers[providerId] = target;
        const targetAgents = resolveProviderTargetAgents(providerId, cfg, factoryConfig);
        const syncResult = syncConfiguredModelPolicyAllow(cfg, providerId, protection.models, {
          targetAgents,
        });
        syncAgentModelEntries(cfg, providerId, protection.models, {
          targetAgents: syncResult.syncedAgents,
        });
      },
    });
    configPath = result.path;
    persisted = true;
  }

  return {
    provider: providerId,
    fetched: fetched.length,
    selected: merge.selectedIds,
    protectedModels: protection.protectedModels,
    added: merge.added,
    unchanged: merge.unchanged,
    removed: Math.max(0, merge.removed - protection.protectedModels.length),
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
}: {
  api: OpenClawPluginApi;
  toolContext: OpenClawPluginToolContext;
  factoryConfig?: ModelFetchConfig;
  fetchModels?: typeof fetchProviderModels;
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
        }),
      );
    },
  };
}

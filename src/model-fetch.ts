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
const MAX_MODEL_PAGES = 100;

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
      models?: Record<string, Record<string, unknown> | undefined>;
      modelPolicy?: {
        allow?: unknown;
      };
    };
    entries?: Record<string, AgentConfigEntryLike | undefined>;
    list?: (AgentConfigEntryLike & { id?: string })[];
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

export type AgentConfigEntryLike = {
  modelPolicy?: {
    allow?: unknown;
  };
  models?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
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

  const selectedAgents = normalizeAgentIds(options.targetAgents);
  const forcedAgentSet = selectedAgents.length > 0 ? new Set(selectedAgents) : null;
  const syncedAgents: string[] = [];
  for (const { id: agentId, entry } of listConfiguredAgentEntries(cfg)) {
    if (!entry?.modelPolicy) continue;
    const normalized = normalizeAllowList(entry.modelPolicy.allow);
    const shouldSync =
      forcedAgentSet?.has(agentId) === true ||
      hasProviderScopedRule(normalized, providerId);
    if (!shouldSync) continue;

    const result = reconcileModelRefs(entry.modelPolicy.allow, providerId, modelRefs);
    const selectedWithAllowlist =
      forcedAgentSet?.has(agentId) === true && normalized.length > 0;
    if (result.changed) {
      entry.modelPolicy = {
        ...entry.modelPolicy,
        allow: result.next,
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

  const agentEntries = new Map(
    listConfiguredAgentEntries(cfg).map(({ id, entry }) => [id, entry]),
  );
  const syncedAgents: string[] = [];
  for (const agentId of selectedAgents) {
    const entry = agentEntries.get(agentId);
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
    entry.models = modelsConfig;
    syncedAgents.push(agentId);
  }

  return { syncedAgents };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function listConfiguredAgentEntries(
  config: unknown,
): { id: string; entry: AgentConfigEntryLike }[] {
  const cfg = config as ConfigLike | undefined;
  const agents = cfg?.agents;
  if (!agents) return [];

  if (isRecord(agents.entries)) {
    const entries = Object.entries(agents.entries)
      .filter(([id, entry]) => id.trim().length > 0 && isRecord(entry))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, entry]) => ({ id, entry: entry as AgentConfigEntryLike }));
    if (entries.length > 0 || !Array.isArray(agents.list)) return entries;
  }

  if (!Array.isArray(agents.list)) return [];
  const entries: { id: string; entry: AgentConfigEntryLike }[] = [];
  for (const entry of agents.list) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    entries.push({ id, entry: entry as AgentConfigEntryLike });
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function collectModelAliases(
  config: unknown,
  agentId?: string,
): Map<string, string> {
  const aliases = new Map<string, string>();

  const addModels = (models: unknown): void => {
    if (!isRecord(models)) return;
    for (const [rawRef, value] of Object.entries(models)) {
      if (!isRecord(value) || typeof value.alias !== "string") continue;
      const alias = value.alias.trim().toLowerCase();
      const modelRef = rawRef.trim();
      if (!alias || !modelRef || modelRef.endsWith("/*")) continue;
      aliases.set(alias, modelRef);

      const provider = modelRef.split("/", 1)[0]?.trim();
      if (provider) {
        aliases.set(`${provider}/${alias}`.toLowerCase(), modelRef);
      }
    }
  };

  const cfg = config as ConfigLike | undefined;
  addModels(cfg?.agents?.defaults?.models);
  const normalizedAgentId = agentId?.trim().toLowerCase();
  if (normalizedAgentId) {
    const agent = listConfiguredAgentEntries(cfg).find(
      ({ id }) => id.toLowerCase() === normalizedAgentId,
    );
    addModels(agent?.entry.models);
  }
  return aliases;
}

function agentIdForReferencePath(
  config: unknown,
  path: string,
): string | undefined {
  const cfg = config as ConfigLike | undefined;
  const agents = cfg?.agents;
  if (!agents) return undefined;

  if (isRecord(agents.entries)) {
    const prefix = "agents.entries.";
    if (path.startsWith(prefix)) {
      return Object.keys(agents.entries)
        .filter((id) => path.startsWith(`${prefix}${id}.`))
        .sort((left, right) => right.length - left.length)[0];
    }
  }

  if (Array.isArray(agents.list)) {
    const match = /^agents\.list\[(\d+)\]\./.exec(path);
    if (!match) return undefined;
    const entry = agents.list[Number(match[1])];
    return isRecord(entry) && typeof entry.id === "string"
      ? entry.id.trim() || undefined
      : undefined;
  }
  return undefined;
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
      if (Array.isArray(tools.media.models)) {
        tools.media.models.forEach((entry, index) => {
          if (!isRecord(entry)) return;
          const provider =
            typeof entry.provider === "string" ? entry.provider.trim() : "";
          const model = typeof entry.model === "string" ? entry.model.trim() : "";
          if (provider && model) {
            visit(`${provider}/${model}`, `tools.media.models[${index}].model`);
          }
        });
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

/**
 * Rewrites the explicit model references that name `fromRef` to `toRef`.
 *
 * The reference collector only reads, so the walk is repeated here with a
 * writable setter. `forEachExplicitModelReference` reports the exact path of
 * every reference it finds, so the setter mirrors that path shape.
 */
export function rewriteModelReferences(
  draft: unknown,
  fromRef: string,
  toRef: string,
): { changed: boolean; paths: string[] } {
  if (!isRecord(draft)) return { changed: false, paths: [] };
  const source = fromRef.trim();
  const target = toRef.trim();
  if (!source || !target || source === target) return { changed: false, paths: [] };

  const changed: string[] = [];

  const writeScalar = (container: unknown, field: string, basePath: string): void => {
    if (!isRecord(container)) return;
    const current = container[field];
    if (typeof current !== "string" || current.trim() !== source) return;
    container[field] = target;
    changed.push(`${basePath}.${field}`);
  };

  const writeSetting = (container: unknown, field: string, basePath: string): void => {
    if (!isRecord(container)) return;
    const current = container[field];
    if (typeof current === "string") {
      if (current.trim() !== source) return;
      container[field] = target;
      changed.push(`${basePath}.${field}`);
      return;
    }
    if (!isRecord(current)) return;
    if (typeof current.primary === "string" && current.primary.trim() === source) {
      current.primary = target;
      changed.push(`${basePath}.${field}.primary`);
    }
    const fallbacks = current.fallbacks;
    if (!Array.isArray(fallbacks)) return;
    fallbacks.forEach((fallback, index) => {
      if (typeof fallback !== "string" || fallback.trim() !== source) return;
      fallbacks[index] = target;
      changed.push(`${basePath}.${field}.fallbacks[${index}]`);
    });
  };

  const writeProviderModel = (
    container: unknown,
    basePath: string,
  ): void => {
    if (!isRecord(container)) return;
    const provider =
      typeof container.provider === "string" ? container.provider.trim() : "";
    const model = typeof container.model === "string" ? container.model.trim() : "";
    if (!provider || !model || `${provider}/${model}` !== source) return;
    const separator = target.indexOf("/");
    if (separator <= 0 || separator === target.length - 1) return;
    container.provider = target.slice(0, separator);
    container.model = target.slice(separator + 1);
    changed.push(`${basePath}.model`);
  };

  const tools = isRecord(draft.tools) ? draft.tools : undefined;
  if (tools) {
    const exec = asOptionalRecord(tools.exec);
    const reviewer = asOptionalRecord(exec?.reviewer);
    if (isRecord(reviewer)) writeSetting(reviewer, "model", "tools.exec.reviewer");

    if (isRecord(tools.media)) {
      for (const capability of ["image", "audio", "video"] as const) {
        const media = asOptionalRecord(tools.media[capability]);
        if (!media) continue;
        writeScalar(media, "preferredModel", `tools.media.${capability}`);
      }
      if (Array.isArray(tools.media.models)) {
        tools.media.models.forEach((entry, index) => {
          if (!isRecord(entry)) return;
          writeProviderModel(entry, `tools.media.models[${index}]`);
        });
      }
    }
  }

  const agents = isRecord(draft.agents) ? draft.agents : undefined;
  const defaults = asOptionalRecord(agents?.defaults);
  if (defaults) rewriteAgentModelReferences(defaults, "agents.defaults", false, writeScalar, writeSetting);

  if (agents && isRecord(agents.entries)) {
    for (const agentId of Object.keys(agents.entries).sort((left, right) => left.localeCompare(right))) {
      const entry = agents.entries[agentId];
      if (!isRecord(entry)) continue;
      rewriteAgentModelReferences(
        entry,
        `agents.entries.${agentId}`,
        true,
        writeScalar,
        writeSetting,
      );
    }
  } else if (agents && Array.isArray(agents.list)) {
    agents.list.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      rewriteAgentModelReferences(
        entry,
        `agents.list[${index}]`,
        true,
        writeScalar,
        writeSetting,
      );
    });
  }

  const tts = asOptionalRecord(draft.tts);
  if (tts) writeSetting(tts, "summaryModel", "tts");

  const hooks = isRecord(draft.hooks) ? draft.hooks : undefined;
  if (hooks) {
    if (isRecord(hooks.gmail)) writeScalar(hooks.gmail, "model", "hooks.gmail");
    if (Array.isArray(hooks.mappings)) {
      hooks.mappings.forEach((mapping, index) => {
        if (!isRecord(mapping)) return;
        writeScalar(mapping, "model", `hooks.mappings[${index}]`);
      });
    }
  }

  const channels = isRecord(draft.channels) ? draft.channels : undefined;
  if (channels) {
    const modelByChannel = isRecord(channels.modelByChannel) ? channels.modelByChannel : undefined;
    if (modelByChannel) {
      for (const channelId of Object.keys(modelByChannel).sort((left, right) => left.localeCompare(right))) {
        const channelMap = modelByChannel[channelId];
        if (!isRecord(channelMap)) continue;
        for (const targetId of Object.keys(channelMap).sort((left, right) => left.localeCompare(right))) {
          writeSetting(channelMap, targetId, `channels.modelByChannel.${channelId}`);
        }
      }
    }

    const discord = asOptionalRecord(channels.discord);
    if (discord) {
      rewriteDiscordVoiceModelReferences(discord.voice, "channels.discord.voice", writeScalar, writeSetting);
      if (isRecord(discord.accounts)) {
        for (const accountId of Object.keys(discord.accounts).sort((left, right) => left.localeCompare(right))) {
          rewriteDiscordVoiceModelReferences(
            asOptionalRecord(discord.accounts[accountId])?.voice,
            `channels.discord.accounts.${accountId}.voice`,
            writeScalar,
            writeSetting,
          );
        }
      }
    }
  }

  return { changed: changed.length > 0, paths: changed.sort((left, right) => left.localeCompare(right)) };
}

function rewriteAgentModelReferences(
  agent: Record<string, unknown>,
  basePath: string,
  includeEntrySelectors: boolean,
  writeScalar: (container: unknown, field: string, basePath: string) => void,
  writeSetting: (container: unknown, field: string, basePath: string) => void,
): void {
  writeSetting(agent, "model", basePath);
  writeScalar(agent, "utilityModel", basePath);
  writeScalar(agent, "decisionModel", basePath);
  writeSetting(agent, "imageModel", basePath);
  writeSetting(agent, "voiceModel", basePath);
  writeSetting(agent, "pdfModel", basePath);

  const mediaModels = asOptionalRecord(agent.mediaModels);
  if (mediaModels) {
    for (const capability of ["image", "video", "music"] as const) {
      writeSetting(mediaModels, capability, `${basePath}.mediaModels`);
    }
  }

  const cyberFailover = asOptionalRecord(asOptionalRecord(agent.embeddedAgent)?.cyberFailover);
  if (cyberFailover) writeSetting(cyberFailover, "model", `${basePath}.embeddedAgent.cyberFailover`);

  writeSetting(asOptionalRecord(agent.heartbeat), "model", `${basePath}.heartbeat`);
  writeSetting(asOptionalRecord(agent.subagents), "model", `${basePath}.subagents`);

  const compaction = asOptionalRecord(agent.compaction);
  if (compaction) {
    writeSetting(compaction, "model", `${basePath}.compaction`);
    writeSetting(asOptionalRecord(compaction.memoryFlush), "model", `${basePath}.compaction.memoryFlush`);
  }

  if (!includeEntrySelectors) return;
  const exec = asOptionalRecord(asOptionalRecord(agent.tools)?.exec);
  writeSetting(asOptionalRecord(exec?.reviewer), "model", `${basePath}.tools.exec.reviewer`);
  writeSetting(asOptionalRecord(agent.tts), "summaryModel", `${basePath}.tts`);
}

function rewriteDiscordVoiceModelReferences(
  voice: unknown,
  basePath: string,
  writeScalar: (container: unknown, field: string, basePath: string) => void,
  writeSetting: (container: unknown, field: string, basePath: string) => void,
): void {
  const voiceConfig = asOptionalRecord(voice);
  if (!voiceConfig) return;
  writeSetting(voiceConfig, "model", basePath);
  writeSetting(asOptionalRecord(voiceConfig.tts), "summaryModel", `${basePath}.tts`);
}

type ModelRefPair = { fromRef: string; toRef: string };

/**
 * Moves the config entries that OpenClaw keys by model reference from one
 * spelling to another.
 *
 * `agents.*.models` carries per-model metadata such as `alias`, and
 * `modelPolicy.allow` names models by reference. A provider can hold the same
 * model under two letter-case spellings, so retiring the stale spelling has to
 * move those entries to the surviving one. Dropping them instead would throw
 * the alias away and leave the metadata attached to a model that no longer
 * exists.
 */
export function migrateModelRefEntries(
  draft: unknown,
  pairs: readonly ModelRefPair[],
  options: {
    targetAgents?: readonly string[];
    onAliasConflict?: "keep-target" | "error";
  } = {},
): { changed: boolean; paths: string[] } {
  const replacements = new Map<string, string>();
  for (const pair of pairs) {
    const from = pair.fromRef.trim();
    const to = pair.toRef.trim();
    if (!from || !to || from === to) continue;
    replacements.set(from, to);
  }
  if (replacements.size === 0) return { changed: false, paths: [] };

  const changed: string[] = [];

  const moveEntry = (container: unknown, basePath: string): void => {
    if (!isRecord(container)) return;
    for (const [from, to] of replacements) {
      if (!Object.prototype.hasOwnProperty.call(container, from)) continue;
      const moved = container[from];
      const existing = container[to];
      const movedAlias =
        isRecord(moved) && typeof moved.alias === "string"
          ? moved.alias.trim()
          : "";
      const existingAlias =
        isRecord(existing) && typeof existing.alias === "string"
          ? existing.alias.trim()
          : "";
      if (
        options.onAliasConflict === "error" &&
        movedAlias &&
        existingAlias &&
        movedAlias !== existingAlias
      ) {
        throw new Error(
          `Cannot move model entry ${from} to ${to}: both models define different aliases. Keep ${from} or choose another rewrite target.`,
        );
      }
      // The surviving spelling wins on conflict so an alias already set for it
      // is not overwritten by the stale one.
      container[to] =
        isRecord(moved) && isRecord(existing) ? { ...moved, ...existing } : (existing ?? moved);
      delete container[from];
      changed.push(`${basePath}.${to}`);
    }
  };

  const rewriteAllowList = (
    container: unknown,
    field: string,
    basePath: string,
  ): void => {
    if (!isRecord(container)) return;
    const list = container[field];
    if (!Array.isArray(list)) return;
    const next: unknown[] = [];
    const seen = new Set<string>();
    let touched = false;
    for (const item of list) {
      if (typeof item !== "string") {
        next.push(item);
        continue;
      }
      const trimmed = item.trim();
      const mapped = replacements.get(trimmed) ?? trimmed;
      if (mapped !== trimmed) touched = true;
      if (seen.has(mapped)) {
        touched = true;
        continue;
      }
      seen.add(mapped);
      next.push(mapped);
    }
    if (!touched) return;
    container[field] = next;
    changed.push(`${basePath}.${field}`);
  };

  if (!isRecord(draft) || !isRecord(draft.agents)) {
    return { changed: false, paths: [] };
  }
  const agents = draft.agents;

  const defaults = asOptionalRecord(agents.defaults);
  if (defaults) {
    moveEntry(defaults.models, "agents.defaults.models");
    rewriteAllowList(defaults.modelPolicy, "allow", "agents.defaults.modelPolicy");
  }

  const requestedAgents = (options.targetAgents ?? [])
    .map((agentId) => agentId.trim())
    .filter(Boolean);
  const agentScope = requestedAgents.length > 0 ? new Set(requestedAgents) : null;
  const migrateAgent = (entry: unknown, basePath: string): void => {
    const agent = asOptionalRecord(entry);
    if (!agent) return;
    moveEntry(agent.models, `${basePath}.models`);
    rewriteAllowList(agent.modelPolicy, "allow", `${basePath}.modelPolicy`);
  };

  if (isRecord(agents.entries)) {
    for (const agentId of Object.keys(agents.entries).sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (agentScope && !agentScope.has(agentId)) continue;
      migrateAgent(agents.entries[agentId], `agents.entries.${agentId}`);
    }
  } else if (Array.isArray(agents.list)) {
    agents.list.forEach((entry, index) => {
      const agent = asOptionalRecord(entry);
      const agentId =
        typeof agent?.id === "string" && agent.id.trim() ? agent.id.trim() : undefined;
      if (agentScope && (!agentId || !agentScope.has(agentId))) return;
      migrateAgent(agent, `agents.list[${index}]`);
    });
  }

  return {
    changed: changed.length > 0,
    paths: changed.sort((left, right) => left.localeCompare(right)),
  };
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
    const aliases = collectModelAliases(config, agentIdForReferencePath(config, path));
    const usage = targets.get(ref) ?? targets.get(aliases.get(ref.toLowerCase()) ?? "");
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

/**
 * Finds removal candidates that only differ from a surviving model by letter
 * case.
 *
 * A provider list can hold both `auto/MiniMax-M3` and `auto/minimax-m3`. The
 * filter keeps one of them and drops the other, so the two entries point at
 * the same remote model and the deletion plan can say so instead of leaving
 * the user with two look-alike ids.
 */
export function collectCaseVariantRelations(
  removedIds: readonly string[],
  survivingIds: readonly string[],
): { removedId: string; survivingModelId: string }[] {
  const byLowerId = new Map<string, string[]>();
  for (const id of survivingIds) {
    const key = id.toLowerCase();
    const bucket = byLowerId.get(key);
    if (bucket) bucket.push(id);
    else byLowerId.set(key, [id]);
  }

  const relations: { removedId: string; survivingModelId: string }[] = [];
  for (const removedId of removedIds) {
    const bucket = byLowerId.get(removedId.toLowerCase());
    if (!bucket) continue;
    const match = bucket.find((id) => id !== removedId);
    if (!match) continue;
    relations.push({ removedId, survivingModelId: match });
  }
  return relations.sort((left, right) => left.removedId.localeCompare(right.removedId));
}

/**
 * The model OpenClaw falls back to when an agent has no explicit selection.
 *
 * Agents can override the default, so the first agent that names a primary
 * model wins. The value is the bare `provider/model` reference.
 */
export function resolveDefaultModelRef(config: unknown): string | undefined {
  if (!isRecord(config)) return undefined;
  const agents = isRecord(config.agents) ? config.agents : undefined;
  if (!agents) return undefined;

  const readPrimary = (agent: unknown): string | undefined => {
    if (!isRecord(agent)) return undefined;
    const model = agent.model;
    if (typeof model === "string") {
      const trimmed = model.trim();
      return trimmed ? trimmed : undefined;
    }
    if (!isRecord(model)) return undefined;
    const primary = model.primary;
    if (typeof primary !== "string") return undefined;
    const trimmed = primary.trim();
    return trimmed ? trimmed : undefined;
  };

  const defaults = asOptionalRecord(agents.defaults);
  const defaultPrimary = readPrimary(defaults);
  const resolveAlias = (ref: string, agentId?: string): string =>
    collectModelAliases(config, agentId).get(ref.toLowerCase()) ?? ref;
  if (defaultPrimary) return resolveAlias(defaultPrimary);

  if (isRecord(agents.entries)) {
    for (const agentId of Object.keys(agents.entries).sort((left, right) =>
      left.localeCompare(right),
    )) {
      const primary = readPrimary(agents.entries[agentId]);
      if (primary) return resolveAlias(primary, agentId);
    }
  }
  if (Array.isArray(agents.list)) {
    for (const entry of agents.list) {
      const primary = readPrimary(entry);
      const agentId =
        isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
      if (primary) return resolveAlias(primary, agentId);
    }
  }
  return undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

function withQueryParam(url: string, name: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(name, value);
  return parsed.toString();
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

  return joinUrl(base.replace(/\/models$/i, ""), "/models");
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

function readContextWindow(row: Record<string, unknown>): number | undefined {
  const direct =
    readNumber(row.context_window) ??
    readNumber(row.contextWindow) ??
    readNumber(row.context_length) ??
    readNumber(row.contextLength) ??
    readNumber(row.max_context_length) ??
    readNumber(row.maxContextLength) ??
    readNumber(row.max_model_len) ??
    readNumber(row.context_size);
  if (direct !== undefined) return direct;
  if (isRecord(row.top_provider)) return readNumber(row.top_provider.context_length);
  if (isRecord(row.details)) return readNumber(row.details.context_length);
  return undefined;
}

function readMaxTokens(row: Record<string, unknown>): number | undefined {
  const direct =
    readNumber(row.max_completion_tokens) ??
    readNumber(row.max_output_tokens) ??
    readNumber(row.maxTokens) ??
    readNumber(row.max_tokens);
  if (direct !== undefined) return direct;
  if (isRecord(row.top_provider)) {
    return readNumber(row.top_provider.max_completion_tokens);
  }
  return undefined;
}

function readInputModalities(row: Record<string, unknown>): ("text" | "image")[] {
  const architecture = asOptionalRecord(row.architecture);
  const modalities = asOptionalRecord(row.modalities);
  const values = new Set<string>([
    ...readStringList(row.input),
    ...readStringList(architecture?.input_modalities),
    ...readStringList(architecture?.inputModalities),
    ...readStringList(modalities?.input),
  ]);
  const capabilities = readStringList(row.capabilities);
  const input: ("text" | "image")[] = ["text"];
  if (
    row.supports_vision === true ||
    values.has("image") ||
    values.has("vision") ||
    capabilities.includes("vision") ||
    capabilities.includes("image")
  ) {
    input.push("image");
  }
  return input;
}

function readReasoningSupport(row: Record<string, unknown>): boolean {
  if (typeof row.reasoning === "boolean") return row.reasoning;
  const supported = readStringList(row.supported_parameters);
  const capabilities = readStringList(row.capabilities);
  return (
    supported.includes("reasoning") ||
    supported.includes("include_reasoning") ||
    capabilities.includes("reasoning") ||
    capabilities.includes("thinking")
  );
}

function readCostFields(
  pricing: Record<string, unknown>,
  scale: number,
): ModelDefinitionLike["cost"] | undefined {
  const input =
    readNonNegativeNumber(pricing.input) ??
    readNonNegativeNumber(pricing.prompt);
  const output =
    readNonNegativeNumber(pricing.output) ??
    readNonNegativeNumber(pricing.completion);
  const cacheRead =
    readNonNegativeNumber(pricing.cacheRead) ??
    readNonNegativeNumber(pricing.cache_read) ??
    readNonNegativeNumber(pricing.input_cache_read);
  const cacheWrite =
    readNonNegativeNumber(pricing.cacheWrite) ??
    readNonNegativeNumber(pricing.cache_write) ??
    readNonNegativeNumber(pricing.input_cache_write);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    input: (input ?? 0) * scale,
    output: (output ?? 0) * scale,
    cacheRead: (cacheRead ?? 0) * scale,
    cacheWrite: (cacheWrite ?? 0) * scale,
  };
}

function readCost(row: Record<string, unknown>): ModelDefinitionLike["cost"] | undefined {
  // OpenClaw model costs are USD per million tokens. OpenRouter-shaped model
  // feeds publish per-token rates under `pricing`; `cost` is already normalized.
  const normalized = asOptionalRecord(row.cost);
  if (normalized) return readCostFields(normalized, 1);
  const pricing = asOptionalRecord(row.pricing);
  return pricing ? readCostFields(pricing, 1_000_000) : undefined;
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
    const rawId = isOllama
      ? (readString(row.name) ?? readString(row.model) ?? row.id)
      : (readString(row.id) ?? readString(row.model) ?? readString(row.name));
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    const id = rawId.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const displayName =
      readString(row.display_name) ??
      readString(row.displayName) ??
      (!isOllama && readString(row.name) !== id ? readString(row.name) : undefined);
    const model = createDefaultModel(
      id,
      displayName,
    );
    const contextWindow = readContextWindow(row);
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    const maxTokens = readMaxTokens(row);
    if (maxTokens !== undefined) model.maxTokens = maxTokens;
    model.reasoning = readReasoningSupport(row);
    model.input = readInputModalities(row);
    const cost = readCost(row);
    if (cost) model.cost = cost;
    models.push(model);
  }

  return models;
}

type ExtractedModelPage = {
  rows: unknown[];
  nextCursor?: string;
};

function extractModelPage(body: unknown, provider: ProviderLike): ExtractedModelPage {
  if (Array.isArray(body)) return { rows: body };
  if (!isRecord(body)) {
    throw new Error("Model list response was not a JSON object or array.");
  }

  const rows =
    provider.api === "ollama" && Array.isArray(body.models)
      ? body.models
      : Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.models)
          ? body.models
          : Array.isArray(body.results)
            ? body.results
            : undefined;
  if (!rows) {
    throw new Error(
      "Model list response did not contain a supported models array (data, models, or results).",
    );
  }

  if (provider.api === "ollama" || body.has_more !== true) {
    return { rows };
  }

  const pageRows = rows.filter(isRecord);
  const lastRow = pageRows.at(-1);
  const nextCursor =
    readString(body.last_id) ??
    readString(body.next_cursor) ??
    readString(body.nextCursor) ??
    (lastRow
      ? (readString(lastRow.id) ?? readString(lastRow.name) ?? readString(lastRow.model))
      : undefined);
  if (nextCursor === undefined) {
    throw new Error("Model list response reported more pages but did not include a cursor.");
  }
  return { rows, nextCursor };
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
  let endpoint = buildModelsEndpoint(providerId, provider);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    if (provider.api === "anthropic-messages") headers["x-api-key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";

  const rows: unknown[] = [];
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
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
        throw new Error(
          `Model list request failed with HTTP ${guarded.response.status}: ${snippet}`,
        );
      }
      const buffer = await readResponseWithLimit(guarded.response, RESPONSE_LIMIT_BYTES, {
        signal,
      });
      let body: unknown;
      try {
        body = JSON.parse(buffer.toString("utf8"));
      } catch {
        throw new Error("Model list response was not valid JSON.");
      }
      const extracted = extractModelPage(body, provider);
      rows.push(...extracted.rows);
      if (extracted.nextCursor === undefined) {
        return mapFetchedRows(providerId, provider, rows);
      }
      if (seenCursors.has(extracted.nextCursor)) {
        throw new Error(
          `Model list pagination repeated cursor "${extracted.nextCursor}".`,
        );
      }
      seenCursors.add(extracted.nextCursor);
      endpoint = withQueryParam(endpoint, "after_id", extracted.nextCursor);
    } finally {
      await guarded.release();
    }
  }

  throw new Error(`Model list exceeded the ${MAX_MODEL_PAGES}-page safety limit.`);
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
  let protection = applyModelReferenceProtection({
    existing,
    merged: merge.models,
    providerId,
    config,
  });

  let persisted = false;
  let configPath = CONFIG_PATH;
  let removed = Math.max(0, merge.removed - protection.protectedModels.length);
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
        const latestExisting = target.models ?? [];
        protection = applyModelReferenceProtection({
          existing: latestExisting,
          merged: merge.models,
          providerId,
          config: cfg,
        });
        const finalIds = new Set(protection.models.map((model) => model.id));
        removed = latestExisting.filter((model) => !finalIds.has(model.id)).length;
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
    removed,
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

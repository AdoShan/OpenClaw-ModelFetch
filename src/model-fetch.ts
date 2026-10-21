import { Type, type Static, type TSchema } from "typebox";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/media-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

export const MODEL_FETCH_TOOL_NAME = "model_fetch";
const CONFIG_PATH = "models.providers.<providerId>.models";
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type ModelFilterConfig = {
  includeRegex?: string;
  excludeRegex?: string;
  manualIds?: string[];
  replace?: boolean;
};

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
  baseUrl: string;
  api?: string;
  request?: {
    allowPrivateNetwork?: boolean;
  };
  models?: ModelDefinitionLike[];
};

type ConfigLike = {
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

type GuardedFetchOptions = Parameters<typeof fetchWithSsrFGuard>[0];
type GuardedFetchResult = Awaited<ReturnType<typeof fetchWithSsrFGuard>>;

export type ModelFetchParams = {
  provider: string;
  includeRegex?: string;
  excludeRegex?: string;
  manualIds?: string[];
  replace?: boolean;
  dryRun?: boolean;
};

export const modelFetchParameters = Type.Object(
  {
    provider: Type.String({
      description:
        "Provider id from models.providers. Only this provider's configured filter is used.",
    }),
    includeRegex: Type.Optional(
      Type.String({
        description:
          "Temporary include regex. When omitted, the provider's persisted includeRegex is used.",
      }),
    ),
    excludeRegex: Type.Optional(
      Type.String({
        description:
          "Temporary exclude regex. Manual IDs are never excluded. When omitted, the provider's persisted excludeRegex is used.",
      }),
    ),
    manualIds: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Temporary exact model IDs to select. Without includeRegex, only these IDs are selected; with includeRegex, they bypass include/exclude.",
      }),
    ),
    replace: Type.Optional(
      Type.Boolean({
        description:
          "Remove existing models absent from the selected fetched set. Defaults to the provider's persisted strategy.",
      }),
    ),
    dryRun: Type.Optional(
      Type.Boolean({
        description: "Compute and return the planned model list without writing configuration.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const modelFetchFilterSchema = Type.Object(
  {
    includeRegex: Type.Optional(Type.String()),
    excludeRegex: Type.Optional(Type.String()),
    manualIds: Type.Optional(Type.Array(Type.String())),
    replace: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const modelFetchConfigSchema = Type.Object(
  {
    providers: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            filter: Type.Optional(modelFetchFilterSchema),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export type ModelFetchConfig = Static<typeof modelFetchConfigSchema>;

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
    replace: temporary.replace ?? persisted.replace ?? false,
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

function getProvider(config: unknown, providerId: string): ProviderLike {
  const cfg = config as ConfigLike | undefined;
  const provider = cfg?.models?.providers?.[providerId];
  if (!provider) {
    throw new Error(
      `Provider "${providerId}" is not configured. Add it under models.providers before fetching models.`,
    );
  }
  return provider;
}

function currentConfig(api: OpenClawPluginApi, toolContext: OpenClawPluginToolContext): unknown {
  return (
    toolContext.getRuntimeConfig?.() ??
    toolContext.runtimeConfig ??
    toolContext.config ??
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

async function resolveApiKey(
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

export type ModelFetchToolResult = {
  provider: string;
  fetched: number;
  selected: string[];
  added: number;
  unchanged: number;
  removed: number;
  replace: boolean;
  dryRun: boolean;
  configPath: string;
  persisted: boolean;
};

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
      const merge = mergeModels({
        existing: provider.models ?? [],
        selected,
        filter: effectiveFilter,
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
            target.models = merge.models;
            cfg.models.providers[providerId] = target;
          },
        });
        configPath = result.path;
        persisted = true;
      }

      const payload: ModelFetchToolResult = {
        provider: providerId,
        fetched: fetched.length,
        selected: merge.selectedIds,
        added: merge.added,
        unchanged: merge.unchanged,
        removed: merge.removed,
        replace: effectiveFilter.replace === true,
        dryRun: params.dryRun === true,
        configPath,
        persisted,
      };
      return jsonResult(payload);
    },
  };
}

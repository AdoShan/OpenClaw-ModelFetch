import { describe, expect, it, vi } from "vitest";
import type {
  OpenClawPluginApi,
  PluginSessionActionRegistration,
} from "openclaw/plugin-sdk/core";
import {
  createModelFetchOperations,
  registerModelFetchOperations,
} from "./operations.js";
import type {
  ModelDefinitionLike,
  ProviderLike,
} from "./model-fetch.js";

function model(id: string, name = id): ModelDefinitionLike {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function createApi(initialConfig: Record<string, unknown>) {
  let config = initialConfig;
  const mutateConfigFile = vi.fn(
    async ({
      mutate,
    }: {
      mutate: (draft: unknown) => void;
    }) => {
      const draft = structuredClone(config);
      mutate(draft);
      config = draft;
      return { path: "/tmp/openclaw.json" };
    },
  );
  const registerSessionAction = vi.fn();
  const api = {
    id: "model-fetch",
    config,
    pluginConfig: {},
    runtime: {
      config: {
        current: () => config,
        mutateConfigFile,
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "secret-key" })),
      },
    },
    session: {
      controls: {
        registerSessionAction,
      },
    },
  } as unknown as OpenClawPluginApi;

  return {
    api,
    mutateConfigFile,
    registerSessionAction,
    getConfig: () => config as {
      agents?: {
        defaults?: {
          models?: Record<string, Record<string, unknown>>;
          modelPolicy?: { allow?: string[] };
          model?: { primary?: string; fallbacks?: string[] };
          utilityModel?: string;
        };
        entries?: Record<
          string,
          {
            modelPolicy?: { allow?: string[] };
            models?: Record<string, Record<string, unknown>>;
            model?: { primary?: string; fallbacks?: string[] };
            utilityModel?: string;
          }
        >;
        list?: {
          id?: string;
          modelPolicy?: { allow?: string[] };
          models?: Record<string, Record<string, unknown>>;
          model?: { primary?: string; fallbacks?: string[] };
          utilityModel?: string;
        }[];
      };
      models?: { providers?: Record<string, ProviderLike & { models?: ModelDefinitionLike[] }> };
      plugins?: { entries?: Record<string, { config?: unknown }> };
    },
  };
}

function baseConfig(
  providers: Record<string, ProviderLike & { models?: ModelDefinitionLike[] }>,
  filters: Record<string, unknown> = {},
) {
  return {
    models: { providers },
    plugins: {
      entries: {
        "model-fetch": {
          config: {
            providers: filters,
          },
        },
      },
    },
  };
}

type FakeSessionEntry = {
  sessionKey: string;
  agentId: string;
  entry: Record<string, unknown>;
};

function createSessionStore(
  entries: FakeSessionEntry[],
  options: { failingSessionKeys?: readonly string[] } = {},
) {
  const byKey = new Map(entries.map((item) => [item.sessionKey, item]));
  const failing = new Set(options.failingSessionKeys ?? []);

  const listSessionEntries = vi.fn(
    ({ agentId }: { agentId?: string }) =>
      entries
        .filter(
          (item) =>
            item.agentId.toLowerCase() === (agentId ?? "").toLowerCase(),
        )
        .map((item) => ({ sessionKey: item.sessionKey, entry: item.entry })),
  );
  const getSessionEntryAsync = vi.fn(
    async ({ sessionKey }: { sessionKey: string }) =>
      byKey.get(sessionKey)?.entry,
  );
  const patchSessionEntry = vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
    if (failing.has(sessionKey)) throw new Error(`patch failed: ${sessionKey}`);
    return {};
  });

  return { listSessionEntries, getSessionEntryAsync, patchSessionEntry };
}

describe("Control UI operations", () => {
  it("lists every provider with its own normalized strategy", async () => {
    const { api } = createApi(
      {
        agents: {
          entries: {
            main: {
              modelPolicy: { allow: ["openrouter/openai/gpt-4o"] },
            },
          },
        },
        ...baseConfig(
          {
            openrouter: {
              name: "OpenRouter",
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-responses",
              models: [model("openai/gpt-4o")],
            },
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: [],
            },
          },
          {
            openrouter: {
              filter: { includeRegex: "openai/", replace: false },
              targetAgents: ["main"],
            },
            ollama: {
              filter: { manualIds: ["qwen3:latest"] },
            },
          },
        ),
      },
    );
    const operations = createModelFetchOperations({ api });
    const output = await operations.listProviders();

    expect(output.providers.map((provider) => provider.id)).toEqual([
      "ollama",
      "openrouter",
    ]);
    expect(output.providers.find((provider) => provider.id === "openrouter")?.filter).toEqual({
      includeRegex: "openai/",
      manualIds: [],
      replace: true,
    });
    expect(
      output.providers.find((provider) => provider.id === "ollama")?.filter.manualIds,
    ).toEqual(["qwen3:latest"]);
    expect(output.providers.find((provider) => provider.id === "openrouter")?.targetAgents).toEqual([
      "main",
    ]);
    expect(output.agents).toEqual([{ id: "main", hasModelAllowlist: true }]);
  });

  it("lists agents from the runtime list projection", async () => {
    const { api } = createApi({
      agents: {
        entries: {},
        list: [
          {
            id: "worker",
            modelPolicy: { allow: ["openrouter/openai/gpt-4o"] },
          },
          {
            id: "main",
          },
        ],
      },
      ...baseConfig({}),
    });
    const operations = createModelFetchOperations({ api });

    const output = await operations.listProviders();

    expect(output.agents).toEqual([
      { id: "main", hasModelAllowlist: false },
      { id: "worker", hasModelAllowlist: true },
    ]);
  });

  it("fetches remote models without changing configuration", async () => {
    const config = baseConfig({
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-responses",
        models: [model("configured/model")],
      },
    });
    const { api, mutateConfigFile } = createApi(config);
    const fetchModels = vi.fn(async () => [
      model("openai/gpt-4o", "GPT-4o"),
      model("anthropic/claude", "Claude"),
    ]);
    const operations = createModelFetchOperations({ api, fetchModels });

    const output = await operations.fetchModels("openrouter");

    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openrouter",
        apiKey: "secret-key",
      }),
    );
    expect(output.models.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "anthropic/claude",
    ]);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("saves only the selected provider strategy and forces replacement", async () => {
    const { api, getConfig } = createApi(
      baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [],
          },
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
        {
          ollama: { filter: { manualIds: ["qwen3:latest"] } },
        },
      ),
    );
    const operations = createModelFetchOperations({ api });

    await operations.saveStrategy({
      provider: "openrouter",
      filter: {
        includeRegex: "^(openai|anthropic)/",
        excludeRegex: "embed",
        manualIds: ["openai/gpt-4o-mini", "openai/gpt-4o-mini"],
        replace: false,
      },
      targetAgents: ["main"],
    });

    const pluginFilters = (
      getConfig().plugins?.entries?.["model-fetch"]?.config as {
        providers: Record<string, { filter: unknown }>;
      }
    ).providers;
    expect(pluginFilters.openrouter.filter).toEqual({
      includeRegex: "^(openai|anthropic)/",
      excludeRegex: "embed",
      manualIds: ["openai/gpt-4o-mini"],
      replace: true,
    });
    expect(pluginFilters.openrouter.targetAgents).toEqual(["main"]);
    expect(pluginFilters.ollama).toEqual({
      filter: { manualIds: ["qwen3:latest"] },
    });
  });

  it("rejects an invalid regex before saving", async () => {
    const { api, mutateConfigFile } = createApi(
      baseConfig({
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-responses",
          models: [],
        },
      }),
    );
    const operations = createModelFetchOperations({ api });

    await expect(
      operations.saveStrategy({
        provider: "openrouter",
        filter: { includeRegex: "(" },
      }),
    ).rejects.toThrow(/Invalid includeRegex regex/);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("retries a config write that loses the race against another writer", async () => {
    const { api, mutateConfigFile, getConfig } = createApi(
      baseConfig({
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-responses",
          models: [],
        },
      }),
    );
    const conflict = Object.assign(new Error("config changed since last load"), {
      name: "ConfigMutationConflictError",
      retryable: true,
    });
    mutateConfigFile.mockImplementationOnce(async () => {
      throw conflict;
    });
    const operations = createModelFetchOperations({ api });

    await operations.saveStrategy({
      provider: "openrouter",
      filter: { includeRegex: "^(openai|anthropic)/" },
    });

    expect(mutateConfigFile).toHaveBeenCalledTimes(2);
    const pluginFilters = (
      getConfig().plugins?.entries?.["model-fetch"]?.config as {
        providers: Record<string, { filter: unknown }>;
      }
    ).providers;
    expect(pluginFilters.openrouter.filter).toMatchObject({
      includeRegex: "^(openai|anthropic)/",
    });
  });

  it("does not retry a config write that failed for another reason", async () => {
    const { api, mutateConfigFile } = createApi(
      baseConfig({
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-responses",
          models: [],
        },
      }),
    );
    mutateConfigFile.mockImplementationOnce(async () => {
      throw new Error("config file is read only");
    });
    const operations = createModelFetchOperations({ api });

    await expect(
      operations.saveStrategy({
        provider: "openrouter",
        filter: { includeRegex: "^(openai|anthropic)/" },
      }),
    ).rejects.toThrow(/config file is read only/);
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
  });

  it("previews and applies the exact replacement after re-fetching", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const { api, getConfig } = createApi(
      baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        {
          openrouter: {
            filter: { includeRegex: "^openai/", manualIds: [] },
          },
        },
      ),
    );
    const fetchModels = vi.fn(async () => [
      kept,
      model("openai/o3-mini", "o3-mini"),
    ]);
    const operations = createModelFetchOperations({ api, fetchModels });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.removedIds).toEqual(["stale/model"]);
    expect(preview.plan.addedIds).toEqual(["openai/o3-mini"]);
    expect(
      Object.prototype.hasOwnProperty.call(preview.plan, "defaultModelRef"),
    ).toBe(false);
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "stale/model",
    ]);

    const applied = await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: ["stale/model"],
    });

    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(applied).toMatchObject({
      persisted: true,
      added: 1,
      removed: 1,
      selectedIds: ["openai/gpt-4o", "openai/o3-mini"],
    });
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "openai/o3-mini",
    ]);
  });

  it("does not treat runtime-filled Provider defaults as configuration drift", async () => {
    const stale = {
      id: "stale/model",
      name: "stale/model",
      contextWindow: 32_768,
    } as ModelDefinitionLike;
    const kept = {
      id: "openai/gpt-4o",
      name: "openai/gpt-4o",
    } as ModelDefinitionLike;
    const { api, getConfig } = createApi(
      baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        {
          openrouter: {
            filter: { includeRegex: "^openai/" },
          },
        },
      ),
    );
    const currentConfig = (api.runtime.config as unknown as {
      current: () => unknown;
    }).current;
    (api.runtime.config as unknown as { current: () => unknown }).current = () => {
      const config = structuredClone(currentConfig()) as {
        models?: {
          providers?: Record<
            string,
            ProviderLike & { models?: ModelDefinitionLike[] }
          >;
        };
      };
      for (const provider of Object.values(config.models?.providers ?? {})) {
        provider.models = (provider.models ?? []).map((entry) => ({
          ...entry,
          reasoning: entry.reasoning ?? false,
          input: entry.input ?? ["text"],
          cost: entry.cost ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextTokens: entry.contextTokens,
          maxTokens: entry.maxTokens ?? 8_192,
          api: entry.api ?? provider.api,
          provider: "openrouter",
          compat: {},
        }));
      }
      return config;
    };
    const fetchModels = vi.fn(async () => [
      model("openai/gpt-4o"),
      model("openai/o3-mini"),
    ]);
    const operations = createModelFetchOperations({ api, fetchModels });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.removedIds).toEqual(["stale/model"]);

    await expect(
      operations.applyStrategy({
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: preview.plan.removedIds,
      }),
    ).resolves.toMatchObject({
      persisted: true,
      added: 1,
      removed: 1,
    });
    expect(
      getConfig().models?.providers?.openrouter.models?.map((row) => row.id),
    ).toEqual(["openai/gpt-4o", "openai/o3-mini"]);
  });

  it("does not rewrite the saved plugin strategy while applying models", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const config = baseConfig(
      {
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-responses",
          models: [kept, stale],
        },
      },
      {
        openrouter: {
          filter: { includeRegex: "^openai/" },
          targetAgents: ["main"],
        },
      },
    );
    const { api, getConfig } = createApi(config);
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [kept]),
    });

    const preview = await operations.previewApply("openrouter");
    await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: preview.plan.removedIds,
      targetAgents: ["worker"],
    });

    expect(
      getConfig().plugins?.entries?.["model-fetch"]?.config,
    ).toEqual({
      providers: {
        openrouter: {
          filter: { includeRegex: "^openai/" },
          targetAgents: ["main"],
        },
      },
    });
  });

  it("resets the current session selection when its model is removed", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const { api, getConfig } = createApi(
      baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        {
          openrouter: {
            filter: { includeRegex: "^openai/" },
          },
        },
      ),
    );
    const fetchModels = vi.fn(async () => [kept]);
    const { listSessionEntries, getSessionEntryAsync, patchSessionEntry } =
      createSessionStore([
        {
          sessionKey: "agent:main:dashboard:test",
          agentId: "main",
          entry: {
            providerOverride: "openrouter",
            modelOverride: "stale/model",
            modelProvider: "openrouter",
            model: "stale/model",
            modelSelectionLocked: false,
          },
        },
      ]);
    const operations = createModelFetchOperations({
      api,
      fetchModels,
      sessionStore: {
        listSessionEntries,
        getSessionEntryAsync,
        patchSessionEntry,
      },
    });
    const preview = await operations.previewApply("openrouter");

    const applied = await operations.applyStrategy(
      {
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: ["stale/model"],
      },
      { sessionKey: "agent:main:dashboard:test", agentId: "main" },
    );

    expect(applied.sessionSelectionResets).toBe(1);
    expect(applied.resetSessionKeys).toEqual(["agent:main:dashboard:test"]);
    expect(getSessionEntryAsync).toHaveBeenCalledWith({
      sessionKey: "agent:main:dashboard:test",
      agentId: "main",
    });
    expect(patchSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:test",
        agentId: "main",
        preserveActivity: true,
      }),
    );
    const patch = patchSessionEntry.mock.calls[0][0] as {
      update: () => Record<string, unknown>;
    };
    expect(patch.update()).toEqual({
      providerOverride: undefined,
      modelOverride: undefined,
      modelOverrideSource: undefined,
      modelOverrideRouteResolution: undefined,
      modelOverrideFallbackOriginProvider: undefined,
      modelOverrideFallbackOriginModel: undefined,
      model: undefined,
      modelProvider: undefined,
      contextTokens: undefined,
      contextTokensSource: undefined,
      contextBudgetStatus: undefined,
    });
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
    ]);
  });

  it("resets a session that persisted only the runtime model", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const { api } = createApi(
      baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        { openrouter: { filter: { includeRegex: "^openai/" } } },
      ),
    );
    const { listSessionEntries, getSessionEntryAsync, patchSessionEntry } =
      createSessionStore([
        {
          sessionKey: "agent:main:runtime-only",
          agentId: "main",
          entry: {
            modelProvider: "openrouter",
            model: "stale/model",
            modelSelectionLocked: false,
          },
        },
      ]);
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [kept]),
      sessionStore: {
        listSessionEntries,
        getSessionEntryAsync,
        patchSessionEntry,
      },
    });
    const preview = await operations.previewApply("openrouter");

    const applied = await operations.applyStrategy(
      {
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: ["stale/model"],
      },
      { sessionKey: "agent:main:runtime-only", agentId: "main" },
    );

    expect(applied.sessionSelectionResets).toBe(1);
    expect(applied.resetSessionKeys).toEqual(["agent:main:runtime-only"]);
    const patch = patchSessionEntry.mock.calls[0][0] as {
      update: () => Record<string, unknown>;
    };
    expect(patch.update()).toMatchObject({
      model: undefined,
      modelProvider: undefined,
      contextTokens: undefined,
      contextTokensSource: undefined,
      contextBudgetStatus: undefined,
    });
  });

  it("leaves locked sessions untouched", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const { api } = createApi(
      baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        { openrouter: { filter: { includeRegex: "^openai/" } } },
      ),
    );
    const { listSessionEntries, getSessionEntryAsync, patchSessionEntry } =
      createSessionStore([
        {
          sessionKey: "agent:main:locked",
          agentId: "main",
          entry: {
            providerOverride: "openrouter",
            modelOverride: "stale/model",
            modelSelectionLocked: true,
          },
        },
      ]);
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [kept]),
      sessionStore: {
        listSessionEntries,
        getSessionEntryAsync,
        patchSessionEntry,
      },
    });
    const preview = await operations.previewApply("openrouter");

    const applied = await operations.applyStrategy(
      {
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: ["stale/model"],
      },
      { sessionKey: "agent:main:locked", agentId: "main" },
    );

    expect(applied.sessionSelectionResets).toBe(0);
    expect(applied.resetSessionKeys).toEqual([]);
    expect(patchSessionEntry).not.toHaveBeenCalled();
  });

  it("clears stale selections across every agent and session", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const { api } = createApi({
      agents: { entries: { main: {}, scout: {} } },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        { openrouter: { filter: { includeRegex: "^openai/" } } },
      ),
    });
    const fetchModels = vi.fn(async () => [kept]);
    const sessionStore = createSessionStore([
      {
        sessionKey: "agent:main:dashboard:a",
        agentId: "main",
        entry: {
          providerOverride: "openrouter",
          modelOverride: "stale/model",
          label: "Main A",
        },
      },
      {
        sessionKey: "agent:main:dashboard:b",
        agentId: "main",
        entry: { modelProvider: "openrouter", model: "stale/model" },
      },
      {
        sessionKey: "agent:scout:dashboard:c",
        agentId: "scout",
        entry: { modelOverride: "openrouter/stale/model" },
      },
      {
        sessionKey: "agent:scout:dashboard:d",
        agentId: "scout",
        entry: {
          providerOverride: "openrouter",
          modelOverride: "stale/model",
          modelSelectionLocked: true,
        },
      },
    ]);
    const operations = createModelFetchOperations({
      api,
      fetchModels,
      sessionStore,
    });

    const preview = await operations.previewApply("openrouter");

    expect(preview.plan.affectedSessions).toEqual([
      {
        sessionKey: "agent:main:dashboard:a",
        agentId: "main",
        label: "Main A",
      },
      {
        sessionKey: "agent:main:dashboard:b",
        agentId: "main",
        label: "agent:main:dashboard:b",
      },
      {
        sessionKey: "agent:scout:dashboard:c",
        agentId: "scout",
        label: "agent:scout:dashboard:c",
      },
    ]);
    expect(sessionStore.listSessionEntries).toHaveBeenCalledWith({
      agentId: "main",
      readOnly: true,
    });
    expect(sessionStore.listSessionEntries).toHaveBeenCalledWith({
      agentId: "scout",
      readOnly: true,
    });

    const applied = await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: ["stale/model"],
    });

    expect(applied.sessionSelectionResets).toBe(3);
    expect(applied.resetSessionKeys).toEqual([
      "agent:main:dashboard:a",
      "agent:main:dashboard:b",
      "agent:scout:dashboard:c",
    ]);
    expect(sessionStore.patchSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:scout:dashboard:c",
        agentId: "scout",
        preserveActivity: true,
      }),
    );
    expect(sessionStore.patchSessionEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:scout:dashboard:d" }),
    );
  });

  it("only clears the override fields when only the full model id was stored", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const { api } = createApi({
      agents: { entries: { main: {} } },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        { openrouter: { filter: { includeRegex: "^openai/" } } },
      ),
    });
    const sessionStore = createSessionStore([
      {
        sessionKey: "agent:main:dashboard:full-id",
        agentId: "main",
        entry: { modelOverride: "openrouter/stale/model" },
      },
    ]);
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [kept]),
      sessionStore,
    });
    const preview = await operations.previewApply("openrouter");

    expect(preview.plan.affectedSessions).toEqual([
      {
        sessionKey: "agent:main:dashboard:full-id",
        agentId: "main",
        label: "agent:main:dashboard:full-id",
      },
    ]);

    const applied = await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: ["stale/model"],
    });

    expect(applied.sessionSelectionResets).toBe(1);
    const patch = sessionStore.patchSessionEntry.mock.calls[0][0] as {
      update: () => Record<string, unknown>;
    };
    expect(patch.update()).toEqual({
      providerOverride: undefined,
      modelOverride: undefined,
      modelOverrideSource: undefined,
      modelOverrideRouteResolution: undefined,
      modelOverrideFallbackOriginProvider: undefined,
      modelOverrideFallbackOriginModel: undefined,
    });
  });

  it("re-checks the model lock before patching a session", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const { api } = createApi({
      agents: { entries: { main: {} } },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        { openrouter: { filter: { includeRegex: "^openai/" } } },
      ),
    });
    const listSessionEntries = vi.fn(() => [
      {
        sessionKey: "agent:main:dashboard:race",
        entry: {
          providerOverride: "openrouter",
          modelOverride: "stale/model",
          modelSelectionLocked: false,
        },
      },
    ]);
    const getSessionEntryAsync = vi.fn(async () => ({
      providerOverride: "openrouter",
      modelOverride: "stale/model",
      modelSelectionLocked: true,
    }));
    const patchSessionEntry = vi.fn(async () => ({}));
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [kept]),
      sessionStore: {
        listSessionEntries,
        getSessionEntryAsync,
        patchSessionEntry,
      },
    });
    const preview = await operations.previewApply("openrouter");

    expect(preview.plan.affectedSessions).toHaveLength(1);

    const applied = await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: ["stale/model"],
    });

    expect(applied.sessionSelectionResets).toBe(0);
    expect(applied.resetSessionKeys).toEqual([]);
    expect(patchSessionEntry).not.toHaveBeenCalled();
  });

  it("counts only the sessions that were reset successfully", async () => {
    const stale = model("stale/model");
    const kept = model("openai/gpt-4o");
    const { api } = createApi({
      agents: { entries: { main: {} } },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [kept, stale],
          },
        },
        { openrouter: { filter: { includeRegex: "^openai/" } } },
      ),
    });
    const sessionStore = createSessionStore(
      [
        {
          sessionKey: "agent:main:dashboard:ok",
          agentId: "main",
          entry: {
            providerOverride: "openrouter",
            modelOverride: "stale/model",
          },
        },
        {
          sessionKey: "agent:main:dashboard:broken",
          agentId: "main",
          entry: {
            providerOverride: "openrouter",
            modelOverride: "stale/model",
          },
        },
      ],
      { failingSessionKeys: ["agent:main:dashboard:broken"] },
    );
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [kept]),
      sessionStore,
    });
    const preview = await operations.previewApply("openrouter");

    expect(preview.plan.affectedSessions).toHaveLength(2);

    const applied = await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: ["stale/model"],
    });

    expect(applied.sessionSelectionResets).toBe(1);
    expect(applied.resetSessionKeys).toEqual(["agent:main:dashboard:ok"]);
    expect(sessionStore.patchSessionEntry).toHaveBeenCalledTimes(2);
  });

  it("adds applied models to modelPolicy.allow when allowlist is configured", async () => {
    const { api, getConfig } = createApi(
      {
        agents: {
          defaults: {
            modelPolicy: {
              allow: ["openai/gpt-6-astra"],
            },
          },
        },
        ...baseConfig(
          {
            "minimax-portal": {
              baseUrl: "https://api.minimax.chat/v1",
              api: "openai-responses",
              models: [model("MiniMax-M3")],
            },
          },
          {
            "minimax-portal": {
              filter: { manualIds: ["MiniMax-M3", "MiniMax-M3.1-Flash"] },
            },
          },
        ),
      },
    );
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("MiniMax-M3"), model("MiniMax-M3.1-Flash")]),
    });

    const preview = await operations.previewApply("minimax-portal");
    await operations.applyStrategy({
      provider: "minimax-portal",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: [],
    });

    expect(getConfig().agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/gpt-6-astra",
      "minimax-portal/MiniMax-M3",
      "minimax-portal/MiniMax-M3.1-Flash",
    ]);
  });

  it("adds applied models to agent modelPolicy.allow for matching provider rules", async () => {
    const { api, getConfig } = createApi(
      {
        agents: {
          entries: {
            main: {
              modelPolicy: {
                allow: ["openrouter/openai/gpt-oss-120b:free", "minimax-portal/MiniMax-M3"],
              },
            },
          },
        },
        ...baseConfig(
          {
            "minimax-portal": {
              baseUrl: "https://api.minimax.chat/v1",
              api: "openai-responses",
              models: [model("MiniMax-M3")],
            },
          },
          {
            "minimax-portal": {
              filter: { manualIds: ["MiniMax-M3", "MiniMax-M3.1-Flash"] },
            },
          },
        ),
      },
    );

    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("MiniMax-M3"), model("MiniMax-M3.1-Flash")]),
    });

    const preview = await operations.previewApply("minimax-portal");
    await operations.applyStrategy({
      provider: "minimax-portal",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: [],
    });

    expect(getConfig().agents?.entries?.main?.modelPolicy?.allow).toContain(
      "minimax-portal/MiniMax-M3.1-Flash",
    );
    expect(getConfig().agents?.entries?.main?.models).toMatchObject({
      "minimax-portal/MiniMax-M3": {},
      "minimax-portal/MiniMax-M3.1-Flash": {},
    });
  });

  it("writes synchronized allowlists and model entries to runtime agent lists", async () => {
    const { api, getConfig } = createApi({
      agents: {
        entries: {},
        list: [
          {
            id: "main",
            modelPolicy: {
              allow: ["minimax-portal/MiniMax-M2.5"],
            },
            models: {
              "minimax-portal/MiniMax-M2.5": {},
            },
          },
        ],
      },
      ...baseConfig(
        {
          "minimax-portal": {
            baseUrl: "https://api.minimax.chat/v1",
            api: "openai-responses",
            models: [model("MiniMax-M2.5")],
          },
        },
        {
          "minimax-portal": {
            filter: { manualIds: ["MiniMax-M3"] },
            targetAgents: ["main"],
          },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("MiniMax-M2.5"), model("MiniMax-M3")]),
    });

    const preview = await operations.previewApply("minimax-portal");
    await operations.applyStrategy({
      provider: "minimax-portal",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: ["MiniMax-M2.5"],
      targetAgents: ["main"],
    });

    expect(getConfig().agents?.list?.[0]).toMatchObject({
      id: "main",
      modelPolicy: {
        allow: ["minimax-portal/MiniMax-M3"],
      },
      models: {
        "minimax-portal/MiniMax-M3": {},
      },
    });
  });

  it("removes deselected models from target agent allowlists and model entries", async () => {
    const { api, getConfig } = createApi(
      {
        agents: {
          entries: {
            main: {
              modelPolicy: {
                allow: [
                  "openrouter/openai/gpt-4o",
                  "minimax-portal/MiniMax-M3",
                  "minimax-portal/MiniMax-M2.7-highspeed",
                ],
              },
              models: {
                "openrouter/openai/gpt-4o": {},
                "minimax-portal/MiniMax-M3": {},
                "minimax-portal/MiniMax-M2.7-highspeed": {},
              },
            },
          },
        },
        ...baseConfig(
          {
            "minimax-portal": {
              baseUrl: "https://api.minimax.chat/v1",
              api: "openai-responses",
              models: [
                model("MiniMax-M3"),
                model("MiniMax-M2.5"),
              ],
            },
          },
          {
            "minimax-portal": {
              filter: {
                manualIds: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
              },
              targetAgents: ["main"],
            },
          },
        ),
      },
    );
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [
        model("MiniMax-M3"),
        model("MiniMax-M2.5"),
        model("MiniMax-M3.1-Flash"),
      ]),
    });

    const preview = await operations.previewApply("minimax-portal");
    expect(preview.plan.removedIds).toEqual(["MiniMax-M2.5"]);

    await operations.applyStrategy({
      provider: "minimax-portal",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: ["MiniMax-M2.5"],
    });

    const main = getConfig().agents?.entries?.main;
    expect(main?.modelPolicy?.allow).toEqual([
      "openrouter/openai/gpt-4o",
      "minimax-portal/MiniMax-M3",
      "minimax-portal/MiniMax-M3.1-Flash",
    ]);
    expect(main?.models).toEqual({
      "openrouter/openai/gpt-4o": {},
      "minimax-portal/MiniMax-M3": {},
      "minimax-portal/MiniMax-M3.1-Flash": {},
    });
  });

  it("refuses a stale confirmation when the remote list changes", async () => {
    const { api, mutateConfigFile } = createApi(
      baseConfig({
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-responses",
          models: [model("old"), model("keep")],
        },
      }),
    );
    let remote = [model("keep"), model("first")];
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => remote),
    });
    const preview = await operations.previewApply("openrouter");
    remote = [model("keep"), model("second")];

    await expect(
      operations.applyStrategy({
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: ["old"],
      }),
    ).rejects.toThrow(/模型列表或筛选策略已变化/);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("refuses when the confirmation omits a deletion", async () => {
    const { api, mutateConfigFile } = createApi(
      baseConfig({
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-responses",
          models: [model("old-a"), model("old-b")],
        },
      }),
    );
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => []),
    });
    const preview = await operations.previewApply("openrouter");

    await expect(
      operations.applyStrategy({
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: ["old-a"],
      }),
    ).rejects.toThrow(/待删除模型与确认列表不一致/);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("keeps a model referenced by utilityModel and reports the path in the plan", async () => {
    const { api, getConfig } = createApi({
      agents: {
        defaults: { utilityModel: "openrouter/openai/gpt-4o" },
        entries: { main: { utilityModel: "openrouter/openai/gpt-4o" } },
      },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("openai/gpt-4o"), model("stale/model")],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^anthropic/" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("anthropic/claude")]),
    });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.removedIds).toEqual(["stale/model"]);
    expect(preview.plan.protectedModels).toEqual([
      {
        modelId: "openai/gpt-4o",
        ref: "openrouter/openai/gpt-4o",
        references: ["agents.defaults.utilityModel", "agents.entries.main.utilityModel"],
      },
    ]);
    expect(preview.models.map((row) => row.id)).toContain("openai/gpt-4o");

    const applied = await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: preview.plan.removedIds,
    });
    expect(applied.removed).toBe(1);
    expect(applied.protectedModels).toEqual(preview.plan.protectedModels);
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "anthropic/claude",
      "openai/gpt-4o",
    ]);
    expect(getConfig().agents?.defaults?.utilityModel).toBe("openrouter/openai/gpt-4o");
  });

  it("keeps models referenced by hooks even when the hook is not an agent consumer", async () => {
    const { api, getConfig } = createApi({
      hooks: {
        gmail: { model: "openrouter/gmail-model" },
        mappings: [{ match: { path: "/inbox" }, model: "openrouter/hook-model" }],
      },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [
              model("gmail-model"),
              model("hook-model"),
              model("openai/gpt-4o"),
            ],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^openai/" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o")]),
    });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.protectedModels).toEqual([
      {
        modelId: "gmail-model",
        ref: "openrouter/gmail-model",
        references: ["hooks.gmail.model"],
      },
      {
        modelId: "hook-model",
        ref: "openrouter/hook-model",
        references: ["hooks.mappings[0].model"],
      },
    ]);
    expect(preview.plan.removedIds).toEqual([]);

    await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: [],
    });
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "gmail-model",
      "hook-model",
    ]);
  });

  it("refuses to write when a reference appears after the confirmation", async () => {
    const { api, getConfig } = createApi(
      baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("openai/gpt-4o"), model("stale/model")],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^openai/" } },
        },
      ),
    );
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o")]),
    });
    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.protectedModels).toEqual([]);

    const mutateConfigFile = vi.fn(
      async ({ mutate }: { mutate: (draft: unknown) => void }) => {
        const draft = structuredClone(getConfig()) as {
          agents?: { defaults?: { utilityModel?: string } };
        };
        draft.agents = { defaults: { utilityModel: "openrouter/stale/model" } };
        mutate(draft);
        return { path: "/tmp/openclaw.json" };
      },
    );
    (
      api.runtime.config as unknown as {
        mutateConfigFile: (params: {
          base?: string;
          afterWrite: { mode: "auto" };
          mutate: (draft: unknown) => void;
        }) => Promise<{ path: string }>;
      }
    ).mutateConfigFile = mutateConfigFile;

    await expect(
      operations.applyStrategy({
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: ["stale/model"],
      }),
    ).rejects.toThrow(/模型引用在确认后发生变化/);
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "stale/model",
    ]);
  });

  it("rewrites a protected model's references and drops it from the list", async () => {
    const { api, getConfig } = createApi({
      agents: {
        defaults: {
          model: { primary: "openrouter/openai/gpt-4o" },
          utilityModel: "openrouter/stale/model",
        },
      },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [
              model("openai/gpt-4o"),
              model("stale/model"),
              model("kept/model"),
            ],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^(openai/|kept/)" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o"), model("kept/model")]),
    });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.protectedModels).toEqual([
      {
        modelId: "stale/model",
        ref: "openrouter/stale/model",
        references: ["agents.defaults.utilityModel"],
      },
    ]);
    expect(preview.plan.removedIds).toEqual([]);

    const applied = await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: preview.plan.removedIds,
      referenceRewrites: [
        {
          protectedModelId: "stale/model",
          targetRef: "openrouter/openai/gpt-4o",
          useDefaultModel: false,
        },
      ],
    });
    expect(applied.rewrittenReferences).toEqual(["agents.defaults.utilityModel"]);
    expect(getConfig().agents?.defaults?.utilityModel).toBe("openrouter/openai/gpt-4o");
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "kept/model",
    ]);
  });

  it("rewrites alias references by moving the alias definition to the target model", async () => {
    const { api, getConfig } = createApi({
      agents: {
        defaults: {
          model: { primary: "fast" },
          models: {
            "openrouter/stale/model": { alias: "fast" },
          },
        },
      },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("openai/gpt-4o"), model("stale/model")],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^openai/" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o")]),
    });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.protectedModels).toEqual([
      {
        modelId: "stale/model",
        ref: "openrouter/stale/model",
        references: ["agents.defaults.model.primary"],
      },
    ]);

    const applied = await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: preview.plan.removedIds,
      referenceRewrites: [
        {
          protectedModelId: "stale/model",
          targetRef: "openrouter/openai/gpt-4o",
          useDefaultModel: false,
        },
      ],
    });

    expect(applied.protectedModels).toEqual([]);
    expect(getConfig().agents?.defaults?.model?.primary).toBe("fast");
    expect(getConfig().agents?.defaults?.models).toEqual({
      "openrouter/openai/gpt-4o": { alias: "fast" },
    });
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
    ]);
  });

  it("refuses to merge two protected aliases onto one model", async () => {
    const { api, getConfig } = createApi({
      agents: {
        defaults: {
          model: { primary: "fast" },
          models: {
            "openrouter/stale/model": { alias: "fast" },
            "openrouter/openai/gpt-4o": { alias: "gpt" },
          },
        },
      },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("openai/gpt-4o"), model("stale/model")],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^openai/" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o")]),
    });

    const preview = await operations.previewApply("openrouter");
    await expect(
      operations.applyStrategy({
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: preview.plan.removedIds,
        referenceRewrites: [
          {
            protectedModelId: "stale/model",
            targetRef: "openrouter/openai/gpt-4o",
            useDefaultModel: false,
          },
        ],
      }),
    ).rejects.toThrow(/both models define different aliases/);

    expect(getConfig().agents?.defaults?.models).toEqual({
      "openrouter/stale/model": { alias: "fast" },
      "openrouter/openai/gpt-4o": { alias: "gpt" },
    });
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "stale/model",
    ]);
  });

  it("refuses a rewrite that points at a model the plan also removes", async () => {
    const { api, getConfig } = createApi({
      agents: { defaults: { utilityModel: "openrouter/stale/model" } },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("openai/gpt-4o"), model("stale/model"), model("doomed/model")],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^openai/" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o")]),
    });

    const preview = await operations.previewApply("openrouter");
    await expect(
      operations.applyStrategy({
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: preview.plan.removedIds,
        referenceRewrites: [
          {
            protectedModelId: "stale/model",
            targetRef: "openrouter/doomed/model",
            useDefaultModel: false,
          },
        ],
      }),
    ).rejects.toThrow(/也会被删除/);
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "stale/model",
      "doomed/model",
    ]);
  });

  it("refuses a rewrite that points outside the current provider", async () => {
    const { api, getConfig } = createApi({
      agents: { defaults: { utilityModel: "openrouter/stale/model" } },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("openai/gpt-4o"), model("stale/model")],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^openai/" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o")]),
    });

    const preview = await operations.previewApply("openrouter");
    await expect(
      operations.applyStrategy({
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: preview.plan.removedIds,
        referenceRewrites: [
          {
            protectedModelId: "stale/model",
            targetRef: "other-provider/openai/gpt-4o",
            useDefaultModel: false,
          },
        ],
      }),
    ).rejects.toThrow(/不属于当前 Provider/);
    expect(getConfig().agents?.defaults?.utilityModel).toBe("openrouter/stale/model");
  });

  it("refuses a chain of protected-model rewrites", async () => {
    const { api, getConfig } = createApi({
      agents: {
        defaults: {
          utilityModel: "openrouter/protected-a",
          decisionModel: "openrouter/protected-b",
        },
      },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [
              model("kept/model"),
              model("protected-a"),
              model("protected-b"),
            ],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^kept/" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("kept/model")]),
    });

    const preview = await operations.previewApply("openrouter");
    await expect(
      operations.applyStrategy({
        provider: "openrouter",
        fingerprint: preview.plan.fingerprint,
        expectedRemovals: preview.plan.removedIds,
        referenceRewrites: [
          {
            protectedModelId: "protected-a",
            targetRef: "openrouter/protected-b",
            useDefaultModel: false,
          },
          {
            protectedModelId: "protected-b",
            targetRef: "openrouter/kept/model",
            useDefaultModel: false,
          },
        ],
      }),
    ).rejects.toThrow(/也会在本次操作中被改写/);
    expect(getConfig().models?.providers?.openrouter.models?.map((row) => row.id)).toEqual([
      "kept/model",
      "protected-a",
      "protected-b",
    ]);
  });

  it("reports the default model so the UI can offer it as a rewrite target", async () => {
    const { api } = createApi({
      agents: {
        defaults: { model: { primary: "openrouter/openai/gpt-4o" } },
      },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("openai/gpt-4o"), model("stale/model")],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^openai/" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o")]),
    });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.defaultModelRef).toBe("openrouter/openai/gpt-4o");
  });

  it("reports a removal that only differs from a protected model by letter case", async () => {
    const { api } = createApi({
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("MiniMax-M3"), model("minimax-m3")],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^minimax-m3$" } },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("minimax-m3")]),
    });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.protectedModels).toEqual([]);
    expect(preview.plan.removedIds).toEqual(["MiniMax-M3"]);
    expect(preview.plan.caseVariants).toEqual([
      { removedId: "MiniMax-M3", survivingModelId: "minimax-m3" },
    ]);
  });

  it("migrates aliases and allowlists to the surviving case variant", async () => {
    const staleRef = "magpie/auto/MiniMax-M3";
    const survivingRef = "magpie/auto/minimax-m3";
    const { api, getConfig } = createApi({
      agents: {
        defaults: {
          models: {
            [staleRef]: { alias: "Minimax" },
          },
          modelPolicy: {
            allow: ["magpie/*", staleRef],
          },
        },
        entries: {
          main: {
            models: {
              [staleRef]: { alias: "Agent Minimax" },
            },
            modelPolicy: {
              allow: [staleRef],
            },
          },
        },
      },
      ...baseConfig(
        {
          magpie: {
            baseUrl: "https://magpie.example/v1",
            api: "openai-responses",
            models: [model("auto/MiniMax-M3"), model("auto/minimax-m3")],
          },
        },
        {
          magpie: {
            filter: { includeRegex: "^auto/minimax-m3$", manualIds: [] },
            targetAgents: ["main"],
          },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("auto/minimax-m3")]),
    });

    const preview = await operations.previewApply("magpie");
    expect(preview.plan.removedIds).toEqual(["auto/MiniMax-M3"]);
    expect(preview.plan.caseVariants).toEqual([
      {
        removedId: "auto/MiniMax-M3",
        survivingModelId: "auto/minimax-m3",
      },
    ]);

    const applied = await operations.applyStrategy({
      provider: "magpie",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: preview.plan.removedIds,
      targetAgents: ["main"],
    });

    expect(getConfig().models?.providers?.magpie.models?.map((row) => row.id)).toEqual([
      "auto/minimax-m3",
    ]);
    expect(getConfig().agents?.defaults?.models).toEqual({
      [survivingRef]: { alias: "Minimax" },
    });
    expect(getConfig().agents?.defaults?.modelPolicy?.allow).toEqual([
      "magpie/*",
      survivingRef,
    ]);
    expect(getConfig().agents?.entries?.main?.models).toEqual({
      [survivingRef]: { alias: "Agent Minimax" },
    });
    expect(getConfig().agents?.entries?.main?.modelPolicy?.allow).toEqual([
      survivingRef,
    ]);
    expect(applied.rewrittenReferences).toEqual([
      "agents.defaults.modelPolicy.allow",
      "agents.defaults.models.magpie/auto/minimax-m3",
      "agents.entries.main.modelPolicy.allow",
      "agents.entries.main.models.magpie/auto/minimax-m3",
    ]);
  });

  it("keeps agent allowlist and model entry sync semantics unchanged when protecting models", async () => {
    const { api, getConfig } = createApi({
      agents: {
        defaults: { utilityModel: "openrouter/utility-model" },
        entries: {
          main: {
            modelPolicy: {
              allow: ["openrouter/openai/gpt-4o", "openrouter/utility-model"],
            },
            models: {
              "openrouter/openai/gpt-4o": {},
              "openrouter/utility-model": {},
            },
          },
        },
      },
      ...baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [
              model("openai/gpt-4o"),
              model("utility-model"),
              model("stale/model"),
            ],
          },
        },
        {
          openrouter: { filter: { includeRegex: "^openai/" }, targetAgents: ["main"] },
        },
      ),
    });
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [model("openai/gpt-4o")]),
    });

    const preview = await operations.previewApply("openrouter");
    expect(preview.plan.removedIds).toEqual(["stale/model"]);
    expect(preview.plan.protectedModels.map((entry) => entry.modelId)).toEqual(["utility-model"]);

    await operations.applyStrategy({
      provider: "openrouter",
      fingerprint: preview.plan.fingerprint,
      expectedRemovals: ["stale/model"],
      targetAgents: ["main"],
    });

    const main = getConfig().agents?.entries?.main;
    expect(main?.modelPolicy?.allow).toEqual([
      "openrouter/openai/gpt-4o",
      "openrouter/utility-model",
    ]);
    expect(main?.models).toEqual({
      "openrouter/openai/gpt-4o": {},
      "openrouter/utility-model": {},
    });
  });

  it("registers lower-case session actions with the right read/write scopes", () => {
    const { api, registerSessionAction } = createApi(baseConfig({}));
    registerModelFetchOperations(api);

    const actions = registerSessionAction.mock.calls.map(
      ([registration]) => registration as PluginSessionActionRegistration,
    );
    expect(actions.map((action) => action.id)).toEqual([
      "providers.list",
      "models.fetch",
      "strategy.save",
      "strategy.preview",
      "strategy.apply",
      "provider.refresh",
    ]);
    expect(actions.find((action) => action.id === "providers.list")?.requiredScopes).toEqual([
      "operator.read",
    ]);
    expect(actions.find((action) => action.id === "strategy.apply")?.requiredScopes).toEqual([
      "operator.write",
    ]);
  });

  it("maps browser payloads to session action implementations", async () => {
    const { api, registerSessionAction } = createApi(
      baseConfig({
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-responses",
        },
      }),
    );
    const fetchModels = vi.fn(async () => [model("openai/gpt-4o")]);
    registerModelFetchOperations(api, { fetchModels });
    const actions = new Map(
      registerSessionAction.mock.calls.map(([registration]) => [
        (registration as PluginSessionActionRegistration).id,
        registration as PluginSessionActionRegistration,
      ]),
    );

    const response = await actions.get("models.fetch")?.handler({
      pluginId: "model-fetch",
      actionId: "models.fetch",
      payload: { provider: "openrouter" },
    });

    expect(response).toMatchObject({
      ok: true,
      result: { provider: "openrouter" },
    });
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openrouter" }),
    );
  });

  it("returns JSON-compatible results for providers.list", async () => {
    const { api, registerSessionAction } = createApi(
      baseConfig(
        {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [],
          },
        },
        {
          openrouter: {
            filter: { includeRegex: "openai/" },
          },
        },
      ),
    );

    registerModelFetchOperations(api);
    const actions = new Map(
      registerSessionAction.mock.calls.map(([registration]) => [
        (registration as PluginSessionActionRegistration).id,
        registration as PluginSessionActionRegistration,
      ]),
    );

    const response = await actions.get("providers.list")?.handler({
      pluginId: "model-fetch",
      actionId: "providers.list",
      payload: {},
    });

    expect(response).toMatchObject({ ok: true });
    expect(() => JSON.stringify((response as { result: unknown }).result)).not.toThrow();
    expect(JSON.stringify((response as { result: unknown }).result)).not.toContain("undefined");
  });
});

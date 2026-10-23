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
        defaults?: { modelPolicy?: { allow?: string[] } };
        entries?: Record<
          string,
          {
            modelPolicy?: { allow?: string[] };
            models?: Record<string, Record<string, unknown>>;
          }
        >;
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
    const getSessionEntryAsync = vi.fn(async () => ({
      providerOverride: "openrouter",
      modelOverride: "stale/model",
      modelProvider: "openrouter",
      model: "stale/model",
      modelSelectionLocked: false,
    }));
    const patchSessionEntry = vi.fn(async () => ({
      providerOverride: undefined,
      modelOverride: undefined,
    }));
    const operations = createModelFetchOperations({
      api,
      fetchModels,
      sessionStore: { getSessionEntryAsync, patchSessionEntry },
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

    expect(applied.sessionSelectionReset).toBe(true);
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
    const getSessionEntryAsync = vi.fn(async () => ({
      modelProvider: "openrouter",
      model: "stale/model",
      modelSelectionLocked: false,
    }));
    const patchSessionEntry = vi.fn(async () => ({}));
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [kept]),
      sessionStore: { getSessionEntryAsync, patchSessionEntry },
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

    expect(applied.sessionSelectionReset).toBe(true);
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
    const getSessionEntryAsync = vi.fn(async () => ({
      providerOverride: "openrouter",
      modelOverride: "stale/model",
      modelSelectionLocked: true,
    }));
    const patchSessionEntry = vi.fn(async () => ({}));
    const operations = createModelFetchOperations({
      api,
      fetchModels: vi.fn(async () => [kept]),
      sessionStore: { getSessionEntryAsync, patchSessionEntry },
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

    expect(applied.sessionSelectionReset).toBe(false);
    expect(patchSessionEntry).not.toHaveBeenCalled();
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

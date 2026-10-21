import { describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import {
  buildModelsEndpoint,
  createModelFetchTool,
  fetchProviderModels,
  mergeModels,
  resolveEffectiveFilter,
  resolveProviderFilter,
  selectFetchedModels,
  syncConfiguredModelPolicyAllow,
  type ModelDefinitionLike,
  type ModelFetchConfig,
  type ModelFetchToolResult,
  type ProviderLike,
} from "./model-fetch.js";
import { ssrfPolicyFromAllowPrivateNetwork } from "openclaw/plugin-sdk/ssrf-runtime";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

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

describe("model-fetch metadata", () => {
  it("declares the model_fetch tool and provider filter config", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata?.tools.map((tool) => tool.name)).toEqual(["model_fetch"]);
    expect(metadata?.configSchema).toMatchObject({
      type: "object",
      properties: { providers: expect.anything() },
    });
  });
});

describe("filtering", () => {
  it("applies include and exclude regexes and lets manual IDs bypass them", () => {
    const rows = [
      model("openai/gpt-4o"),
      model("openai/text-embedding"),
      model("anthropic/claude"),
      model("manual/model"),
    ];
    const selected = selectFetchedModels(rows, {
      includeRegex: "^(openai|anthropic)/",
      excludeRegex: "embed",
      manualIds: ["manual/model"],
    });
    expect(selected.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "anthropic/claude",
      "manual/model",
    ]);
  });

  it("treats manual IDs as the complete selection when no include regex is set", () => {
    const rows = [model("qwen3:latest"), model("llama3.1:8b"), model("other")];
    const selected = selectFetchedModels(rows, { manualIds: ["qwen3:latest"] });
    expect(selected.map((row) => row.id)).toEqual(["qwen3:latest"]);
  });

  it("uses independent provider filters and temporary overrides", () => {
    const config = {
      plugins: {
        entries: {
          "model-fetch": {
            config: {
              providers: {
                openrouter: { filter: { includeRegex: "openai/" } },
                ollama: { filter: { manualIds: ["qwen3:latest"] } },
              },
            },
          },
        },
      },
    };
    expect(resolveProviderFilter("openrouter", config, undefined).includeRegex).toBe("openai/");
    expect(resolveProviderFilter("ollama", config, undefined).manualIds).toEqual(["qwen3:latest"]);
    expect(resolveProviderFilter("missing", config, undefined)).toEqual({});

    const factoryConfig: ModelFetchConfig = {
      providers: { fallback: { filter: { replace: true } } },
    };
    expect(resolveProviderFilter("fallback", undefined, factoryConfig).replace).toBe(true);
    expect(
      resolveEffectiveFilter(
        { includeRegex: "all/" },
        {
          provider: "x",
          excludeRegex: "skip",
          manualIds: ["x/manual"],
          replace: true,
        },
      ),
    ).toEqual({
      includeRegex: "all/",
      excludeRegex: "skip",
      manualIds: ["x/manual"],
      replace: true,
    });

    expect(resolveEffectiveFilter({ replace: false }, { provider: "x" }).replace).toBe(true);
    expect(resolveEffectiveFilter({ replace: false }, { provider: "x", replace: false }).replace).toBe(false);
  });

  it("rejects an invalid regex with a clear field name", () => {
    expect(() => selectFetchedModels([], { includeRegex: "(" })).toThrow(/Invalid includeRegex regex/);
  });
});

describe("model merge", () => {
  it("preserves existing metadata and adds only new selected models", () => {
    const existing = { ...model("same"), name: "Authored name" };
    const merge = mergeModels({
      existing: [existing],
      selected: [model("same"), model("new")],
      filter: {},
    });
    expect(merge.models.find((row) => row.id === "same")).toBe(existing);
    expect(merge.models.map((row) => row.id)).toEqual(["same", "new"]);
    expect(merge).toMatchObject({ added: 1, unchanged: 1, removed: 0 });
  });

  it("keeps stale models by default and removes them only with replace", () => {
    const existing = [model("old"), model("kept")];
    expect(mergeModels({ existing, selected: [model("kept")], filter: {} }).removed).toBe(0);
    const replaced = mergeModels({ existing, selected: [model("kept")], filter: { replace: true } });
    expect(replaced.models.map((row) => row.id)).toEqual(["kept"]);
    expect(replaced.removed).toBe(1);
  });

  it("keeps manually selected existing models even during replace", () => {
    const merge = mergeModels({
      existing: [model("manual"), model("old")],
      selected: [],
      filter: { manualIds: ["manual"], replace: true },
    });
    expect(merge.models.map((row) => row.id)).toEqual(["manual"]);
    expect(merge.selectedIds).toEqual(["manual"]);
  });
});

describe("provider endpoints", () => {
  it.each([
    [
      "openai",
      { baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
      "https://api.openai.com/v1/models",
    ],
    [
      "proxy",
      { baseUrl: "https://proxy.example/api/v1/", api: "openai-responses" },
      "https://proxy.example/api/v1/models",
    ],
    [
      "anthropic",
      { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
      "https://api.anthropic.com/v1/models",
    ],
    [
      "anthropic-v1",
      { baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages" },
      "https://api.anthropic.com/v1/models",
    ],
    [
      "ollama",
      { baseUrl: "http://127.0.0.1:11434", api: "ollama" },
      "http://127.0.0.1:11434/api/tags",
    ],
    [
      "ollama-v1",
      { baseUrl: "http://127.0.0.1:11434/v1", api: "ollama" },
      "http://127.0.0.1:11434/api/tags",
    ],
    [
      "openrouter",
      { baseUrl: "https://openrouter.ai/api/v1", api: "openai-responses" },
      "https://openrouter.ai/api/v1/models",
    ],
  ])("%s builds the expected models endpoint", (providerId: string, provider: ProviderLike, expected: string) => {
    expect(buildModelsEndpoint(providerId, provider)).toBe(expected);
  });
});

describe("guarded provider fetch", () => {
  it("parses OpenAI-compatible rows and passes the SSRF policy", async () => {
    const guardedFetch = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({ data: [{ id: "model-a", name: "Model A", context_length: 200000 }] }),
      ),
      finalUrl: "https://api.example/v1/models",
      release: vi.fn(async () => undefined),
    }));
    const models = await fetchProviderModels({
      providerId: "openai",
      provider: {
        baseUrl: "https://api.example/v1",
        api: "openai-completions",
        request: { allowPrivateNetwork: false },
      },
      apiKey: "secret-key",
      guardedFetch,
    });

    expect(models).toEqual([expect.objectContaining({ id: "model-a", contextWindow: 200000 })]);
    expect(guardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.example/v1/models",
        init: {
          method: "GET",
          headers: { Accept: "application/json", Authorization: "Bearer secret-key" },
        },
        policy: ssrfPolicyFromAllowPrivateNetwork(false),
      }),
    );
  });

  it("allows private endpoints only when the provider opts in", async () => {
    const guardedFetch = vi.fn(async () => ({
      response: new Response(JSON.stringify({ models: [{ name: "local-model" }] })),
      finalUrl: "http://127.0.0.1:11434/api/tags",
      release: vi.fn(async () => undefined),
    }));
    const provider: ProviderLike = {
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      request: { allowPrivateNetwork: true },
    };
    await fetchProviderModels({ providerId: "ollama", provider, guardedFetch });
    expect(guardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: ssrfPolicyFromAllowPrivateNetwork(true),
      }),
    );
  });
});

function createRuntimeMocks(config: Record<string, unknown>, models: ModelDefinitionLike[]) {
  const mutateConfigFile = vi.fn(async () => ({ path: "/tmp/openclaw.json" }));
  const api = {
    config,
    runtime: {
      config: {
        current: () => config,
        mutateConfigFile,
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "secret-key" })),
      },
    },
  } as unknown as OpenClawPluginApi;
  const toolContext = { runtimeConfig: config } as OpenClawPluginToolContext;
  const fetchModels = vi.fn(async () => models);
  const tool = createModelFetchTool({ api, toolContext, fetchModels });
  return { api, toolContext, mutateConfigFile, fetchModels, tool };
}

describe("tool execution", () => {
  it("writes the filtered model list through runtime config mutation", async () => {
    const config = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("old")],
          },
        },
      },
      plugins: {
        entries: {
          "model-fetch": {
            config: {
              providers: {
                openrouter: { filter: { includeRegex: "openai/", replace: true } },
              },
            },
          },
        },
      },
    };
    const fetched = [model("openai/gpt-4o"), model("anthropic/claude")];
    const { mutateConfigFile, fetchModels, tool } = createRuntimeMocks(config, fetched);
    const result = (await tool.execute("call-1", { provider: "openrouter" })) as {
      details: ModelFetchToolResult;
    };

    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openrouter", apiKey: "secret-key" }),
    );
    expect(mutateConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "source",
        afterWrite: { mode: "auto" },
        mutate: expect.any(Function),
      }),
    );
    const mutation = mutateConfigFile.mock.calls[0]?.[0];
    const draft = structuredClone(config);
    mutation?.mutate(draft);
    expect(draft.models?.providers?.openrouter).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-responses",
    });
    expect(draft.models?.providers?.openrouter?.models?.map((row) => row.id)).toEqual(["openai/gpt-4o"]);
    expect(result.details).toMatchObject({
      provider: "openrouter",
      fetched: 2,
      selected: ["openai/gpt-4o"],
      added: 1,
      unchanged: 0,
      removed: 1,
      replace: true,
      persisted: true,
    });
  });

  it("does not write configuration on dry run", async () => {
    const config = {
      models: {
        providers: {
          ollama: { baseUrl: "http://127.0.0.1:11434", api: "ollama", models: [] },
        },
      },
    };
    const { mutateConfigFile, tool } = createRuntimeMocks(config, [model("qwen3:latest")]);
    const result = (await tool.execute("call-2", {
      provider: "ollama",
      manualIds: ["qwen3:latest"],
      dryRun: true,
    })) as { details: ModelFetchToolResult };
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      selected: ["qwen3:latest"],
      dryRun: true,
      persisted: false,
      configPath: "models.providers.<providerId>.models",
    });
  });

  it("appends selected models to modelPolicy.allow when allowlist is configured", async () => {
    const config = {
      agents: {
        defaults: {
          modelPolicy: {
            allow: ["openai/gpt-6-astra", "minimax-portal/MiniMax-M3"],
          },
        },
      },
      models: {
        providers: {
          "minimax-portal": {
            baseUrl: "https://api.minimax.chat/v1",
            api: "openai-responses",
            models: [model("MiniMax-M3")],
          },
        },
      },
    };

    const fetched = [model("MiniMax-M3"), model("MiniMax-M3.1-Flash")];
    const { mutateConfigFile, tool } = createRuntimeMocks(config, fetched);

    await tool.execute("call-3", { provider: "minimax-portal" });

    const mutation = mutateConfigFile.mock.calls[0]?.[0];
    const draft = structuredClone(config);
    mutation?.mutate(draft);

    expect(draft.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/gpt-6-astra",
      "minimax-portal/MiniMax-M3",
      "minimax-portal/MiniMax-M3.1-Flash",
    ]);
  });

  it("keeps modelPolicy unrestricted when allowlist is empty or missing", () => {
    const empty = {
      agents: { defaults: { modelPolicy: { allow: [] as string[] } } },
    };
    syncConfiguredModelPolicyAllow(empty, "openrouter", [model("gpt-4o")]);
    expect(empty.agents.defaults.modelPolicy.allow).toEqual([]);

    const missing = {};
    syncConfiguredModelPolicyAllow(missing, "openrouter", [model("gpt-4o")]);
    expect((missing as { agents?: unknown }).agents).toBeUndefined();
  });
});

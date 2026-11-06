import { describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import {
  applyModelReferenceProtection,
  buildModelsEndpoint,
  collectCaseVariantRelations,
  collectModelReferenceUsages,
  createModelFetchTool,
  fetchProviderModels,
  listConfiguredAgentEntries,
  mergeModels,
  migrateModelRefEntries,
  resolveDefaultModelRef,
  resolveEffectiveFilter,
  resolveProviderFilter,
  rewriteModelReferences,
  syncAgentModelEntries,
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

describe("agent synchronization", () => {
  it("falls back to the runtime agent list when the authored entry map is empty", () => {
    const draft = {
      agents: {
        entries: {},
        list: [
          {
            id: "main",
            modelPolicy: {
              allow: ["proxy/old-model"],
            },
          },
        ],
      },
    };

    expect(listConfiguredAgentEntries(draft)).toEqual([
      {
        id: "main",
        entry: draft.agents.list[0],
      },
    ]);
  });

  it("supports legacy agent lists and still syncs provider-scoped agents", () => {
    const draft = {
      agents: {
        list: [
          {
            id: "main",
            modelPolicy: {
              allow: ["proxy/old-model", "other/model"],
            },
            models: {
              "proxy/old-model": { alias: "Old" },
              "other/model": { alias: "Other" },
            },
          },
          {
            id: "worker",
            modelPolicy: {
              allow: ["proxy/old-model"],
            },
            models: {
              "proxy/old-model": {},
            },
          },
        ],
      },
    };
    const models = [model("new-model")];

    const allowResult = syncConfiguredModelPolicyAllow(draft, "proxy", models, {
      targetAgents: ["main"],
    });
    expect(allowResult.syncedAgents).toEqual(["main", "worker"]);
    expect(draft.agents.list[0].modelPolicy.allow).toEqual([
      "other/model",
      "proxy/new-model",
    ]);
    expect(draft.agents.list[1].modelPolicy.allow).toEqual(["proxy/new-model"]);

    const modelResult = syncAgentModelEntries(draft, "proxy", models, {
      targetAgents: allowResult.syncedAgents,
    });
    expect(modelResult.syncedAgents).toEqual(["main", "worker"]);
    expect(draft.agents.list[0].models).toEqual({
      "proxy/new-model": {},
      "other/model": { alias: "Other" },
    });
    expect(draft.agents.list[1].models).toEqual({
      "proxy/new-model": {},
    });
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

describe("model reference protection", () => {
  const referenceConfig = {
    agents: {
      defaults: {
        model: "openrouter/default-model",
        utilityModel: "openrouter/utility-model",
        decisionModel: "openrouter/decision-model",
        imageModel: {
          primary: "openrouter/image-model",
          fallbacks: ["openrouter/image-fallback"],
        },
        mediaModels: {
          video: { primary: "openrouter/video-model", fallbacks: [] },
          music: "openrouter/music-model",
        },
        voiceModel: { primary: "openrouter/voice-model" },
        pdfModel: "openrouter/pdf-model",
        embeddedAgent: { cyberFailover: { model: "openrouter/cyber-model" } },
        heartbeat: { model: { primary: "openrouter/heartbeat-model", fallbacks: [] } },
        subagents: { model: "openrouter/subagents-model" },
        compaction: {
          model: "openrouter/compaction-model",
          memoryFlush: { model: "openrouter/compaction-flush" },
        },
      },
      entries: {
        main: {
          utilityModel: "openrouter/utility-model",
          decisionModel: "openrouter/entry-decision",
          tools: { exec: { reviewer: { model: "openrouter/entry-reviewer" } } },
          tts: { summaryModel: "openrouter/entry-tts-summary" },
        },
        blank: {},
      },
    },
    hooks: {
      gmail: { model: "openrouter/gmail-model" },
      mappings: [{ match: { path: "/inbox" }, model: "openrouter/hook-model" }, null, {}],
    },
    tools: {
      exec: { reviewer: { model: { primary: "openrouter/media-reviewer", fallbacks: [] } } },
      media: {
        models: [
          { provider: "openrouter", model: "shared-media-model" },
          { provider: "other", model: "shared-media-model" },
        ],
        audio: { preferredModel: "openrouter/tools-audio" },
        video: { preferredModel: "openrouter/tools-video" },
      },
    },
    tts: { summaryModel: "openrouter/root-tts-summary" },
    channels: {
      modelByChannel: {
        telegram: { main: "openrouter/channel-model" },
      },
      discord: {
        voice: { model: "openrouter/discord-voice-model" },
        accounts: {
          bot: { voice: { tts: { summaryModel: "openrouter/discord-account-tts" } } },
        },
      },
    },
  };

  it("reports every consumer path that pins a pending deletion", () => {
    const usages = collectModelReferenceUsages(referenceConfig, "openrouter", [
      "utility-model",
      "decision-model",
      "image-model",
      "image-fallback",
      "default-model",
      "heartbeat-model",
      "subagents-model",
      "compaction-model",
      "compaction-flush",
      "entry-reviewer",
      "entry-tts-summary",
      "media-reviewer",
      "tools-audio",
      "tools-video",
      "shared-media-model",
      "root-tts-summary",
      "channel-model",
      "discord-voice-model",
      "discord-account-tts",
      "video-model",
      "music-model",
      "voice-model",
      "pdf-model",
      "cyber-model",
      "entry-decision",
      "gmail-model",
      "hook-model",
      "unreferenced",
    ]);

    expect(usages.map((usage) => usage.modelId)).toEqual([
      "channel-model",
      "compaction-flush",
      "compaction-model",
      "cyber-model",
      "decision-model",
      "default-model",
      "discord-account-tts",
      "discord-voice-model",
      "entry-decision",
      "entry-reviewer",
      "entry-tts-summary",
      "gmail-model",
      "heartbeat-model",
      "hook-model",
      "image-fallback",
      "image-model",
      "media-reviewer",
      "music-model",
      "pdf-model",
      "root-tts-summary",
      "shared-media-model",
      "subagents-model",
      "tools-audio",
      "tools-video",
      "utility-model",
      "video-model",
      "voice-model",
    ]);
    expect(usages.find((usage) => usage.modelId === "default-model")?.references).toEqual([
      "agents.defaults.model",
    ]);
    expect(usages.find((usage) => usage.modelId === "heartbeat-model")?.references).toEqual([
      "agents.defaults.heartbeat.model.primary",
    ]);
    expect(usages.find((usage) => usage.modelId === "shared-media-model")?.references).toEqual([
      "tools.media.models[0].model",
    ]);
    expect(usages.find((usage) => usage.modelId === "subagents-model")?.references).toEqual([
      "agents.defaults.subagents.model",
    ]);
    expect(usages.find((usage) => usage.modelId === "compaction-model")?.references).toEqual([
      "agents.defaults.compaction.model",
    ]);
    expect(usages.find((usage) => usage.modelId === "compaction-flush")?.references).toEqual([
      "agents.defaults.compaction.memoryFlush.model",
    ]);
    expect(usages.find((usage) => usage.modelId === "entry-reviewer")?.references).toEqual([
      "agents.entries.main.tools.exec.reviewer.model",
    ]);
    expect(usages.find((usage) => usage.modelId === "entry-tts-summary")?.references).toEqual([
      "agents.entries.main.tts.summaryModel",
    ]);
    expect(usages.find((usage) => usage.modelId === "media-reviewer")?.references).toEqual([
      "tools.exec.reviewer.model.primary",
    ]);
    expect(usages.find((usage) => usage.modelId === "tools-audio")?.references).toEqual([
      "tools.media.audio.preferredModel",
    ]);
    expect(usages.find((usage) => usage.modelId === "root-tts-summary")?.references).toEqual([
      "tts.summaryModel",
    ]);
    expect(usages.find((usage) => usage.modelId === "channel-model")?.references).toEqual([
      "channels.modelByChannel.telegram.main",
    ]);
    expect(usages.find((usage) => usage.modelId === "discord-voice-model")?.references).toEqual([
      "channels.discord.voice.model",
    ]);
    expect(usages.find((usage) => usage.modelId === "discord-account-tts")?.references).toEqual([
      "channels.discord.accounts.bot.voice.tts.summaryModel",
    ]);
    expect(usages.find((usage) => usage.modelId === "utility-model")).toEqual({
      modelId: "utility-model",
      ref: "openrouter/utility-model",
      references: ["agents.defaults.utilityModel", "agents.entries.main.utilityModel"],
    });
    expect(usages.find((usage) => usage.modelId === "image-model")?.references).toEqual([
      "agents.defaults.imageModel.primary",
    ]);
    expect(usages.find((usage) => usage.modelId === "image-fallback")?.references).toEqual([
      "agents.defaults.imageModel.fallbacks[0]",
    ]);
    expect(usages.find((usage) => usage.modelId === "video-model")?.references).toEqual([
      "agents.defaults.mediaModels.video.primary",
    ]);
    expect(usages.find((usage) => usage.modelId === "music-model")?.references).toEqual([
      "agents.defaults.mediaModels.music",
    ]);
    expect(usages.find((usage) => usage.modelId === "pdf-model")?.references).toEqual([
      "agents.defaults.pdfModel",
    ]);
    expect(usages.find((usage) => usage.modelId === "cyber-model")?.references).toEqual([
      "agents.defaults.embeddedAgent.cyberFailover.model",
    ]);
    expect(usages.find((usage) => usage.modelId === "gmail-model")?.references).toEqual([
      "hooks.gmail.model",
    ]);
    expect(usages.find((usage) => usage.modelId === "hook-model")?.references).toEqual([
      "hooks.mappings[0].model",
    ]);
  });

  it("keeps explicit primary models but ignores allowlists and agent model maps", () => {
    const usages = collectModelReferenceUsages(
      {
        agents: {
          defaults: {
            modelPolicy: { allow: ["openrouter/allowlisted", "openrouter/*"] },
            model: "openrouter/default-model",
            utilityModel: "ark/utility-model",
          },
          entries: {
            main: {
              models: { "openrouter/entry-model": {} },
              modelPolicy: { allow: ["openrouter/entry-model"] },
            },
          },
        },
      },
      "openrouter",
      ["allowlisted", "entry-model", "default-model", "utility-model"],
    );
    expect(usages).toEqual([
      {
        modelId: "default-model",
        ref: "openrouter/default-model",
        references: ["agents.defaults.model"],
      },
    ]);
  });

  it("resolves model aliases used by explicit model consumers", () => {
    const usages = collectModelReferenceUsages(
      {
        agents: {
          defaults: {
            model: { primary: "fast" },
            models: {
              "openrouter/aliased-model": { alias: "fast" },
            },
          },
        },
      },
      "openrouter",
      ["aliased-model"],
    );

    expect(usages).toEqual([
      {
        modelId: "aliased-model",
        ref: "openrouter/aliased-model",
        references: ["agents.defaults.model.primary"],
      },
    ]);
  });

  it("scans legacy agent list entries", () => {
    const usages = collectModelReferenceUsages(
      { agents: { list: [{ model: "openrouter/list-model" }] } },
      "openrouter",
      ["list-model"],
    );
    expect(usages).toEqual([
      {
        modelId: "list-model",
        ref: "openrouter/list-model",
        references: ["agents.list[0].model"],
      },
    ]);
  });

  it("keeps referenced models in the replacement list and reports their paths", () => {
    const existing = [model("keep"), model("utility-model"), model("drop")];
    const merge = mergeModels({
      existing,
      selected: [model("keep")],
      filter: { replace: true },
    });
    expect(merge.models.map((row) => row.id)).toEqual(["keep"]);

    const protection = applyModelReferenceProtection({
      existing,
      merged: merge.models,
      providerId: "openrouter",
      config: referenceConfig,
    });

    expect(protection.models.map((row) => row.id)).toEqual(["keep", "utility-model"]);
    expect(protection.protectedModels).toEqual([
      {
        modelId: "utility-model",
        ref: "openrouter/utility-model",
        references: ["agents.defaults.utilityModel", "agents.entries.main.utilityModel"],
      },
    ]);
  });

  it("returns the merged list untouched when nothing references a deletion", () => {
    const existing = [model("keep"), model("drop")];
    const merged = mergeModels({ existing, selected: [model("keep")], filter: { replace: true } })
      .models;
    const protection = applyModelReferenceProtection({
      existing,
      merged,
      providerId: "openrouter",
      config: referenceConfig,
    });
    expect(protection.models.map((row) => row.id)).toEqual(["keep"]);
    expect(protection.protectedModels).toEqual([]);
  });
});

describe("model reference rewriting", () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: "magpie/auto/primary", fallbacks: ["magpie/auto/old"] },
        utilityModel: "magpie/auto/old",
        heartbeat: { model: { primary: "magpie/auto/old", fallbacks: [] } },
      },
      entries: {
        main: {
          model: "magpie/auto/old",
          tts: { summaryModel: "magpie/auto/old" },
        },
      },
    },
    hooks: { gmail: { model: "magpie/auto/old" } },
    tts: { summaryModel: "magpie/auto/old" },
    channels: {
      modelByChannel: { telegram: { main: "magpie/auto/old" } },
      discord: { voice: { model: "magpie/auto/old" } },
    },
    tools: {
      exec: { reviewer: { model: { primary: "magpie/auto/old", fallbacks: [] } } },
      media: {
        models: [
          { provider: "magpie", model: "auto/old" },
          { provider: "other", model: "auto/old" },
        ],
        audio: { preferredModel: "magpie/auto/old" },
      },
    },
  };

  it("rewrites every consumer that names the model", () => {
    const draft = structuredClone(config);
    const result = rewriteModelReferences(draft, "magpie/auto/old", "magpie/auto/new");

    expect(result.changed).toBe(true);
    expect(draft.agents.defaults.model.fallbacks).toEqual(["magpie/auto/new"]);
    expect(draft.agents.defaults.utilityModel).toBe("magpie/auto/new");
    expect(draft.agents.defaults.heartbeat.model.primary).toBe("magpie/auto/new");
    expect(draft.agents.entries.main.model).toBe("magpie/auto/new");
    expect(draft.agents.entries.main.tts.summaryModel).toBe("magpie/auto/new");
    expect(draft.hooks.gmail.model).toBe("magpie/auto/new");
    expect(draft.tts.summaryModel).toBe("magpie/auto/new");
    expect(draft.channels.modelByChannel.telegram.main).toBe("magpie/auto/new");
    expect(draft.channels.discord.voice.model).toBe("magpie/auto/new");
    expect(draft.tools.exec.reviewer.model.primary).toBe("magpie/auto/new");
    expect(draft.tools.media.models).toEqual([
      { provider: "magpie", model: "auto/new" },
      { provider: "other", model: "auto/old" },
    ]);
    expect(draft.tools.media.audio.preferredModel).toBe("magpie/auto/new");
  });

  it("leaves unrelated references alone", () => {
    const draft = structuredClone(config);
    const result = rewriteModelReferences(draft, "magpie/auto/missing", "magpie/auto/new");

    expect(result.changed).toBe(false);
    expect(result.paths).toEqual([]);
    expect(draft.agents.defaults.utilityModel).toBe("magpie/auto/old");
  });

  it("does nothing when the target equals the source", () => {
    const draft = structuredClone(config);
    const result = rewriteModelReferences(draft, "magpie/auto/old", "magpie/auto/old");
    expect(result.changed).toBe(false);
  });

  it("resolves the default model from the agent defaults", () => {
    expect(
      resolveDefaultModelRef({
        agents: { defaults: { model: { primary: "magpie/auto/primary" } } },
      }),
    ).toBe("magpie/auto/primary");
  });

  it("resolves an aliased default model to its provider reference", () => {
    expect(
      resolveDefaultModelRef({
        agents: {
          defaults: {
            model: { primary: "fast" },
            models: {
              "magpie/auto/fast-model": { alias: "fast" },
            },
          },
        },
      }),
    ).toBe("magpie/auto/fast-model");
  });

  it("resolves aliases within the agent that uses them", () => {
    expect(
      resolveDefaultModelRef({
        agents: {
          defaults: {
            models: {
              "magpie/default/model": { alias: "fast" },
            },
          },
          entries: {
            main: {
              model: { primary: "fast" },
              models: {
                "magpie/agent/model": { alias: "fast" },
              },
            },
          },
        },
      }),
    ).toBe("magpie/agent/model");
  });

  it("protects the model selected by a scoped alias when another agent reuses the alias", () => {
    const usages = collectModelReferenceUsages(
      {
        agents: {
          defaults: {
            models: {
              "proxy/agent-a-model": { alias: "fast" },
            },
          },
          entries: {
            main: {
              utilityModel: "fast",
              models: {
                "proxy/agent-b-model": { alias: "fast" },
              },
            },
            worker: {
              models: {
                "proxy/agent-a-model": { alias: "fast" },
              },
            },
          },
        },
      },
      "proxy",
      ["agent-a-model", "agent-b-model"],
    );

    expect(usages).toEqual([
      {
        modelId: "agent-b-model",
        ref: "proxy/agent-b-model",
        references: ["agents.entries.main.utilityModel"],
      },
    ]);
  });

  it("falls back to the first agent that names a primary model", () => {
    expect(
      resolveDefaultModelRef({
        agents: {
          defaults: { model: { primary: "" } },
          entries: {
            blank: { model: "magpie/auto/from-entry" },
          },
        },
      }),
    ).toBe("magpie/auto/from-entry");
  });

  it("returns nothing when no agent names a primary model", () => {
    expect(resolveDefaultModelRef({ agents: { entries: {} } })).toBeUndefined();
  });
});

describe("model reference entry migration", () => {
  it("moves the alias and the allowlist entry to the surviving spelling", () => {
    const draft = {
      agents: {
        defaults: {
          models: {
            "magpie/auto/MiniMax-M3": { alias: "Minimax" },
            "magpie/auto/minimax-m3": {},
          },
          modelPolicy: {
            allow: ["magpie/*", "magpie/auto/MiniMax-M3", "magpie/auto/minimax-m3"],
          },
        },
        entries: {
          main: {
            models: { "magpie/auto/MiniMax-M3": { alias: "Agent alias" } },
            modelPolicy: { allow: ["magpie/auto/MiniMax-M3"] },
          },
        },
      },
    };

    const result = migrateModelRefEntries(draft, [
      { fromRef: "magpie/auto/MiniMax-M3", toRef: "magpie/auto/minimax-m3" },
    ]);

    expect(result.changed).toBe(true);
    expect(draft.agents.defaults.models).toEqual({
      "magpie/auto/minimax-m3": { alias: "Minimax" },
    });
    expect(draft.agents.defaults.modelPolicy.allow).toEqual([
      "magpie/*",
      "magpie/auto/minimax-m3",
    ]);
    expect(draft.agents.entries.main.models).toEqual({
      "magpie/auto/minimax-m3": { alias: "Agent alias" },
    });
    expect(draft.agents.entries.main.modelPolicy.allow).toEqual([
      "magpie/auto/minimax-m3",
    ]);
  });

  it("keeps the surviving alias when both spellings already carry one", () => {
    const draft = {
      agents: {
        defaults: {
          models: {
            "magpie/auto/MiniMax-M3": { alias: "Stale" },
            "magpie/auto/minimax-m3": { alias: "Current" },
          },
        },
      },
    };

    migrateModelRefEntries(draft, [
      { fromRef: "magpie/auto/MiniMax-M3", toRef: "magpie/auto/minimax-m3" },
    ]);

    expect(draft.agents.defaults.models).toEqual({
      "magpie/auto/minimax-m3": { alias: "Current" },
    });
  });

  it("leaves other agents alone when target agents are scoped", () => {
    const draft = {
      agents: {
        entries: {
          main: { modelPolicy: { allow: ["magpie/auto/MiniMax-M3"] } },
          worker: { modelPolicy: { allow: ["magpie/auto/MiniMax-M3"] } },
        },
      },
    };

    migrateModelRefEntries(
      draft,
      [{ fromRef: "magpie/auto/MiniMax-M3", toRef: "magpie/auto/minimax-m3" }],
      { targetAgents: ["main"] },
    );

    expect(draft.agents.entries.main.modelPolicy.allow).toEqual([
      "magpie/auto/minimax-m3",
    ]);
    expect(draft.agents.entries.worker.modelPolicy.allow).toEqual([
      "magpie/auto/MiniMax-M3",
    ]);
  });

  it("migrates legacy agent list entries and honours their ids", () => {
    const draft = {
      agents: {
        list: [
          {
            id: "main",
            models: {
              "magpie/auto/MiniMax-M3": { alias: "Minimax" },
            },
            modelPolicy: { allow: ["magpie/auto/MiniMax-M3"] },
          },
          {
            id: "worker",
            models: {
              "magpie/auto/MiniMax-M3": { alias: "Worker alias" },
            },
            modelPolicy: { allow: ["magpie/auto/MiniMax-M3"] },
          },
        ],
      },
    };

    const result = migrateModelRefEntries(
      draft,
      [{ fromRef: "magpie/auto/MiniMax-M3", toRef: "magpie/auto/minimax-m3" }],
      { targetAgents: ["main"] },
    );

    expect(draft.agents.list[0]).toEqual({
      id: "main",
      models: {
        "magpie/auto/minimax-m3": { alias: "Minimax" },
      },
      modelPolicy: { allow: ["magpie/auto/minimax-m3"] },
    });
    expect(draft.agents.list[1]).toEqual({
      id: "worker",
      models: {
        "magpie/auto/MiniMax-M3": { alias: "Worker alias" },
      },
      modelPolicy: { allow: ["magpie/auto/MiniMax-M3"] },
    });
    expect(result.paths).toEqual([
      "agents.list[0].modelPolicy.allow",
      "agents.list[0].models.magpie/auto/minimax-m3",
    ]);
  });

  it("reports no change when the stale spelling is absent", () => {
    const draft = {
      agents: { defaults: { modelPolicy: { allow: ["magpie/auto/minimax-m3"] } } },
    };
    const result = migrateModelRefEntries(draft, [
      { fromRef: "magpie/auto/MiniMax-M3", toRef: "magpie/auto/minimax-m3" },
    ]);
    expect(result.changed).toBe(false);
    expect(result.paths).toEqual([]);
  });
});

describe("case variant relations", () => {
  it("pairs a removal with the surviving model that only differs in case", () => {
    const relations = collectCaseVariantRelations(
      ["auto/MiniMax-M3", "other/model"],
      ["auto/minimax-m3", "unrelated/model"],
    );

    expect(relations).toEqual([
      { removedId: "auto/MiniMax-M3", survivingModelId: "auto/minimax-m3" },
    ]);
  });

  it("reports nothing when the ids are identical", () => {
    const relations = collectCaseVariantRelations(
      ["auto/minimax-m3"],
      ["auto/minimax-m3"],
    );
    expect(relations).toEqual([]);
  });

  it("reports nothing when the ids differ beyond letter case", () => {
    const relations = collectCaseVariantRelations(
      ["auto/minimax-m3-turbo"],
      ["auto/minimax-m3"],
    );
    expect(relations).toEqual([]);
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
    [
      "openrouter",
      { baseUrl: "https://gateway.example/openrouter/v1", api: "openai-responses" },
      "https://gateway.example/openrouter/v1/models",
    ],
  ])("%s builds the expected models endpoint", (providerId: string, provider: ProviderLike, expected: string) => {
    expect(buildModelsEndpoint(providerId, provider)).toBe(expected);
  });
});

describe("guarded provider fetch", () => {
  it("parses OpenAI-compatible rows and passes the SSRF policy", async () => {
    const guardedFetch = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [
            {
              id: "model-a",
              name: "Model A",
              context_length: 200_000,
              top_provider: { max_completion_tokens: 32_000 },
              architecture: { input_modalities: ["text", "image"] },
              supported_parameters: ["reasoning", "tools"],
              pricing: {
                prompt: "0.000001",
                completion: "0.000002",
                input_cache_read: "0.00000025",
                input_cache_write: "0.0000005",
              },
            },
          ],
        }),
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

    expect(models).toEqual([
      expect.objectContaining({
        id: "model-a",
        name: "Model A",
        contextWindow: 200_000,
        maxTokens: 32_000,
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 1,
          output: 2,
          cacheRead: 0.25,
          cacheWrite: 0.5,
        },
      }),
    ]);
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

  it("follows cursor pagination and releases every guarded response", async () => {
    const requestedUrls: string[] = [];
    const release = vi.fn(async () => undefined);
    const guardedFetch = vi.fn(
      async ({ url }: { url: string }) => {
        requestedUrls.push(url);
        const body = url.includes("after_id=cursor-2")
          ? {
              data: [{ id: "model-c", display_name: "Model C" }],
              has_more: false,
            }
          : url.includes("after_id=cursor-1")
            ? {
                data: [{ id: "model-b", display_name: "Model B" }],
                has_more: true,
                last_id: "cursor-2",
              }
            : {
                data: [{ id: "model-a", display_name: "Model A" }],
                has_more: true,
                last_id: "cursor-1",
              };
        return {
          response: new Response(JSON.stringify(body)),
          finalUrl: url,
          release,
        };
      },
    );

    const models = await fetchProviderModels({
      providerId: "anthropic",
      provider: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
      },
      guardedFetch,
    });

    expect(requestedUrls).toEqual([
      "https://api.anthropic.com/v1/models",
      "https://api.anthropic.com/v1/models?after_id=cursor-1",
      "https://api.anthropic.com/v1/models?after_id=cursor-2",
    ]);
    expect(models.map((entry) => entry.id)).toEqual(["model-a", "model-b", "model-c"]);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("rejects a pagination cursor that repeats", async () => {
    const guardedFetch = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a" }],
          has_more: true,
          last_id: "same-cursor",
        }),
      ),
      finalUrl: "https://api.example/v1/models",
      release: vi.fn(async () => undefined),
    }));

    await expect(
      fetchProviderModels({
        providerId: "proxy",
        provider: {
          baseUrl: "https://api.example/v1",
          api: "openai-completions",
        },
        guardedFetch,
      }),
    ).rejects.toThrow(/repeated cursor/);
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a successful response without a supported model array", async () => {
    const release = vi.fn(async () => undefined);
    const guardedFetch = vi.fn(async () => ({
      response: new Response(JSON.stringify({ error: { message: "upstream failed" } })),
      finalUrl: "https://api.example/v1/models",
      release,
    }));

    await expect(
      fetchProviderModels({
        providerId: "proxy",
        provider: {
          baseUrl: "https://api.example/v1",
          api: "openai-completions",
        },
        guardedFetch,
      }),
    ).rejects.toThrow(/supported models array/);
    expect(release).toHaveBeenCalledOnce();
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

  it("keeps a referenced utility model instead of deleting it", async () => {
    const config = {
      agents: {
        defaults: { utilityModel: "openrouter/utility-model" },
      },
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("utility-model"), model("stale")],
          },
        },
      },
    };
    const { mutateConfigFile, tool } = createRuntimeMocks(config, [model("openai/gpt-4o")]);
    const result = (await tool.execute("call-protected", {
      provider: "openrouter",
      includeRegex: "^openai/",
    })) as { details: ModelFetchToolResult };

    expect(result.details).toMatchObject({
      removed: 1,
      protectedModels: [
        {
          modelId: "utility-model",
          ref: "openrouter/utility-model",
          references: ["agents.defaults.utilityModel"],
        },
      ],
    });
    const mutation = mutateConfigFile.mock.calls[0]?.[0];
    const draft = structuredClone(config);
    mutation?.mutate(draft);
    expect(
      (draft.models.providers.openrouter.models as ModelDefinitionLike[]).map((row) => row.id),
    ).toEqual(["openai/gpt-4o", "utility-model"]);
  });

  it("rechecks references against the final write draft", async () => {
    const config: {
      agents?: { defaults?: { utilityModel?: string } };
      models: {
        providers: {
          openrouter: {
            baseUrl: string;
            api: string;
            models: ModelDefinitionLike[];
          };
        };
      };
    } = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-responses",
            models: [model("utility-model")],
          },
        },
      },
    };
    const mutateConfigFile = vi.fn(
      async ({ mutate }: { mutate: (draft: unknown) => void }) => {
        const draft = structuredClone(config);
        mutate(draft);
        Object.assign(config, draft);
        return { path: "/tmp/openclaw.json" };
      },
    );
    const api = {
      config,
      runtime: {
        config: {
          current: () => config,
          mutateConfigFile,
        },
      },
    } as unknown as OpenClawPluginApi;
    const toolContext = { runtimeConfig: config } as OpenClawPluginToolContext;
    const tool = createModelFetchTool({
      api,
      toolContext,
      fetchModels: vi.fn(async () => {
        config.agents = {
          defaults: { utilityModel: "openrouter/utility-model" },
        };
        return [model("openai/gpt-4o")];
      }),
    });

    const result = (await tool.execute("call-race-protected", {
      provider: "openrouter",
      includeRegex: "^openai/",
    })) as { details: ModelFetchToolResult };

    expect(result.details).toMatchObject({
      removed: 0,
      protectedModels: [
        {
          modelId: "utility-model",
          ref: "openrouter/utility-model",
          references: ["agents.defaults.utilityModel"],
        },
      ],
    });
    expect(config.models.providers.openrouter.models.map((row) => row.id)).toEqual([
      "openai/gpt-4o",
      "utility-model",
    ]);
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

  it("syncs agent-level allowlists that already scope the provider", () => {
    const config = {
      agents: {
        defaults: {
          modelPolicy: {
            allow: ["openrouter/openai/gpt-oss-120b:free", "minimax-portal/MiniMax-M3"],
          },
        },
        entries: {
          main: {
            modelPolicy: {
              allow: [
                "openrouter/openai/gpt-oss-120b:free",
                "minimax-portal/MiniMax-M3",
              ],
            },
          },
          worker: {
            modelPolicy: {
              allow: ["openrouter/*"],
            },
          },
        },
      },
    };

    syncConfiguredModelPolicyAllow(config, "minimax-portal", [
      model("MiniMax-M3"),
      model("MiniMax-M3.1-Flash"),
    ]);

    expect(config.agents.defaults.modelPolicy.allow).toContain(
      "minimax-portal/MiniMax-M3.1-Flash",
    );
    expect(config.agents.entries.main.modelPolicy.allow).toContain(
      "minimax-portal/MiniMax-M3.1-Flash",
    );
    expect(config.agents.entries.worker.modelPolicy.allow).toEqual(["openrouter/*"]);
  });

  it("can force-sync selected target agents during apply", () => {
    const config = {
      agents: {
        entries: {
          main: {
            modelPolicy: {
              allow: ["openrouter/openai/gpt-oss-120b:free"],
            },
          },
        },
      },
    };

    const result = syncConfiguredModelPolicyAllow(
      config,
      "minimax-portal",
      [model("MiniMax-M3.1-Flash")],
      { targetAgents: ["main"] },
    );

    expect(result.syncedAgents).toEqual(["main"]);
    expect(config.agents.entries.main.modelPolicy.allow).toContain(
      "minimax-portal/MiniMax-M3.1-Flash",
    );
  });

  it("removes deselected provider refs while preserving patterns and other providers", () => {
    const config = {
      agents: {
        defaults: {
          modelPolicy: {
            allow: [
              "openrouter/openai/gpt-4o",
              "minimax-portal/MiniMax-M3",
              "minimax-portal/MiniMax-M2.5",
              "minimax-portal/*",
            ],
          },
        },
        entries: {
          main: {
            modelPolicy: {
              allow: [
                "openrouter/openai/gpt-4o",
                "minimax-portal/MiniMax-M3",
                "minimax-portal/MiniMax-M2.5",
                "minimax-portal/*",
              ],
            },
          },
        },
      },
    };

    const result = syncConfiguredModelPolicyAllow(
      config,
      "minimax-portal",
      [model("MiniMax-M3"), model("MiniMax-M3.1-Flash")],
      { targetAgents: ["main"] },
    );

    expect(result.syncedAgents).toEqual(["main"]);
    expect(config.agents.defaults.modelPolicy.allow).toEqual([
      "openrouter/openai/gpt-4o",
      "minimax-portal/MiniMax-M3",
      "minimax-portal/*",
      "minimax-portal/MiniMax-M3.1-Flash",
    ]);
    expect(config.agents.entries.main.modelPolicy.allow).toEqual([
      "openrouter/openai/gpt-4o",
      "minimax-portal/MiniMax-M3",
      "minimax-portal/*",
      "minimax-portal/MiniMax-M3.1-Flash",
    ]);
  });

  it("adds selected provider models into target agent model entries", () => {
    const config = {
      agents: {
        entries: {
          main: {
            models: {
              "openrouter/openai/gpt-oss-120b:free": {},
            },
          },
        },
      },
    };

    const result = syncAgentModelEntries(
      config,
      "minimax-portal",
      [model("MiniMax-M3"), model("MiniMax-M3.1-Flash")],
      { targetAgents: ["main"] },
    );

    expect(result.syncedAgents).toEqual(["main"]);
    expect(config.agents.entries.main.models).toMatchObject({
      "openrouter/openai/gpt-oss-120b:free": {},
      "minimax-portal/MiniMax-M3": {},
      "minimax-portal/MiniMax-M3.1-Flash": {},
    });
  });

  it("removes deselected provider model entries and preserves custom entries", () => {
    const config = {
      agents: {
        entries: {
          main: {
            models: {
              "minimax-portal/MiniMax-M2.5": {},
              "minimax-portal/MiniMax-M3": { alias: "M3 Fast" },
              "openrouter/openai/gpt-4o": {},
            },
          },
        },
      },
    };

    const result = syncAgentModelEntries(
      config,
      "minimax-portal",
      [model("MiniMax-M3"), model("MiniMax-M3.1-Flash")],
      { targetAgents: ["main"] },
    );

    expect(result.syncedAgents).toEqual(["main"]);
    expect(config.agents.entries.main.models).toEqual({
      "minimax-portal/MiniMax-M3": { alias: "M3 Fast" },
      "openrouter/openai/gpt-4o": {},
      "minimax-portal/MiniMax-M3.1-Flash": {},
    });
  });
});

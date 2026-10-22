import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import {
  analyzeModelFilter,
  computeModelChanges,
  mountModelFetchSettings,
} from "./settings-view.js";
import type {
  ApplyPlan,
  FetchModelsOutput,
  ListProvidersOutput,
  ModelView,
  PreviewApplyOutput,
} from "./schemas.js";

const openRouterModels: ModelView[] = [
  { id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
  { id: "anthropic/claude", name: "Claude", contextWindow: 200_000 },
  { id: "openai/text-embedding", name: "Embedding", contextWindow: 8_191 },
];

function providersOutput(): ListProvidersOutput {
  return {
    providers: [
      {
        id: "openrouter",
        label: "OpenRouter",
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        configPath: "models.providers.openrouter.models",
        filter: { includeRegex: "", excludeRegex: "", manualIds: [], replace: true },
        targetAgents: ["main"],
        configuredModels: [
          { id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
          { id: "stale/model", name: "Stale model", contextWindow: 32_000 },
        ],
      },
      {
        id: "ollama",
        label: "Ollama",
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        configPath: "models.providers.ollama.models",
        filter: { manualIds: ["qwen3:latest"], replace: true },
        targetAgents: [],
        configuredModels: [
          { id: "qwen3:latest", name: "Qwen 3" },
        ],
      },
    ],
    agents: [
      { id: "main", hasModelAllowlist: true },
      { id: "worker", hasModelAllowlist: false },
    ],
  };
}

function fetchOutput(provider = "openrouter"): FetchModelsOutput {
  return {
    provider,
    fetchedAt: "2026-10-21T06:00:00.000Z",
    models:
      provider === "openrouter"
        ? openRouterModels
        : [{ id: "qwen3:latest", name: "Qwen 3" }],
  };
}

function applyPlan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
  return {
    fingerprint: "a".repeat(64),
    fetchedAt: "2026-10-21T06:00:00.000Z",
    fetchedCount: 3,
    addedIds: [],
    removedIds: ["stale/model"],
    protectedModels: [],
    selectedIds: openRouterModels.map((model) => model.id),
    unchangedCount: 1,
    ...overrides,
  };
}

function createHarness() {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  const container = document.createElement("div");
  document.body.append(container);
  const controller = new window.AbortController();
  const requests: { actionId: string; payload: unknown }[] = [];
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  handlers.set("providers.list", async () => providersOutput());
  handlers.set("models.fetch", async (payload) => {
    const provider = (payload as { provider: string }).provider;
    return fetchOutput(provider);
  });
  handlers.set("strategy.preview", async () => {
    const preview: PreviewApplyOutput = {
      provider: "openrouter",
      plan: applyPlan(),
      models: openRouterModels,
    };
    return preview;
  });
  handlers.set("strategy.apply", async () => ({
    provider: "openrouter",
    persisted: true,
    configPath: "/tmp/openclaw.json",
    fetchedAt: "2026-10-21T06:00:00.000Z",
    fetchedCount: 3,
    added: 1,
    unchanged: 1,
    removed: 1,
    selectedIds: openRouterModels.map((model) => model.id),
    targetAgents: ["main"],
    syncedAgents: ["main"],
    models: openRouterModels,
  }));

  const host = {
    apiVersion: 1,
    pluginId: "model-fetch",
    signal: controller.signal,
    basePath: "",
    locale: "zh-CN",
    redact: (text: string) => text,
    connection: {
      connected: true,
      canRead: true,
      canWrite: true,
      canGrant: false,
      canAdmin: false,
      assistantAgentId: null,
    },
    request: async (method: string, params?: Record<string, unknown>) => {
      expect(method).toBe("plugins.sessionAction");
      const actionId = String(params?.actionId);
      requests.push({ actionId, payload: params?.payload });
      const handler = handlers.get(actionId);
      if (!handler) return { ok: false, error: `missing ${actionId}` };
      try {
        return { ok: true, result: await handler(params?.payload) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    onEvent: () => () => undefined,
    subscribe: () => () => undefined,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
  } as unknown as ControlUiHost;
  const context = {
    host,
    signal: controller.signal,
    props: {},
    presented: true,
    mountDefault: () => () => undefined,
  } as ControlUiViewContext;

  return {
    window,
    document,
    container,
    context,
    controller,
    requests,
    handlers,
  };
}

async function mountReady(harness: ReturnType<typeof createHarness>) {
  const view = mountModelFetchSettings(harness.container, harness.context, {
    autoFetch: false,
  });
  await vi.waitFor(() => {
    expect(harness.container.querySelectorAll('[data-ref="providerSelect"] option')).toHaveLength(2);
  });
  return view;
}

function chooseProvider(
  harness: ReturnType<typeof createHarness>,
  providerId: string,
) {
  const select = harness.container.querySelector<HTMLSelectElement>(
    '[data-ref="providerSelect"]',
  )!;
  for (const option of select.options) {
    option.selected = option.value === providerId;
  }
  Object.defineProperty(select, "value", {
    configurable: true,
    value: providerId,
  });
  select.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
}

function selectedProviderId(harness: ReturnType<typeof createHarness>) {
  return [
    ...harness.container.querySelectorAll<HTMLOptionElement>(
      '[data-ref="providerSelect"] option',
    ),
  ].find((option) => option.selected)?.value;
}

function modelCheckbox(
  harness: ReturnType<typeof createHarness>,
  modelId: string,
) {
  return [...harness.container.querySelectorAll<HTMLTableRowElement>(".mf-table tbody tr")]
    .find(
      (row) =>
        row.querySelector(".mf-model-id")?.textContent === modelId,
    )
    ?.querySelector<HTMLInputElement>(".mf-model-check");
}

function modelBadge(harness: ReturnType<typeof createHarness>, modelId: string) {
  return [...harness.container.querySelectorAll<HTMLTableRowElement>(".mf-table tbody tr")].find(
    (row) => row.querySelector(".mf-model-id")?.textContent === modelId,
  )?.querySelector<HTMLElement>(".mf-badge");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model filter helpers", () => {
  it("applies regex and lets a manual whitelist override exclusions", () => {
    const analysis = analyzeModelFilter(openRouterModels, {
      includeRegex: "^openai/",
      excludeRegex: "embedding",
      manualIds: ["anthropic/claude"],
      replace: true,
    });
    expect([...analysis.selected]).toEqual([
      "openai/gpt-4o",
      "anthropic/claude",
    ]);
    expect(analysis.error).toBe("");
  });

  it("calculates replacement additions and removals per provider", () => {
    const changes = computeModelChanges(
      openRouterModels,
      [
        { id: "openai/gpt-4o", name: "GPT-4o" },
        { id: "stale/model", name: "Stale" },
      ],
      { includeRegex: "^openai/gpt", manualIds: [], replace: true },
    );
    expect(changes.addedIds).toEqual([]);
    expect(changes.removedIds).toEqual(["stale/model"]);
  });
});

describe("Model Fetch settings view", () => {
  it("renders one Provider selector and keeps remote fetch read-only", async () => {
    const harness = createHarness();
    await mountReady(harness);
    const select = harness.container.querySelector<HTMLSelectElement>(
      '[data-ref="providerSelect"]',
    )!;
    expect(select.options).toHaveLength(2);
    expect(select.value).toBe("openrouter");

    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="fetchButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(harness.container.querySelector('[data-ref="remoteCount"]')?.textContent).toBe("3");
    });
    expect(
      harness.requests.filter((request) => request.actionId === "models.fetch"),
    ).toHaveLength(1);
    expect(
      harness.requests.some(
        (request) =>
          request.actionId === "strategy.save" || request.actionId === "strategy.apply",
      ),
    ).toBe(false);
  });

  it("updates regex selection only on blur or Enter", async () => {
    const harness = createHarness();
    await mountReady(harness);
    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="fetchButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(harness.container.querySelector('[data-ref="selectedCount"]')?.textContent).toBe("3");
    });

    const include = harness.container.querySelector<HTMLInputElement>(
      '[data-ref="includeRegex"]',
    )!;
    include.value = "^anthropic/";
    include.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
    expect(harness.container.querySelector('[data-ref="selectedCount"]')?.textContent).toBe("3");

    include.dispatchEvent(new harness.window.Event("blur", { bubbles: false }));
    expect(harness.container.querySelector('[data-ref="selectedCount"]')?.textContent).toBe("1");
    expect(harness.container.querySelector('[data-ref="applyButton"]')?.hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("preserves independent unsaved drafts while switching Providers", async () => {
    const harness = createHarness();
    await mountReady(harness);
    const include = harness.container.querySelector<HTMLInputElement>(
      '[data-ref="includeRegex"]',
    )!;
    include.value = "^anthropic/";
    include.dispatchEvent(new harness.window.Event("blur", { bubbles: false }));
    expect(harness.container.querySelector<HTMLElement>('[data-ref="saveState"]')?.textContent).toContain(
      "未保存",
    );

    chooseProvider(harness, "ollama");
    await vi.waitFor(() => {
      expect(selectedProviderId(harness)).toBe("ollama");
    });
    expect(harness.container.querySelector<HTMLInputElement>('[data-ref="includeRegex"]')?.value).toBe(
      "",
    );

    chooseProvider(harness, "openrouter");
    await vi.waitFor(() => {
      expect(selectedProviderId(harness)).toBe("openrouter");
    });
    expect(harness.container.querySelector<HTMLInputElement>('[data-ref="includeRegex"]')?.value).toBe(
      "^anthropic/",
    );
    expect(harness.container.querySelector('[data-ref="saveState"]')?.textContent).toContain(
      "未保存",
    );
  });

  it("saves manual whitelist entries for the active Provider only", async () => {
    const harness = createHarness();
    let savedPayload: unknown;
    harness.handlers.set("strategy.save", async (payload) => {
      savedPayload = payload;
      return {
        provider: "openrouter",
        savedAt: "2026-10-21T06:00:00.000Z",
        configPath: "/tmp/openclaw.json",
        filter: (payload as { filter: unknown }).filter,
      };
    });
    await mountReady(harness);
    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="fetchButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(modelCheckbox(harness, "anthropic/claude")).toBeTruthy());

    const checkbox = modelCheckbox(harness, "anthropic/claude")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
    expect(harness.container.querySelector('[data-ref="whitelistCount"]')?.textContent).toBe("1");

    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="saveButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(savedPayload).toBeTruthy());
    expect(savedPayload).toMatchObject({
      provider: "openrouter",
      filter: {
        manualIds: ["anthropic/claude"],
        replace: true,
      },
      targetAgents: ["main"],
    });
  });

  it("lists the exact deletion set before applying replacement", async () => {
    const harness = createHarness();
    await mountReady(harness);
    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="applyButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(
        harness.requests.some((request) => request.actionId === "strategy.preview"),
      ).toBe(true);
    });
    const dialog = harness.container.querySelector<HTMLDialogElement>(
      '[data-ref="deleteDialog"]',
    )!;
    await vi.waitFor(() => expect(dialog.hasAttribute("open")).toBe(true));
    expect(
      [...harness.container.querySelectorAll("#mf-delete-title, [data-ref=deleteTitle]")].length,
    ).toBeGreaterThan(0);
    expect(
      harness.container.querySelector('[data-ref="deleteTitle"]')?.textContent,
    ).toBe("确认删除 1 个模型");
    expect(
      [...harness.container.querySelectorAll("[data-ref=deleteList] code")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["stale/model"]);
    expect(
      harness.requests.some((request) => request.actionId === "strategy.apply"),
    ).toBe(false);

    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="confirmDelete"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    await vi.waitFor(() => {
      const apply = harness.requests.find(
        (request) => request.actionId === "strategy.apply",
      );
      expect(apply?.payload).toMatchObject({
        provider: "openrouter",
        fingerprint: "a".repeat(64),
        expectedRemovals: ["stale/model"],
        targetAgents: ["main"],
      });
    });
  });

  it("keeps other Provider drafts after applying the active Provider", async () => {
    const harness = createHarness();
    await mountReady(harness);

    chooseProvider(harness, "ollama");
    await vi.waitFor(() => expect(selectedProviderId(harness)).toBe("ollama"));
    const include = harness.container.querySelector<HTMLInputElement>(
      '[data-ref="includeRegex"]',
    )!;
    include.value = "^qwen";
    include.dispatchEvent(new harness.window.Event("blur", { bubbles: false }));

    chooseProvider(harness, "openrouter");
    await vi.waitFor(() => expect(selectedProviderId(harness)).toBe("openrouter"));
    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="applyButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    await vi.waitFor(() =>
      expect(
        harness.container
          .querySelector<HTMLDialogElement>('[data-ref="deleteDialog"]')
          ?.hasAttribute("open"),
      ).toBe(true),
    );
    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="confirmDelete"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    await vi.waitFor(() =>
      expect(
        harness.requests.some((request) => request.actionId === "strategy.apply"),
      ).toBe(true),
    );

    chooseProvider(harness, "ollama");
    await vi.waitFor(() => expect(selectedProviderId(harness)).toBe("ollama"));
    expect(harness.container.querySelector<HTMLInputElement>('[data-ref="includeRegex"]')?.value).toBe(
      "^qwen",
    );
  });

  it("shows which references keep a model alive in the delete confirmation", async () => {
    const harness = createHarness();
    harness.handlers.set("strategy.preview", async () => {
      const preview: PreviewApplyOutput = {
        provider: "openrouter",
        plan: applyPlan({
          protectedModels: [
            {
              modelId: "stale/model",
              ref: "openrouter/stale/model",
              references: ["agents.defaults.utilityModel", "hooks.gmail.model"],
            },
          ],
        }),
        models: openRouterModels,
      };
      return preview;
    });
    await mountReady(harness);
    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="applyButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));

    const dialog = harness.container.querySelector<HTMLDialogElement>(
      '[data-ref="deleteDialog"]',
    )!;
    await vi.waitFor(() => expect(dialog.hasAttribute("open")).toBe(true));

    const referenceNote = harness.container.querySelector<HTMLElement>(
      '[data-ref="deleteRefs"]',
    )!;
    expect(referenceNote.hasAttribute("hidden")).toBe(false);
    expect(referenceNote.textContent).toContain("openrouter/stale/model");
    expect(referenceNote.textContent).toContain("agents.defaults.utilityModel");
    expect(referenceNote.textContent).toContain("hooks.gmail.model");
    expect(modelBadge(harness, "stale/model")?.textContent).toBe("引用保护");
    expect(modelBadge(harness, "stale/model")?.title).toContain("hooks.gmail.model");
  });

  it("blocks saving and applying when either regex is invalid", async () => {
    const harness = createHarness();
    await mountReady(harness);
    const include = harness.container.querySelector<HTMLInputElement>(
      '[data-ref="includeRegex"]',
    )!;
    include.value = "(";
    include.dispatchEvent(new harness.window.Event("blur", { bubbles: false }));

    expect(harness.container.querySelector('[data-ref="includeNote"]')?.textContent).toContain(
      "包含正则格式错误",
    );
    expect(
      harness.container.querySelector<HTMLButtonElement>('[data-ref="saveButton"]')?.disabled,
    ).toBe(true);
    expect(
      harness.container.querySelector<HTMLButtonElement>('[data-ref="applyButton"]')?.disabled,
    ).toBe(true);

    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="saveButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    harness.container
      .querySelector<HTMLButtonElement>('[data-ref="applyButton"]')!
      .dispatchEvent(new harness.window.Event("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      harness.requests.some(
        (request) =>
          request.actionId === "strategy.save" ||
          request.actionId === "strategy.apply" ||
          request.actionId === "strategy.preview",
      ),
    ).toBe(false);
  });
});

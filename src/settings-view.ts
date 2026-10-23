import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import type { ControlUiView, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { modelFetchContract } from "./contract.js";
import type {
  ApplyPlan,
  ApplyStrategyOutput,
  AgentSummary,
  FetchModelsOutput,
  ModelFilterConfig,
  ModelView,
  PreviewApplyOutput,
  ProviderSummary,
  ProtectedModel,
} from "./schemas.js";

type ModelRow = ModelView & {
  remote: boolean;
};

type DraftState = {
  filter: ModelFilterConfig;
  targetAgents: string[];
  dirty: boolean;
};

type RemoteState = {
  models: ModelView[];
  fetchedAt: string;
};

export type ModelFilterAnalysis = {
  selected: Set<string>;
  error: string;
};

export type ModelChanges = {
  selected: Set<string>;
  addedIds: string[];
  removedIds: string[];
};

const PAGE_MARKUP = `
  <div class="mf-page">
    <header class="mf-header">
      <div class="mf-heading">
        <p class="mf-eyebrow">模型发现与筛选</p>
        <h1 class="mf-title">Model Fetch</h1>
        <p class="mf-subhead">获取远端模型，按 Provider 独立保存筛选策略，再把确认后的模型列表写入 OpenClaw 配置。</p>
      </div>
      <div class="mf-provider-area">
        <label class="mf-provider-picker">
          <span>当前 Provider</span>
          <select class="mf-select" data-ref="providerSelect" aria-label="选择 Provider" disabled></select>
        </label>
        <span class="mf-connection" data-ref="connection">
          <span class="mf-connection-dot"></span>
          <span data-ref="connectionText">正在连接</span>
        </span>
        <code class="mf-config-path" data-ref="configPath">models.providers.&lt;providerId&gt;.models</code>
      </div>
    </header>

    <div class="mf-error" data-ref="error" role="alert" hidden>
      <span data-ref="errorText"></span>
      <button class="mf-button is-small" data-ref="retry" type="button">重试</button>
    </div>

    <section class="mf-summary" aria-label="模型统计">
      <div class="mf-stat">
        <span class="mf-stat-label">远端</span>
        <strong class="mf-stat-value" data-ref="remoteCount">0</strong>
        <small class="mf-stat-note" data-ref="fetchAge">尚未获取</small>
      </div>
      <div class="mf-stat">
        <span class="mf-stat-label">已选</span>
        <strong class="mf-stat-value" data-ref="selectedCount">0</strong>
        <small class="mf-stat-note">正则与白名单</small>
      </div>
      <div class="mf-stat">
        <span class="mf-stat-label">已配置</span>
        <strong class="mf-stat-value" data-ref="configuredCount">0</strong>
        <small class="mf-stat-note">当前 Provider</small>
      </div>
      <div class="mf-stat">
        <span class="mf-stat-label">变更</span>
        <strong class="mf-stat-value" data-ref="changeCount">0</strong>
        <small class="mf-stat-note" data-ref="changeDetail">新增 0 · 删除 0</small>
      </div>
      <div class="mf-summary-action">
        <button class="mf-button is-small" data-ref="fetchButton" type="button" disabled>获取远端模型</button>
      </div>
    </section>

    <section class="mf-panel" aria-labelledby="mf-strategy-title">
      <div class="mf-panel-head">
        <div>
          <h2 class="mf-panel-title" id="mf-strategy-title">筛选策略</h2>
          <p class="mf-panel-copy">策略按 Provider 独立保存。手动勾选会进入白名单，并覆盖正则排除结果；可指定同步到哪些 Agent 的模型 allowlist；正则失焦或按回车后更新结果。</p>
        </div>
        <div class="mf-panel-actions">
          <button class="mf-button is-small" data-ref="saveButton" type="button" disabled>保存策略</button>
        </div>
      </div>

      <div class="mf-filter-grid">
        <label class="mf-field">
          <span class="mf-field-label">包含正则 <code>includeRegex</code></span>
          <input class="mf-input" data-ref="includeRegex" type="text" spellcheck="false" placeholder="例如 ^(openai|anthropic)/">
          <span class="mf-field-note" data-ref="includeNote">留空时不按正则限制；若白名单也为空则选择全部模型。</span>
        </label>
        <label class="mf-field">
          <span class="mf-field-label">排除正则 <code>excludeRegex</code></span>
          <input class="mf-input" data-ref="excludeRegex" type="text" spellcheck="false" placeholder="例如 (embed|rerank)">
          <span class="mf-field-note" data-ref="excludeNote">白名单中的模型不会被排除。</span>
        </label>
      </div>

      <div class="mf-filter-lower">
        <div>
          <div class="mf-section-label">
            <span>白名单</span>
            <span class="mf-count" data-ref="whitelistCount">0</span>
          </div>
          <div class="mf-chip-box" data-ref="whitelistBox"></div>
        </div>
        <div class="mf-replace-note">
          <div>
            <strong>默认替换 Provider 模型列表</strong>
            应用时会删除未选中的已有模型；仍被 utility、媒体、voice、pdf、embeddedAgent 或 hooks 等配置引用的模型会自动保留。写入前会重新获取远端列表，并逐项校验确认的删除模型。
          </div>
        </div>
        <div>
          <div class="mf-section-label">
            <span>覆盖 Agent</span>
            <span class="mf-count" data-ref="agentTargetCount">0</span>
          </div>
          <div class="mf-agent-box" data-ref="agentTargets"></div>
        </div>
      </div>
    </section>

    <section class="mf-panel" aria-labelledby="mf-models-title">
      <div class="mf-panel-head">
        <div>
          <h2 class="mf-panel-title" id="mf-models-title">模型列表</h2>
          <p class="mf-panel-copy">勾选模型会写入白名单；取消勾选只移除白名单，不改变正则策略。</p>
        </div>
        <label class="mf-search-wrap">
          <span class="mf-visually-hidden">搜索模型</span>
          <span class="mf-search-icon" aria-hidden="true"></span>
          <input class="mf-search" data-ref="search" type="search" placeholder="搜索模型 ID 或名称">
        </label>
      </div>
      <div class="mf-table-wrap">
        <table class="mf-table">
          <thead>
            <tr>
              <th class="mf-check-cell">白名单</th>
              <th>模型 ID</th>
              <th>名称</th>
              <th>上下文</th>
              <th>筛选结果</th>
            </tr>
          </thead>
          <tbody data-ref="modelRows"></tbody>
        </table>
      </div>
      <div class="mf-empty" data-ref="empty" hidden>没有匹配的模型</div>
    </section>

    <footer class="mf-action-bar">
      <div class="mf-save-state" data-ref="saveState">正在读取 Provider 配置</div>
      <div class="mf-actions">
        <button class="mf-button is-primary" data-ref="applyButton" type="button" disabled>应用策略到配置</button>
      </div>
    </footer>

    <dialog class="mf-dialog" data-ref="deleteDialog" aria-labelledby="mf-delete-title">
      <div class="mf-dialog-head">
        <h3 id="mf-delete-title" data-ref="deleteTitle">确认删除模型</h3>
        <p data-ref="deleteDescription">应用后会替换当前 Provider 的模型列表。</p>
      </div>
      <div class="mf-dialog-body">
        <p>请确认要移除的模型：</p>
        <div class="mf-delete-list" data-ref="deleteList"></div>
        <div class="mf-reference-note" data-ref="deleteRefs" hidden></div>
      </div>
      <div class="mf-dialog-actions">
        <button class="mf-button" data-ref="cancelDelete" type="button">取消</button>
        <button class="mf-button is-danger" data-ref="confirmDelete" type="button">确认应用并删除</button>
      </div>
    </dialog>
  </div>
`;

function cloneFilter(filter: ModelFilterConfig): ModelFilterConfig {
  return {
    includeRegex: filter.includeRegex,
    excludeRegex: filter.excludeRegex,
    manualIds: [...(filter.manualIds ?? [])],
    replace: true,
  };
}

function normalizeAgentTargets(targetAgents: readonly string[] | undefined): string[] {
  if (!targetAgents || targetAgents.length === 0) return [];
  return [...new Set(targetAgents.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function manualIds(filter: ModelFilterConfig): Set<string> {
  return new Set(
    (filter.manualIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
  );
}

export function analyzeModelFilter(
  models: readonly ModelView[],
  filter: ModelFilterConfig,
): ModelFilterAnalysis {
  let include: RegExp | undefined;
  let exclude: RegExp | undefined;

  try {
    include = filter.includeRegex ? new RegExp(filter.includeRegex) : undefined;
  } catch (error) {
    return {
      selected: new Set(),
      error: `包含正则格式错误：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    exclude = filter.excludeRegex ? new RegExp(filter.excludeRegex) : undefined;
  } catch (error) {
    return {
      selected: new Set(),
      error: `排除正则格式错误：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const selected = new Set<string>();
  const whitelist = manualIds(filter);
  const manualOnly = !filter.includeRegex && whitelist.size > 0;
  for (const model of models) {
    const isManual = whitelist.has(model.id);
    if (manualOnly) {
      if (isManual) selected.add(model.id);
      continue;
    }
    const included = !include || include.test(model.id);
    const excluded = exclude ? exclude.test(model.id) : false;
    if (isManual || (included && !excluded)) selected.add(model.id);
  }
  return { selected, error: "" };
}

export function computeModelChanges(
  models: readonly ModelView[],
  configured: readonly ModelView[],
  filter: ModelFilterConfig,
): ModelChanges {
  const analysis = analyzeModelFilter(models, filter);
  const configuredIds = configured.map((model) => model.id);
  const configuredSet = new Set(configuredIds);
  const finalSelected = new Set(analysis.selected);
  for (const id of manualIds(filter)) {
    if (configuredSet.has(id)) finalSelected.add(id);
  }

  return {
    selected: finalSelected,
    addedIds: [...analysis.selected].filter((id) => !configuredSet.has(id)),
    removedIds: configuredIds.filter((id) => !finalSelected.has(id)),
  };
}

function combineModelRows(
  remoteModels: readonly ModelView[],
  configuredModels: readonly ModelView[],
): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const model of remoteModels) rows.set(model.id, { ...model, remote: true });
  for (const model of configuredModels) {
    if (!rows.has(model.id)) rows.set(model.id, { ...model, remote: false });
  }
  return [...rows.values()];
}

function formatContext(value: number | undefined): string {
  return value ? value.toLocaleString("zh-CN") : "-";
}

function formatAge(value: string | undefined): string {
  if (!value) return "尚未获取";
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "最近获取";
  const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1_000));
  if (seconds < 60) return "刚刚获取";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ModelFetchSettingsOptions = {
  autoFetch?: boolean;
};

export function mountModelFetchSettings(
  container: HTMLElement,
  context: ControlUiViewContext,
  options: ModelFetchSettingsOptions = {},
) {
  const document = container.ownerDocument;
  const feature = createFeatureClient(modelFetchContract, context.host);
  const drafts = new Map<string, DraftState>();
  const remotes = new Map<string, RemoteState>();
  let initialized = false;
  let disposed = false;
  let generation = 0;
  let providers: ProviderSummary[] = [];
  let agents: AgentSummary[] = [];
  let currentId = "";
  let search = "";
  let fetching = false;
  let saving = false;
  let previewing = false;
  let applying = false;
  let loading = true;
  let error = "";
  let notice = "";
  let pendingPlan: ApplyPlan | null = null;
  const protections = new Map<string, ProtectedModel[]>();

  container.replaceChildren();
  container.innerHTML = PAGE_MARKUP;
  const page = container.querySelector<HTMLElement>(".mf-page");
  if (!page) throw new Error("Model Fetch page failed to mount.");

  const refs = {
    providerSelect: page.querySelector<HTMLSelectElement>('[data-ref="providerSelect"]')!,
    connection: page.querySelector<HTMLElement>('[data-ref="connection"]')!,
    connectionText: page.querySelector<HTMLElement>('[data-ref="connectionText"]')!,
    configPath: page.querySelector<HTMLElement>('[data-ref="configPath"]')!,
    error: page.querySelector<HTMLElement>('[data-ref="error"]')!,
    errorText: page.querySelector<HTMLElement>('[data-ref="errorText"]')!,
    retry: page.querySelector<HTMLButtonElement>('[data-ref="retry"]')!,
    remoteCount: page.querySelector<HTMLElement>('[data-ref="remoteCount"]')!,
    fetchAge: page.querySelector<HTMLElement>('[data-ref="fetchAge"]')!,
    selectedCount: page.querySelector<HTMLElement>('[data-ref="selectedCount"]')!,
    configuredCount: page.querySelector<HTMLElement>('[data-ref="configuredCount"]')!,
    changeCount: page.querySelector<HTMLElement>('[data-ref="changeCount"]')!,
    changeDetail: page.querySelector<HTMLElement>('[data-ref="changeDetail"]')!,
    fetchButton: page.querySelector<HTMLButtonElement>('[data-ref="fetchButton"]')!,
    saveButton: page.querySelector<HTMLButtonElement>('[data-ref="saveButton"]')!,
    includeRegex: page.querySelector<HTMLInputElement>('[data-ref="includeRegex"]')!,
    excludeRegex: page.querySelector<HTMLInputElement>('[data-ref="excludeRegex"]')!,
    includeNote: page.querySelector<HTMLElement>('[data-ref="includeNote"]')!,
    excludeNote: page.querySelector<HTMLElement>('[data-ref="excludeNote"]')!,
    whitelistBox: page.querySelector<HTMLElement>('[data-ref="whitelistBox"]')!,
    whitelistCount: page.querySelector<HTMLElement>('[data-ref="whitelistCount"]')!,
    agentTargetCount: page.querySelector<HTMLElement>('[data-ref="agentTargetCount"]')!,
    agentTargets: page.querySelector<HTMLElement>('[data-ref="agentTargets"]')!,
    search: page.querySelector<HTMLInputElement>('[data-ref="search"]')!,
    modelRows: page.querySelector<HTMLTableSectionElement>('[data-ref="modelRows"]')!,
    empty: page.querySelector<HTMLElement>('[data-ref="empty"]')!,
    saveState: page.querySelector<HTMLElement>('[data-ref="saveState"]')!,
    applyButton: page.querySelector<HTMLButtonElement>('[data-ref="applyButton"]')!,
    deleteDialog: page.querySelector<HTMLDialogElement>('[data-ref="deleteDialog"]')!,
    deleteTitle: page.querySelector<HTMLElement>('[data-ref="deleteTitle"]')!,
    deleteDescription: page.querySelector<HTMLElement>('[data-ref="deleteDescription"]')!,
    deleteList: page.querySelector<HTMLElement>('[data-ref="deleteList"]')!,
    deleteRefs: page.querySelector<HTMLElement>('[data-ref="deleteRefs"]')!,
    cancelDelete: page.querySelector<HTMLButtonElement>('[data-ref="cancelDelete"]')!,
    confirmDelete: page.querySelector<HTMLButtonElement>('[data-ref="confirmDelete"]')!,
  };

  function selectedProvider(): ProviderSummary | undefined {
    return providers.find((provider) => provider.id === currentId);
  }

  function currentDraft(): DraftState | undefined {
    return drafts.get(currentId);
  }

  function setError(next: string) {
    error = next;
    notice = "";
  }

  function setNotice(next: string) {
    notice = next;
    error = "";
  }

  function renderConnection() {
    const connected = context.host.connection.connected;
    refs.connection.classList.toggle("is-offline", !connected);
    refs.connectionText.textContent = connected ? "Control UI 已连接" : "等待 Gateway 连接";
  }

  function renderProviderSelect() {
    refs.providerSelect.replaceChildren();
    for (const provider of providers) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      option.selected = provider.id === currentId;
      refs.providerSelect.append(option);
    }
    refs.providerSelect.disabled =
      providers.length === 0 || loading || fetching || saving || previewing || applying;
  }

  function updateRegexNotes(analysis: ModelFilterAnalysis) {
    const draft = currentDraft()?.filter;
    const includeError = analysis.error.startsWith("包含正则");
    const excludeError = analysis.error.startsWith("排除正则");
    refs.includeRegex.setAttribute("aria-invalid", String(includeError));
    refs.excludeRegex.setAttribute("aria-invalid", String(excludeError));
    refs.includeNote.textContent =
      includeError ? analysis.error : "留空时不按正则限制；若白名单也为空则选择全部模型。";
    refs.excludeNote.textContent =
      excludeError ? analysis.error : "白名单中的模型不会被排除。";
    refs.includeNote.classList.toggle("is-error", includeError);
    refs.excludeNote.classList.toggle("is-error", excludeError);
    if (draft) {
      if (document.activeElement !== refs.includeRegex) {
        refs.includeRegex.value = draft.includeRegex ?? "";
      }
      if (document.activeElement !== refs.excludeRegex) {
        refs.excludeRegex.value = draft.excludeRegex ?? "";
      }
    }
  }

  function renderWhitelist(draft: ModelFilterConfig) {
    refs.whitelistBox.replaceChildren();
    const ids = draft.manualIds ?? [];
    refs.whitelistCount.textContent = String(ids.length);
    if (ids.length === 0) {
      const empty = document.createElement("span");
      empty.className = "mf-chip-empty";
      empty.textContent = "尚未选择手动白名单模型";
      refs.whitelistBox.append(empty);
      return;
    }

    for (const id of ids) {
      const chip = document.createElement("span");
      chip.className = "mf-chip";
      const label = document.createElement("span");
      label.textContent = id;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `从白名单移除 ${id}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        const current = currentDraft();
        if (!current) return;
        current.filter = {
          ...current.filter,
          manualIds: (current.filter.manualIds ?? []).filter((item) => item !== id),
          replace: true,
        };
        current.dirty = true;
        notice = "";
        render();
      });
      chip.append(label, remove);
      refs.whitelistBox.append(chip);
    }
  }

  function renderAgentTargets(draft: DraftState | undefined) {
    refs.agentTargets.replaceChildren();
    const selected = new Set(draft?.targetAgents ?? []);
    refs.agentTargetCount.textContent = String(selected.size);

    if (agents.length === 0) {
      const empty = document.createElement("span");
      empty.className = "mf-chip-empty";
      empty.textContent = "未检测到可配置的 Agent";
      refs.agentTargets.append(empty);
      return;
    }

    for (const agent of agents) {
      const label = document.createElement("label");
      label.className = "mf-agent-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "mf-model-check";
      checkbox.checked = selected.has(agent.id);
      checkbox.disabled = loading || saving || previewing || applying;
      checkbox.setAttribute("aria-label", `覆盖 Agent ${agent.id} 的模型 allowlist`);
      checkbox.addEventListener("change", () => {
        const current = currentDraft();
        if (!current) return;
        const next = new Set(current.targetAgents);
        if (checkbox.checked) next.add(agent.id);
        else next.delete(agent.id);
        current.targetAgents = [...next].sort((left, right) => left.localeCompare(right));
        current.dirty = true;
        notice = "";
        render();
      });

      const text = document.createElement("span");
      const suffix = agent.hasModelAllowlist ? "" : "（未配置 allowlist）";
      text.textContent = `${agent.id}${suffix}`;

      label.append(checkbox, text);
      refs.agentTargets.append(label);
    }
  }

  function renderRows(
    rows: ModelRow[],
    selected: Set<string>,
    removedIds: string[],
    regexError: string,
    manualSet: Set<string>,
    protectedRefs: Map<string, string[]>,
  ) {
    refs.modelRows.replaceChildren();
    const normalizedSearch = search.trim().toLowerCase();
    const visible = rows.filter((model) => {
      if (!normalizedSearch) return true;
      return `${model.id} ${model.name}`.toLowerCase().includes(normalizedSearch);
    });
    refs.empty.hidden = visible.length !== 0;
    const removed = new Set(removedIds);
    const remote = remotes.get(currentId);

    for (const model of visible) {
      const row = document.createElement("tr");

      const checkCell = document.createElement("td");
      checkCell.className = "mf-check-cell";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "mf-model-check";
      checkbox.checked = manualSet.has(model.id);
      checkbox.disabled = !remote || fetching || loading;
      checkbox.setAttribute("aria-label", `将 ${model.id} 加入白名单`);
      checkbox.addEventListener("change", () => {
        const current = currentDraft();
        if (!current) return;
        const nextIds = new Set(current.filter.manualIds ?? []);
        if (checkbox.checked) nextIds.add(model.id);
        else nextIds.delete(model.id);
        current.filter = {
          ...current.filter,
          manualIds: [...nextIds],
          replace: true,
        };
        current.dirty = true;
        notice = "";
        render();
      });
      checkCell.append(checkbox);

      const idCell = document.createElement("td");
      idCell.className = "mf-model-id";
      idCell.textContent = model.id;

      const nameCell = document.createElement("td");
      nameCell.className = "mf-model-name";
      nameCell.textContent = model.remote ? model.name : `${model.name}（配置中，远端未返回）`;

      const contextCell = document.createElement("td");
      contextCell.className = "mf-model-context";
      contextCell.textContent = formatContext(model.contextWindow);

      const resultCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "mf-badge";
      if (regexError && model.remote) {
        badge.classList.add("is-removed");
        badge.textContent = "等待修正正则";
      } else if (protectedRefs.has(model.id)) {
        badge.classList.add("is-protected");
        badge.textContent = "引用保护";
        badge.title = `仍被以下配置引用，已保留：${(protectedRefs.get(model.id) ?? []).join("、")}`;
      } else if (removed.has(model.id)) {
        badge.classList.add("is-removed");
        badge.textContent = "将删除";
      } else if (manualSet.has(model.id)) {
        badge.classList.add("is-manual");
        badge.textContent = "白名单";
      } else if (selected.has(model.id)) {
        badge.classList.add("is-selected");
        badge.textContent = "已选择";
      } else {
        badge.classList.add("is-muted");
        badge.textContent = model.remote ? "未选中" : "已配置";
      }
      resultCell.append(badge);

      row.append(checkCell, idCell, nameCell, contextCell, resultCell);
      refs.modelRows.append(row);
    }
  }

  function updateButtons(draft: DraftState | undefined, regexError: string) {
    const connected = context.host.connection.connected;
    const hasProvider = Boolean(selectedProvider());
    refs.fetchButton.disabled =
      !connected || !hasProvider || loading || fetching || saving || previewing || applying;
    refs.fetchButton.textContent = fetching ? "正在获取..." : "获取远端模型";
    refs.saveButton.disabled =
      !connected ||
      !hasProvider ||
      !draft?.dirty ||
      Boolean(regexError) ||
      saving ||
      previewing ||
      applying;
    refs.applyButton.disabled =
      !connected ||
      !hasProvider ||
      loading ||
      !draft ||
      draft.dirty ||
      Boolean(regexError) ||
      fetching ||
      saving ||
      previewing ||
      applying;
    refs.applyButton.textContent = applying
      ? "正在应用..."
      : previewing
        ? "正在预览..."
        : "应用策略到配置";
    refs.confirmDelete.disabled = applying;
    refs.cancelDelete.disabled = applying;
  }

  function render() {
    const provider = selectedProvider();
    const draft = currentDraft();
    const remote = remotes.get(currentId);
    const filter = draft?.filter ?? provider?.filter ?? { replace: true };
    const remoteModels = remote?.models ?? [];
    const configuredModels = provider?.configuredModels ?? [];
    const analysis = analyzeModelFilter(remoteModels, filter);
    const changes = remote
      ? computeModelChanges(remoteModels, configuredModels, filter)
      : {
          selected: new Set<string>(),
          addedIds: [],
          removedIds: [],
        };
    const rows = combineModelRows(
      remoteModels.length > 0 ? remoteModels : configuredModels,
      configuredModels,
    );

    renderConnection();
    renderProviderSelect();
    refs.configPath.textContent = provider?.configPath ?? "models.providers.<providerId>.models";
    refs.remoteCount.textContent = String(remoteModels.length);
    refs.fetchAge.textContent = formatAge(remote?.fetchedAt);
    refs.selectedCount.textContent = String(changes.selected.size);
    refs.configuredCount.textContent = String(configuredModels.length);
    refs.changeCount.textContent = String(changes.addedIds.length + changes.removedIds.length);
    refs.changeDetail.textContent =
      `新增 ${changes.addedIds.length} · 删除 ${changes.removedIds.length}`;
    updateRegexNotes(analysis);
    renderWhitelist(filter);
    renderAgentTargets(draft);
    const protectedRefs = new Map<string, string[]>();
    for (const entry of protections.get(currentId) ?? []) {
      protectedRefs.set(entry.modelId, entry.references);
    }
    renderRows(
      rows,
      changes.selected,
      changes.removedIds,
      analysis.error,
      manualIds(filter),
      protectedRefs,
    );

    refs.error.hidden = !error;
    refs.errorText.textContent = error;
    refs.retry.hidden = !error;
    refs.saveState.classList.toggle("is-dirty", Boolean(draft?.dirty));
    if (!providers.length && !loading) {
      refs.saveState.textContent = "尚未配置任何可用的 Provider";
    } else if (loading) {
      refs.saveState.textContent = "正在读取 Provider 配置";
    } else if (analysis.error) {
      refs.saveState.textContent = "请修正正则表达式后再保存或应用";
    } else if (draft?.dirty) {
      refs.saveState.textContent = "有未保存的筛选策略，保存后才能应用";
    } else if (notice) {
      refs.saveState.textContent = notice;
    } else {
      refs.saveState.textContent = "策略已保存；应用时会重新获取远端模型并校验删除项";
    }
    updateButtons(draft, analysis.error);
  }

  async function refreshProviders(initializeDrafts: boolean) {
    const output = await feature.invoke("providers.list", {});
    if (context.signal.aborted || disposed) return;
    providers = output.providers;
    agents = output.agents;
    for (const provider of providers) {
      if (initializeDrafts || !drafts.has(provider.id)) {
        drafts.set(provider.id, {
          filter: cloneFilter(provider.filter),
          targetAgents: normalizeAgentTargets(provider.targetAgents),
          dirty: false,
        });
      }
    }
    if (!providers.some((provider) => provider.id === currentId)) {
      currentId = providers[0]?.id ?? "";
    }
  }

  async function fetchRemote() {
    const provider = selectedProvider();
    if (!provider || fetching || !context.host.connection.connected) return;
    const providerId = provider.id;
    const requestGeneration = ++generation;
    fetching = true;
    error = "";
    notice = "";
    render();
    try {
      const output: FetchModelsOutput = await feature.invoke("models.fetch", {
        provider: providerId,
      });
      if (disposed || context.signal.aborted || requestGeneration !== generation) return;
      remotes.set(providerId, {
        models: output.models,
        fetchedAt: output.fetchedAt,
      });
    } catch (cause) {
      if (requestGeneration === generation) setError(messageForError(cause));
    } finally {
      if (requestGeneration === generation) {
        fetching = false;
        loading = false;
        render();
      }
    }
  }

  async function initialize() {
    loading = true;
    error = "";
    render();
    try {
      await refreshProviders(true);
      loading = false;
      initialized = true;
      render();
      if (options.autoFetch !== false && currentId) await fetchRemote();
    } catch (cause) {
      loading = false;
      setError(messageForError(cause));
      render();
    }
  }

  async function switchProvider(providerId: string) {
    if (providerId === currentId) return;
    currentId = providerId;
    search = "";
    refs.search.value = "";
    error = "";
    notice = "";
    render();
    if (options.autoFetch !== false && !remotes.has(providerId)) await fetchRemote();
  }

  async function save() {
    const provider = selectedProvider();
    const draft = currentDraft();
    if (!provider || !draft || saving) return;
    if (analyzeModelFilter([], draft.filter).error) return;
    saving = true;
    error = "";
    notice = "";
    render();
    try {
      const output = await feature.invoke("strategy.save", {
        provider: provider.id,
        filter: { ...draft.filter, replace: true },
        targetAgents: draft.targetAgents,
      });
      if (disposed || context.signal.aborted) return;
      provider.filter = cloneFilter(output.filter);
      provider.targetAgents = normalizeAgentTargets(output.targetAgents);
      drafts.set(provider.id, {
        filter: cloneFilter(output.filter),
        targetAgents: normalizeAgentTargets(output.targetAgents),
        dirty: false,
      });
      setNotice(`${provider.label} 的筛选策略已保存`);
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      saving = false;
      render();
    }
  }

  function openDeleteDialog() {
    if (typeof refs.deleteDialog.showModal === "function") {
      if (!refs.deleteDialog.open) refs.deleteDialog.showModal();
    } else {
      refs.deleteDialog.setAttribute("open", "");
    }
  }

  function closeDeleteDialog() {
    if (applying) return;
    pendingPlan = null;
    if (typeof refs.deleteDialog.close === "function" && refs.deleteDialog.open) {
      refs.deleteDialog.close();
    } else {
      refs.deleteDialog.removeAttribute("open");
    }
  }

  function renderDeleteReferences(entries: ProtectedModel[]) {
    refs.deleteRefs.replaceChildren();
    refs.deleteRefs.hidden = entries.length === 0;
    if (entries.length === 0) return;

    const heading = document.createElement("p");
    heading.textContent = `以下 ${entries.length} 个模型仍被配置引用，将保留在列表中：`;
    refs.deleteRefs.append(heading);

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "mf-reference-item";
      const ref = document.createElement("code");
      ref.textContent = entry.ref;
      const paths = document.createElement("span");
      paths.textContent = entry.references.join("、");
      row.append(ref, paths);
      refs.deleteRefs.append(row);
    }
  }

  async function applyPlan(provider: ProviderSummary, plan: ApplyPlan) {
    if (applying) return;
    const draft = currentDraft();
    if (!draft) return;
    applying = true;
    error = "";
    render();
    try {
      const output: ApplyStrategyOutput & { protectedModels?: ProtectedModel[] } =
        await feature.invoke("strategy.apply", {
          provider: provider.id,
          fingerprint: plan.fingerprint,
          expectedRemovals: plan.removedIds,
          targetAgents: draft.targetAgents,
        }, {
          sessionKey: context.host.sessions.selectedKey || undefined,
        });
      if (disposed || context.signal.aborted) return;
      remotes.set(provider.id, {
        models: output.models,
        fetchedAt: output.fetchedAt,
      });
      const protectedModels = output.protectedModels ?? [];
      protections.set(provider.id, protectedModels);
      await refreshProviders(false);
      const syncedSuffix =
        output.syncedAgents.length > 0
          ? `；同步 Agent：${output.syncedAgents.join(", ")}`
          : output.targetAgents.length > 0
            ? "；目标 Agent 未更新（可能未配置 allowlist）"
            : "";
      const protectedSuffix =
        protectedModels.length > 0
          ? `；引用保护保留 ${protectedModels.length} 个模型`
          : "";
      const sessionSuffix =
        output.sessionSelectionReset ? "；当前会话已回落到默认模型" : "";
      setNotice(
        `已将 ${output.selectedIds.length} 个模型写入 ${provider.label}，新增 ${output.added}，删除 ${output.removed}${syncedSuffix}${protectedSuffix}${sessionSuffix}`,
      );
      pendingPlan = null;
      if (typeof refs.deleteDialog.close === "function" && refs.deleteDialog.open) {
        refs.deleteDialog.close();
      } else {
        refs.deleteDialog.removeAttribute("open");
      }
    } catch (cause) {
      setError(messageForError(cause));
      pendingPlan = null;
      if (typeof refs.deleteDialog.close === "function" && refs.deleteDialog.open) {
        refs.deleteDialog.close();
      } else {
        refs.deleteDialog.removeAttribute("open");
      }
    } finally {
      applying = false;
      render();
    }
  }

  async function previewAndApply() {
    const provider = selectedProvider();
    const draft = currentDraft();
    if (!provider || !draft || draft.dirty || previewing || applying) return;
    if (analyzeModelFilter([], draft.filter).error) return;
    previewing = true;
    error = "";
    notice = "";
    render();
    try {
      const output: PreviewApplyOutput & { protectedModels?: ProtectedModel[] } =
        await feature.invoke("strategy.preview", {
          provider: provider.id,
        });
      if (disposed || context.signal.aborted) return;
      remotes.set(provider.id, {
        models: output.models,
        fetchedAt: output.plan.fetchedAt,
      });
      pendingPlan = output.plan;
      const protectedModels = output.plan.protectedModels ?? [];
      protections.set(provider.id, protectedModels);
      previewing = false;
      render();

      if (output.plan.removedIds.length === 0) {
        await applyPlan(provider, output.plan);
        return;
      }

      refs.deleteTitle.textContent = `确认删除 ${output.plan.removedIds.length} 个模型`;
      refs.deleteDescription.textContent =
        `应用后，${provider.label} 配置中的以下模型将被移除。`;
      refs.deleteList.replaceChildren();
      for (const id of output.plan.removedIds) {
        const code = document.createElement("code");
        code.textContent = id;
        refs.deleteList.append(code);
      }
      renderDeleteReferences(protectedModels);
      openDeleteDialog();
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      previewing = false;
      render();
    }
  }

  function commitRegex(input: HTMLInputElement, key: "includeRegex" | "excludeRegex") {
    const current = currentDraft();
    if (!current || current.filter[key] === input.value) return;
    current.filter = {
      ...current.filter,
      [key]: input.value,
      replace: true,
    };
    current.dirty = true;
    notice = "";
    render();
  }

  function handleRegexKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    (event.currentTarget as HTMLInputElement).blur();
  }

  refs.includeRegex.addEventListener("blur", () =>
    commitRegex(refs.includeRegex, "includeRegex"),
  );
  refs.excludeRegex.addEventListener("blur", () =>
    commitRegex(refs.excludeRegex, "excludeRegex"),
  );
  refs.includeRegex.addEventListener("keydown", handleRegexKeydown);
  refs.excludeRegex.addEventListener("keydown", handleRegexKeydown);
  refs.search.addEventListener("input", () => {
    search = refs.search.value;
    render();
  });
  refs.providerSelect.addEventListener("change", () => {
    void switchProvider(refs.providerSelect.value);
  });
  refs.fetchButton.addEventListener("click", () => {
    void fetchRemote();
  });
  refs.saveButton.addEventListener("click", () => {
    void save();
  });
  refs.applyButton.addEventListener("click", () => {
    void previewAndApply();
  });
  refs.cancelDelete.addEventListener("click", closeDeleteDialog);
  refs.confirmDelete.addEventListener("click", () => {
    const provider = selectedProvider();
    if (provider && pendingPlan) void applyPlan(provider, pendingPlan);
  });
  refs.retry.addEventListener("click", () => {
    if (!initialized) void initialize();
    else void fetchRemote();
  });

  const unsubscribe = context.host.subscribe(render);
  const abort = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    unsubscribe();
    if (typeof refs.deleteDialog.close === "function" && refs.deleteDialog.open) {
      refs.deleteDialog.close();
    }
  };
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  else void initialize();

  return {
    update: render,
    focus: () => refs.providerSelect.focus(),
    dispose: abort,
  };
}

export const modelFetchSettingsView: ControlUiView = (container, context) =>
  mountModelFetchSettings(container, context);

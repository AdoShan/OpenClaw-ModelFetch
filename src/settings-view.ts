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

export type AffectedSession = {
  sessionKey: string;
  agentId: string;
  label: string;
};

type ApplyPlanWithSessions = ApplyPlan & {
  affectedSessions?: AffectedSession[];
};

type ApplyOutputWithSessions = ApplyStrategyOutput & {
  sessionSelectionResets?: number;
  resetSessionKeys?: string[];
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

export type InterfaceLanguage = "zh" | "en";

type InterfaceMessages = {
  eyebrow: string;
  subhead: string;
  provider: string;
  chooseProvider: string;
  connecting: string;
  connected: string;
  waitingConnection: string;
  retry: string;
  summaryLabel: string;
  remote: string;
  selected: string;
  configured: string;
  changes: string;
  notFetched: string;
  recent: string;
  justNow: string;
  minutesAgo: (count: number) => string;
  hoursAgo: (count: number) => string;
  daysAgo: (count: number) => string;
  addedShort: string;
  removedShort: string;
  fetchModels: string;
  fetchingModels: string;
  strategyTitle: string;
  strategyCopy: string;
  saveStrategy: string;
  includeRegex: string;
  excludeRegex: string;
  includePlaceholder: string;
  excludePlaceholder: string;
  includeNote: string;
  excludeNote: string;
  includeError: (message: string) => string;
  excludeError: (message: string) => string;
  whitelist: string;
  whitelistEmpty: string;
  removeWhitelist: (id: string) => string;
  replaceTitle: string;
  replaceCopy: string;
  overrideAgents: string;
  noAgents: string;
  overrideAgent: (id: string) => string;
  noAllowlist: string;
  modelsTitle: string;
  modelsCopy: string;
  searchLabel: string;
  searchPlaceholder: string;
  tableWhitelist: string;
  tableModelId: string;
  tableModelName: string;
  tableContext: string;
  tableResult: string;
  configuredOnly: (name: string) => string;
  noMatches: string;
  waitForRegex: string;
  referenceProtected: string;
  referenceProtectedTitle: (paths: string[]) => string;
  willDelete: string;
  whitelistBadge: string;
  selectedBadge: string;
  unselected: string;
  configuredBadge: string;
  addToWhitelist: (id: string) => string;
  readingProvider: string;
  noProviders: string;
  fixRegex: string;
  unsavedStrategy: string;
  savedStrategy: string;
  applyingModels: string;
  previewingModels: string;
  applyStrategy: string;
  deleteTitle: (count: number) => string;
  deleteDescriptionBase: string;
  deleteDescriptionProvider: (provider: string) => string;
  confirmRemove: string;
  cancel: string;
  confirmApply: string;
  savedNotice: (provider: string) => string;
  referenceNote: (count: number) => string;
  sessionNote: (count: number) => string;
  applyNotice: (
    count: number,
    provider: string,
    added: number,
    removed: number,
    suffix: string,
  ) => string;
  syncedAgents: (agents: string[]) => string;
  targetAgentsNotUpdated: string;
  protectedCount: (count: number) => string;
  resetSessions: (count: number) => string;
};

const ENGLISH_MESSAGES: InterfaceMessages = {
  eyebrow: "Model discovery and filtering",
  subhead:
    "Fetch remote models, save an independent strategy per Provider, then write the confirmed model list into OpenClaw config.",
  provider: "Current provider",
  chooseProvider: "Choose provider",
  connecting: "Connecting",
  connected: "Control UI connected",
  waitingConnection: "Waiting for Gateway connection",
  retry: "Retry",
  summaryLabel: "Model summary",
  remote: "Remote",
  selected: "Selected",
  configured: "Configured",
  changes: "Changes",
  notFetched: "Not fetched",
  recent: "Recently fetched",
  justNow: "Fetched just now",
  minutesAgo: (count) => `Fetched ${count} minutes ago`,
  hoursAgo: (count) => `Fetched ${count} hours ago`,
  daysAgo: (count) => `Fetched ${count} days ago`,
  addedShort: "added",
  removedShort: "removed",
  fetchModels: "Fetch remote models",
  fetchingModels: "Fetching...",
  strategyTitle: "Filter strategy",
  strategyCopy:
    "Strategies are saved independently per Provider. Manually selected models enter the whitelist and override regex exclusions; you can also choose which agent model allowlists to sync. Regex results update on blur or Enter.",
  saveStrategy: "Save strategy",
  includeRegex: "Include regex",
  excludeRegex: "Exclude regex",
  includePlaceholder: "For example, ^(openai|anthropic)/",
  excludePlaceholder: "For example, (embed|rerank)",
  includeNote:
    "Leave empty for no include restriction; if the whitelist is also empty, all models are selected.",
  excludeNote: "Whitelisted models are never excluded.",
  includeError: (message) => `Invalid include regex: ${message}`,
  excludeError: (message) => `Invalid exclude regex: ${message}`,
  whitelist: "Whitelist",
  whitelistEmpty: "No manually selected models",
  removeWhitelist: (id) => `Remove ${id} from the whitelist`,
  replaceTitle: "Replaces the provider model list by default",
  replaceCopy:
    "Applying removes unselected existing models; models still referenced by utility, media, voice, PDF, embedded-agent or hooks config are retained automatically. The remote list is fetched again before writing, and every confirmed deletion is rechecked.",
  overrideAgents: "Override agents",
  noAgents: "No configurable agents detected",
  overrideAgent: (id) => `Override agent ${id} model allowlist`,
  noAllowlist: " (no allowlist configured)",
  modelsTitle: "Model list",
  modelsCopy:
    "Selecting a model adds it to the whitelist; deselecting only removes the whitelist entry and does not change the regex strategy.",
  searchLabel: "Search models",
  searchPlaceholder: "Search model ID or name",
  tableWhitelist: "Whitelist",
  tableModelId: "Model ID",
  tableModelName: "Name",
  tableContext: "Context",
  tableResult: "Filter result",
  configuredOnly: (name) => `${name} (configured; not returned remotely)`,
  noMatches: "No matching models",
  waitForRegex: "Waiting for a valid regex",
  referenceProtected: "Reference protected",
  referenceProtectedTitle: (paths) =>
    `Retained because these config paths still reference it: ${paths.join(", ")}`,
  willDelete: "Will delete",
  whitelistBadge: "Whitelist",
  selectedBadge: "Selected",
  unselected: "Unselected",
  configuredBadge: "Configured",
  addToWhitelist: (id) => `Add ${id} to the whitelist`,
  readingProvider: "Reading provider configuration",
  noProviders: "No configurable providers found",
  fixRegex: "Fix the regex before saving or applying",
  unsavedStrategy: "Unsaved strategy; save it before applying",
  savedStrategy: "Strategy saved; applying fetches remote models again and validates deletions",
  applyingModels: "Applying...",
  previewingModels: "Previewing...",
  applyStrategy: "Apply strategy to config",
  deleteTitle: (count) => `Confirm deleting ${count} models`,
  deleteDescriptionBase: "Applying replaces this provider's model list.",
  deleteDescriptionProvider: (provider) =>
    `After applying, these models in ${provider} will be removed from configuration.`,
  confirmRemove: "Confirm the models to remove:",
  cancel: "Cancel",
  confirmApply: "Confirm apply and delete",
  savedNotice: (provider) => `Filter strategy for ${provider} saved`,
  referenceNote: (count) =>
    `These ${count} models remain in the list because other configuration references them:`,
  sessionNote: (count) =>
    `Affected sessions: the following ${count} sessions will fall back to the default model after applying.`,
  applyNotice: (count, provider, added, removed, suffix) =>
    `Wrote ${count} models to ${provider}, added ${added}, removed ${removed}${suffix}`,
  syncedAgents: (agents) => `; synced agents: ${agents.join(", ")}`,
  targetAgentsNotUpdated: "; target agents were not updated (they may have no allowlist)",
  protectedCount: (count) => `; reference protection retained ${count} models`,
  resetSessions: (count) => `; reset ${count} sessions to the default model`,
};

const CHINESE_MESSAGES: InterfaceMessages = {
  eyebrow: "模型发现与筛选",
  subhead:
    "获取远端模型，按 Provider 独立保存筛选策略，再把确认后的模型列表写入 OpenClaw 配置。",
  provider: "当前 Provider",
  chooseProvider: "选择 Provider",
  connecting: "正在连接",
  connected: "Control UI 已连接",
  waitingConnection: "等待 Gateway 连接",
  retry: "重试",
  summaryLabel: "模型统计",
  remote: "远端",
  selected: "已选",
  configured: "已配置",
  changes: "变更",
  notFetched: "尚未获取",
  recent: "最近获取",
  justNow: "刚刚获取",
  minutesAgo: (count) => `${count} 分钟前`,
  hoursAgo: (count) => `${count} 小时前`,
  daysAgo: (count) => `${count} 天前`,
  addedShort: "新增",
  removedShort: "删除",
  fetchModels: "获取远端模型",
  fetchingModels: "正在获取...",
  strategyTitle: "筛选策略",
  strategyCopy:
    "策略按 Provider 独立保存。手动勾选会进入白名单，并覆盖正则排除结果；可指定同步到哪些 Agent 的模型 allowlist；正则失焦或按回车后更新结果。",
  saveStrategy: "保存策略",
  includeRegex: "包含正则",
  excludeRegex: "排除正则",
  includePlaceholder: "例如 ^(openai|anthropic)/",
  excludePlaceholder: "例如 (embed|rerank)",
  includeNote: "留空时不按正则限制；若白名单也为空则选择全部模型。",
  excludeNote: "白名单中的模型不会被排除。",
  includeError: (message) => `包含正则格式错误：${message}`,
  excludeError: (message) => `排除正则格式错误：${message}`,
  whitelist: "白名单",
  whitelistEmpty: "尚未选择手动白名单模型",
  removeWhitelist: (id) => `从白名单移除 ${id}`,
  replaceTitle: "默认替换 Provider 模型列表",
  replaceCopy:
    "应用时会删除未选中的已有模型；仍被 utility、媒体、voice、pdf、embeddedAgent 或 hooks 等配置引用的模型会自动保留。写入前会重新获取远端列表，并逐项校验确认的删除模型。",
  overrideAgents: "覆盖 Agent",
  noAgents: "未检测到可配置的 Agent",
  overrideAgent: (id) => `覆盖 Agent ${id} 的模型 allowlist`,
  noAllowlist: "（未配置 allowlist）",
  modelsTitle: "模型列表",
  modelsCopy: "勾选模型会写入白名单；取消勾选只移除白名单，不改变正则策略。",
  searchLabel: "搜索模型",
  searchPlaceholder: "搜索模型 ID 或名称",
  tableWhitelist: "白名单",
  tableModelId: "模型 ID",
  tableModelName: "名称",
  tableContext: "上下文",
  tableResult: "筛选结果",
  configuredOnly: (name) => `${name}（配置中，远端未返回）`,
  noMatches: "没有匹配的模型",
  waitForRegex: "等待修正正则",
  referenceProtected: "引用保护",
  referenceProtectedTitle: (paths) => `仍被以下配置引用，已保留：${paths.join("、")}`,
  willDelete: "将删除",
  whitelistBadge: "白名单",
  selectedBadge: "已选择",
  unselected: "未选中",
  configuredBadge: "已配置",
  addToWhitelist: (id) => `将 ${id} 加入白名单`,
  readingProvider: "正在读取 Provider 配置",
  noProviders: "尚未配置任何可用的 Provider",
  fixRegex: "请修正正则表达式后再保存或应用",
  unsavedStrategy: "有未保存的筛选策略，保存后才能应用",
  savedStrategy: "策略已保存；应用时会重新获取远端模型并校验删除项",
  applyingModels: "正在应用...",
  previewingModels: "正在预览...",
  applyStrategy: "应用策略到配置",
  deleteTitle: (count) => `确认删除 ${count} 个模型`,
  deleteDescriptionBase: "应用后会替换当前 Provider 的模型列表。",
  deleteDescriptionProvider: (provider) => `应用后，${provider} 配置中的以下模型将被移除。`,
  confirmRemove: "请确认要移除的模型：",
  cancel: "取消",
  confirmApply: "确认应用并删除",
  savedNotice: (provider) => `${provider} 的筛选策略已保存`,
  referenceNote: (count) => `以下 ${count} 个模型仍被配置引用，将保留在列表中：`,
  sessionNote: (count) => `受影响会话：应用后以下 ${count} 个会话会回落到默认模型。`,
  applyNotice: (count, provider, added, removed, suffix) =>
    `已将 ${count} 个模型写入 ${provider}，新增 ${added}，删除 ${removed}${suffix}`,
  syncedAgents: (agents) => `；同步 Agent：${agents.join(", ")}`,
  targetAgentsNotUpdated: "；目标 Agent 未更新（可能未配置 allowlist）",
  protectedCount: (count) => `；引用保护保留 ${count} 个模型`,
  resetSessions: (count) => `；已回落 ${count} 个会话到默认模型`,
};

function messagesFor(language: InterfaceLanguage): InterfaceMessages {
  return language === "en" ? ENGLISH_MESSAGES : CHINESE_MESSAGES;
}

function interfaceLanguage(locale: string | undefined): InterfaceLanguage {
  return locale?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const BACKEND_ERROR_TRANSLATIONS: ReadonlyArray<[RegExp, string]> = [
  [
    /^模型列表或筛选策略已变化，请重新预览后再确认应用。$/,
    "The model list or filter strategy changed. Preview again before applying.",
  ],
  [
    /^待删除模型与确认列表不一致，已取消写入。请重新预览。$/,
    "The deletion list no longer matches the confirmed list; the write was canceled. Preview again.",
  ],
  [
    /^Provider 配置在确认后发生变化，已取消写入。请重新预览。$/,
    "Provider configuration changed after confirmation; the write was canceled. Preview again.",
  ],
  [
    /^Provider 筛选策略在确认后发生变化，已取消写入。请重新预览。$/,
    "Provider filter strategy changed after confirmation; the write was canceled. Preview again.",
  ],
  [
    /^模型引用在确认后发生变化，已取消写入。请重新预览。$/,
    "Model references changed after confirmation; the write was canceled. Preview again.",
  ],
];

function translateBackendError(message: string, language: InterfaceLanguage): string {
  if (language === "zh") return message;
  for (const [pattern, translation] of BACKEND_ERROR_TRANSLATIONS) {
    if (pattern.test(message)) return translation;
  }
  return message;
}

const PAGE_MARKUP = `
  <div class="mf-page">
    <header class="mf-header">
      <div class="mf-heading">
        <p class="mf-eyebrow" data-i18n="eyebrow">模型发现与筛选</p>
        <h1 class="mf-title">Model Fetch</h1>
        <p class="mf-subhead" data-i18n="subhead">获取远端模型，按 Provider 独立保存筛选策略，再把确认后的模型列表写入 OpenClaw 配置。</p>
      </div>
      <div class="mf-provider-area">
        <label class="mf-provider-picker">
          <span data-i18n="provider">当前 Provider</span>
          <select class="mf-select" data-ref="providerSelect" disabled></select>
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
      <button class="mf-button is-small" data-ref="retry" type="button" data-i18n="retry">重试</button>
    </div>

    <section class="mf-summary">
      <div class="mf-stat">
        <span class="mf-stat-label" data-i18n="remote">远端</span>
        <strong class="mf-stat-value" data-ref="remoteCount">0</strong>
        <small class="mf-stat-note" data-ref="fetchAge"></small>
      </div>
      <div class="mf-stat">
        <span class="mf-stat-label" data-i18n="selected">已选</span>
        <strong class="mf-stat-value" data-ref="selectedCount">0</strong>
        <small class="mf-stat-note" data-i18n="strategyTitle">正则与白名单</small>
      </div>
      <div class="mf-stat">
        <span class="mf-stat-label" data-i18n="configured">已配置</span>
        <strong class="mf-stat-value" data-ref="configuredCount">0</strong>
        <small class="mf-stat-note" data-i18n="provider">当前 Provider</small>
      </div>
      <div class="mf-stat">
        <span class="mf-stat-label" data-i18n="changes">变更</span>
        <strong class="mf-stat-value" data-ref="changeCount">0</strong>
        <small class="mf-stat-note" data-ref="changeDetail"></small>
      </div>
      <div class="mf-summary-action">
        <button class="mf-button is-small" data-ref="fetchButton" type="button" disabled data-i18n="fetchModels">获取远端模型</button>
      </div>
    </section>

    <section class="mf-panel" aria-labelledby="mf-strategy-title">
      <div class="mf-panel-head">
        <div>
          <h2 class="mf-panel-title" id="mf-strategy-title" data-i18n="strategyTitle">筛选策略</h2>
          <p class="mf-panel-copy" data-i18n="strategyCopy">策略按 Provider 独立保存。手动勾选会进入白名单，并覆盖正则排除结果；可指定同步到哪些 Agent 的模型 allowlist；正则失焦或按回车后更新结果。</p>
        </div>
        <div class="mf-panel-actions">
          <button class="mf-button is-small" data-ref="saveButton" type="button" disabled data-i18n="saveStrategy">保存策略</button>
        </div>
      </div>

      <div class="mf-filter-grid">
        <label class="mf-field">
          <span class="mf-field-label"><span data-i18n="includeRegex">包含正则</span> <code>includeRegex</code></span>
          <input class="mf-input" data-ref="includeRegex" type="text" spellcheck="false" placeholder="例如 ^(openai|anthropic)/" data-i18n-placeholder="includePlaceholder">
          <span class="mf-field-note" data-ref="includeNote">留空时不按正则限制；若白名单也为空则选择全部模型。</span>
        </label>
        <label class="mf-field">
          <span class="mf-field-label"><span data-i18n="excludeRegex">排除正则</span> <code>excludeRegex</code></span>
          <input class="mf-input" data-ref="excludeRegex" type="text" spellcheck="false" placeholder="例如 (embed|rerank)" data-i18n-placeholder="excludePlaceholder">
          <span class="mf-field-note" data-ref="excludeNote">白名单中的模型不会被排除。</span>
        </label>
      </div>

      <div class="mf-filter-lower">
        <div>
          <div class="mf-section-label">
            <span data-i18n="whitelist">白名单</span>
            <span class="mf-count" data-ref="whitelistCount">0</span>
          </div>
          <div class="mf-chip-box" data-ref="whitelistBox"></div>
        </div>
        <div class="mf-replace-note">
          <div>
            <strong data-i18n="replaceTitle">默认替换 Provider 模型列表</strong>
            <span data-i18n="replaceCopy">应用时会删除未选中的已有模型；仍被 utility、媒体、voice、pdf、embeddedAgent 或 hooks 等配置引用的模型会自动保留。写入前会重新获取远端列表，并逐项校验确认的删除模型。</span>
          </div>
        </div>
        <div>
          <div class="mf-section-label">
            <span data-i18n="overrideAgents">覆盖 Agent</span>
            <span class="mf-count" data-ref="agentTargetCount">0</span>
          </div>
          <div class="mf-agent-box" data-ref="agentTargets"></div>
        </div>
      </div>
    </section>

    <section class="mf-panel" aria-labelledby="mf-models-title">
      <div class="mf-panel-head">
        <div>
          <h2 class="mf-panel-title" id="mf-models-title" data-i18n="modelsTitle">模型列表</h2>
          <p class="mf-panel-copy" data-i18n="modelsCopy">勾选模型会写入白名单；取消勾选只移除白名单，不改变正则策略。</p>
        </div>
        <label class="mf-search-wrap">
          <span class="mf-visually-hidden" data-i18n="searchLabel">搜索模型</span>
          <span class="mf-search-icon" aria-hidden="true"></span>
          <input class="mf-search" data-ref="search" type="search" placeholder="搜索模型 ID 或名称" data-i18n-placeholder="searchPlaceholder">
        </label>
      </div>
      <div class="mf-table-wrap">
        <table class="mf-table">
          <thead>
            <tr>
              <th class="mf-check-cell" data-i18n="tableWhitelist">白名单</th>
              <th data-i18n="tableModelId">模型 ID</th>
              <th data-i18n="tableModelName">名称</th>
              <th data-i18n="tableContext">上下文</th>
              <th data-i18n="tableResult">筛选结果</th>
            </tr>
          </thead>
          <tbody data-ref="modelRows"></tbody>
        </table>
      </div>
      <div class="mf-empty" data-ref="empty" hidden></div>
    </section>

    <footer class="mf-action-bar">
      <div class="mf-save-state" data-ref="saveState"></div>
      <div class="mf-actions">
        <button class="mf-button is-primary" data-ref="applyButton" type="button" disabled data-i18n="applyStrategy">应用策略到配置</button>
      </div>
    </footer>

    <dialog class="mf-dialog" data-ref="deleteDialog" aria-labelledby="mf-delete-title">
      <div class="mf-dialog-head">
        <h3 id="mf-delete-title" data-ref="deleteTitle">确认删除模型</h3>
        <p data-ref="deleteDescription"></p>
      </div>
      <div class="mf-dialog-body">
        <p data-i18n="confirmRemove">请确认要移除的模型：</p>
        <div class="mf-delete-list" data-ref="deleteList"></div>
        <div class="mf-reference-note" data-ref="deleteRefs" hidden></div>
        <div class="mf-reference-note" data-ref="sessionImpact" hidden>
          <p data-ref="sessionImpactTitle"></p>
          <div data-ref="sessionImpactList"></div>
        </div>
      </div>
      <div class="mf-dialog-actions">
        <button class="mf-button" data-ref="cancelDelete" type="button" data-i18n="cancel">取消</button>
        <button class="mf-button is-danger" data-ref="confirmDelete" type="button" data-i18n="confirmApply">确认应用并删除</button>
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
  language: InterfaceLanguage = "zh",
): ModelFilterAnalysis {
  let include: RegExp | undefined;
  let exclude: RegExp | undefined;

  try {
    include = filter.includeRegex ? new RegExp(filter.includeRegex) : undefined;
  } catch (error) {
    return {
      selected: new Set(),
      error: messagesFor(language).includeError(messageForError(error)),
    };
  }
  try {
    exclude = filter.excludeRegex ? new RegExp(filter.excludeRegex) : undefined;
  } catch (error) {
    return {
      selected: new Set(),
      error: messagesFor(language).excludeError(messageForError(error)),
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
  language: InterfaceLanguage = "zh",
): ModelChanges {
  const analysis = analyzeModelFilter(models, filter, language);
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

function formatContext(value: number | undefined, language: InterfaceLanguage): string {
  return value ? value.toLocaleString(language === "en" ? "en-US" : "zh-CN") : "-";
}

function formatAge(value: string | undefined, m: InterfaceMessages): string {
  if (!value) return m.notFetched;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return m.recent;
  const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1_000));
  if (seconds < 60) return m.justNow;
  if (seconds < 3_600) return m.minutesAgo(Math.floor(seconds / 60));
  if (seconds < 86_400) return m.hoursAgo(Math.floor(seconds / 3_600));
  return m.daysAgo(Math.floor(seconds / 86_400));
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
  const language = interfaceLanguage(context.host.locale);
  const m = messagesFor(language);
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
  const pageElement = page;

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
    sessionImpact: page.querySelector<HTMLElement>('[data-ref="sessionImpact"]')!,
    sessionImpactTitle: page.querySelector<HTMLElement>('[data-ref="sessionImpactTitle"]')!,
    sessionImpactList: page.querySelector<HTMLElement>('[data-ref="sessionImpactList"]')!,
    cancelDelete: page.querySelector<HTMLButtonElement>('[data-ref="cancelDelete"]')!,
    confirmDelete: page.querySelector<HTMLButtonElement>('[data-ref="confirmDelete"]')!,
  };

  function applyStaticTexts() {
    for (const element of pageElement.querySelectorAll<HTMLElement>("[data-i18n]")) {
      const rawKey = element.getAttribute("data-i18n");
      if (!rawKey) continue;
      const value = m[rawKey as keyof InterfaceMessages];
      if (typeof value === "string") element.textContent = value;
    }
    for (const element of pageElement.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
      const rawKey = element.getAttribute("data-i18n-placeholder");
      if (!rawKey) continue;
      const value = m[rawKey as keyof InterfaceMessages];
      if (typeof value === "string") element.placeholder = value;
    }
    pageElement.querySelector<HTMLElement>(".mf-summary")?.setAttribute("aria-label", m.summaryLabel);
    refs.providerSelect.setAttribute("aria-label", m.chooseProvider);
    refs.retry.textContent = m.retry;
    refs.fetchButton.textContent = m.fetchModels;
    refs.saveButton.textContent = m.saveStrategy;
    refs.applyButton.textContent = m.applyStrategy;
    refs.cancelDelete.textContent = m.cancel;
    refs.confirmDelete.textContent = m.confirmApply;
    refs.deleteDescription.textContent = m.deleteDescriptionBase;
    refs.empty.textContent = m.noMatches;
  }

  applyStaticTexts();

  function selectedProvider(): ProviderSummary | undefined {
    return providers.find((provider) => provider.id === currentId);
  }

  function currentDraft(): DraftState | undefined {
    return drafts.get(currentId);
  }

  function setError(next: string) {
    error = translateBackendError(next, language);
    notice = "";
  }

  function setNotice(next: string) {
    notice = next;
    error = "";
  }

  function renderConnection() {
    const connected = context.host.connection.connected;
    refs.connection.classList.toggle("is-offline", !connected);
    refs.connectionText.textContent = connected ? m.connected : m.waitingConnection;
    refs.providerSelect.setAttribute("aria-label", m.chooseProvider);
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
    const includeRegexAnalysis = analyzeModelFilter([], { includeRegex: draft?.includeRegex, replace: true }, language);
    const excludeRegexAnalysis = analyzeModelFilter([], { excludeRegex: draft?.excludeRegex, replace: true }, language);
    const includeError = Boolean(includeRegexAnalysis.error);
    const excludeError = Boolean(excludeRegexAnalysis.error);
    refs.includeRegex.setAttribute("aria-invalid", String(includeError));
    refs.excludeRegex.setAttribute("aria-invalid", String(excludeError));
    refs.includeNote.textContent =
      includeError ? includeRegexAnalysis.error : m.includeNote;
    refs.excludeNote.textContent =
      excludeError ? excludeRegexAnalysis.error : m.excludeNote;
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
      empty.textContent = m.whitelistEmpty;
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
      remove.setAttribute("aria-label", m.removeWhitelist(id));
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
      empty.textContent = m.noAgents;
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
      checkbox.setAttribute("aria-label", m.overrideAgent(agent.id));
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
      const suffix = agent.hasModelAllowlist ? "" : m.noAllowlist;
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
      checkbox.setAttribute("aria-label", m.addToWhitelist(model.id));
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
      nameCell.textContent = model.remote ? model.name : m.configuredOnly(model.name);

      const contextCell = document.createElement("td");
      contextCell.className = "mf-model-context";
      contextCell.textContent = formatContext(model.contextWindow, language);

      const resultCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "mf-badge";
      if (regexError && model.remote) {
        badge.classList.add("is-removed");
        badge.textContent = m.waitForRegex;
      } else if (protectedRefs.has(model.id)) {
        badge.classList.add("is-protected");
        badge.textContent = m.referenceProtected;
        badge.title = m.referenceProtectedTitle(protectedRefs.get(model.id) ?? []);
      } else if (removed.has(model.id)) {
        badge.classList.add("is-removed");
        badge.textContent = m.willDelete;
      } else if (manualSet.has(model.id)) {
        badge.classList.add("is-manual");
        badge.textContent = m.whitelistBadge;
      } else if (selected.has(model.id)) {
        badge.classList.add("is-selected");
        badge.textContent = m.selectedBadge;
      } else {
        badge.classList.add("is-muted");
        badge.textContent = model.remote ? m.unselected : m.configuredBadge;
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
    refs.fetchButton.textContent = fetching ? m.fetchingModels : m.fetchModels;
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
      ? m.applyingModels
      : previewing
        ? m.previewingModels
        : m.applyStrategy;
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
    const analysis = analyzeModelFilter(remoteModels, filter, language);
    const changes = remote
      ? computeModelChanges(remoteModels, configuredModels, filter, language)
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
    refs.fetchAge.textContent = formatAge(remote?.fetchedAt, m);
    refs.selectedCount.textContent = String(changes.selected.size);
    refs.configuredCount.textContent = String(configuredModels.length);
    refs.changeCount.textContent = String(changes.addedIds.length + changes.removedIds.length);
    refs.changeDetail.textContent =
      `${m.addedShort} ${changes.addedIds.length} · ${m.removedShort} ${changes.removedIds.length}`;
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
      refs.saveState.textContent = m.noProviders;
    } else if (loading) {
      refs.saveState.textContent = m.readingProvider;
    } else if (analysis.error) {
      refs.saveState.textContent = m.fixRegex;
    } else if (draft?.dirty) {
      refs.saveState.textContent = m.unsavedStrategy;
    } else if (notice) {
      refs.saveState.textContent = notice;
    } else {
      refs.saveState.textContent = m.savedStrategy;
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
    if (analyzeModelFilter([], draft.filter, language).error) return;
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
      setNotice(m.savedNotice(provider.label));
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
    heading.textContent = m.referenceNote(entries.length);
    refs.deleteRefs.append(heading);

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "mf-reference-item";
      const ref = document.createElement("code");
      ref.textContent = entry.ref;
      const paths = document.createElement("span");
      paths.textContent =
        language === "en" ? entry.references.join(", ") : entry.references.join("、");
      row.append(ref, paths);
      refs.deleteRefs.append(row);
    }
  }

  function renderAffectedSessions(entries: AffectedSession[]) {
    refs.sessionImpactList.replaceChildren();
    refs.sessionImpact.hidden = entries.length === 0;
    refs.sessionImpactTitle.textContent = "";
    if (entries.length === 0) return;

    refs.sessionImpactTitle.textContent = m.sessionNote(entries.length);
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "mf-reference-item";
      const label = document.createElement("span");
      const readable = entry.label.trim();
      label.textContent =
        readable.length > 0 ? readable : entry.agentId.trim() || entry.sessionKey;
      const key = document.createElement("code");
      key.textContent = entry.sessionKey;
      row.append(label, key);
      refs.sessionImpactList.append(row);
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
      const output: ApplyOutputWithSessions & { protectedModels?: ProtectedModel[] } =
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
          ? m.syncedAgents(output.syncedAgents)
          : output.targetAgents.length > 0
            ? m.targetAgentsNotUpdated
            : "";
      const protectedSuffix =
        protectedModels.length > 0 ? m.protectedCount(protectedModels.length) : "";
      const resetCount = output.sessionSelectionResets ?? output.resetSessionKeys?.length ?? 0;
      const sessionSuffix = resetCount > 0 ? m.resetSessions(resetCount) : "";
      setNotice(
        m.applyNotice(
          output.selectedIds.length,
          provider.label,
          output.added,
          output.removed,
          `${syncedSuffix}${protectedSuffix}${sessionSuffix}`,
        ),
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
    if (analyzeModelFilter([], draft.filter, language).error) return;
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
      const affectedSessions =
        (output.plan as ApplyPlanWithSessions).affectedSessions ??
        (output as { affectedSessions?: AffectedSession[] }).affectedSessions ??
        [];
      protections.set(provider.id, protectedModels);
      renderAffectedSessions(affectedSessions);
      previewing = false;
      render();

      if (output.plan.removedIds.length === 0) {
        await applyPlan(provider, output.plan);
        return;
      }

      refs.deleteTitle.textContent = m.deleteTitle(output.plan.removedIds.length);
      refs.deleteDescription.textContent =
        m.deleteDescriptionProvider(provider.label);
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

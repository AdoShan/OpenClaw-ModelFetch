import * as sessionStoreRuntime from "openclaw/plugin-sdk/session-store-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { listConfiguredAgentEntries } from "./model-fetch.js";
import type { AffectedSession } from "./schemas.js";

export type SessionSelectionScope = {
  sessionKey?: string;
  agentId?: string;
};

export type SessionStoreRuntime = {
  getSessionEntryAsync: typeof sessionStoreRuntime.getSessionEntryAsync;
  patchSessionEntry: typeof sessionStoreRuntime.patchSessionEntry;
  listSessionEntries: typeof sessionStoreRuntime.listSessionEntriesAsync;
};

type SessionEntryCandidate = {
  sessionKey: string;
  agentId: string;
  entry: SessionEntry;
};

const AFFECTED_SESSION_LIMIT = 2_000;
const DEFAULT_AGENT_ID = "main";

export type ModelFetchSessionCleanup = {
  affectedSessions: (
    providerId: string,
    removedIds: readonly string[],
    scope?: SessionSelectionScope,
  ) => Promise<AffectedSession[]>;
  reset: (params: {
    providerId: string;
    removedIds: readonly string[];
    scope?: SessionSelectionScope;
  }) => Promise<string[]>;
};

export function createModelFetchSessionCleanup({
  currentConfig,
  sessionStore: sessionStoreOverrides,
}: {
  currentConfig?: () => unknown;
  sessionStore?: Partial<SessionStoreRuntime>;
} = {}): ModelFetchSessionCleanup {
  const sessionStore: SessionStoreRuntime = {
    getSessionEntryAsync: sessionStoreRuntime.getSessionEntryAsync,
    patchSessionEntry: sessionStoreRuntime.patchSessionEntry,
    listSessionEntries: sessionStoreRuntime.listSessionEntriesAsync,
    ...sessionStoreOverrides,
  };
  function configuredAgentIds(): string[] {
    return currentConfig
      ? listConfiguredAgentEntries(currentConfig()).map(({ id }) => id)
      : [];
  }

  function staleOverrideMatches(
    entry: SessionEntry,
    providerId: string,
    removedIds: readonly string[],
  ): boolean {
    if (entry.providerOverride) {
      return entry.providerOverride === providerId && removedIds.includes(entry.modelOverride ?? "");
    }
    if (entry.modelOverride) {
      return removedIds.some((modelId) => entry.modelOverride === `${providerId}/${modelId}`);
    }
    return entry.modelProvider === providerId && removedIds.includes(entry.model ?? "");
  }

  /** Session ownership comes only from the leading agent key segment. */
  function parseAgentIdFromSessionKey(sessionKey: string): string | undefined {
    const raw = sessionKey?.trim() ?? "";
    if (raw.length < 7 || raw.slice(0, 6).toLowerCase() !== "agent:") return undefined;
    const separator = raw.indexOf(":", 6);
    if (separator === -1) return undefined;
    const agentId = raw.slice(6, separator).trim();
    const rest = raw.slice(separator + 1);
    if (!agentId || !rest || rest.startsWith(":")) return undefined;
    return agentId;
  }

  function staleSelectionResetUpdate(
    entry: SessionEntry,
    providerId: string,
    removedIds: readonly string[],
  ): Partial<SessionEntry> {
    const runtimeModelMatches =
      entry.modelProvider === providerId && removedIds.includes(entry.model ?? "");
    return {
      providerOverride: undefined,
      modelOverride: undefined,
      modelOverrideSource: undefined,
      modelOverrideRouteResolution: undefined,
      modelOverrideFallbackOriginProvider: undefined,
      modelOverrideFallbackOriginModel: undefined,
      ...(runtimeModelMatches
        ? {
            model: undefined,
            modelProvider: undefined,
            contextTokens: undefined,
            contextTokensSource: undefined,
            contextBudgetStatus: undefined,
          }
        : {}),
    };
  }

  /** Discover related agent stores without creating writable database lifecycles. */
  async function collectSessionEntries(
    agentIds: readonly string[],
  ): Promise<SessionEntryCandidate[]> {
    const candidates: SessionEntryCandidate[] = [];
    const visited = new Set<string>();
    const queue = [...agentIds];

    while (queue.length > 0) {
      const agentId = (queue.shift() ?? "").trim();
      if (!agentId) continue;
      const normalized = agentId.toLowerCase();
      if (visited.has(normalized)) continue;
      visited.add(normalized);

      let summaries: Awaited<ReturnType<SessionStoreRuntime["listSessionEntries"]>> = [];
      try {
        summaries = await sessionStore.listSessionEntries({ agentId });
      } catch {
        continue;
      }

      for (const summary of summaries ?? []) {
        const sessionKey = summary?.sessionKey;
        if (!sessionKey) continue;
        const parsedAgentId = parseAgentIdFromSessionKey(sessionKey);
        candidates.push({
          sessionKey,
          agentId: parsedAgentId ?? agentId,
          entry: summary.entry,
        });
        if (parsedAgentId && !visited.has(parsedAgentId.toLowerCase())) {
          queue.push(parsedAgentId);
        }
      }
    }
    return candidates;
  }

  function collectAffectedSessions(
    candidates: readonly SessionEntryCandidate[],
    providerId: string,
    removedIds: readonly string[],
  ): AffectedSession[] {
    const affected: AffectedSession[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (affected.length >= AFFECTED_SESSION_LIMIT) break;
      const entry = candidate.entry;
      if (!entry || entry.modelSelectionLocked === true) continue;
      if (!staleOverrideMatches(entry, providerId, removedIds)) continue;
      const dedupeKey = `${candidate.agentId.toLowerCase()}::${candidate.sessionKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      affected.push({
        sessionKey: candidate.sessionKey,
        agentId: candidate.agentId,
        label: entry.label || entry.displayName || candidate.sessionKey,
      });
    }
    return affected;
  }

  async function affectedSessions(
    providerId: string,
    removedIds: readonly string[],
    scope: SessionSelectionScope = {},
  ): Promise<AffectedSession[]> {
    if (removedIds.length === 0) return [];
    const agentIds = new Set<string>([DEFAULT_AGENT_ID]);
    const scopeAgentId = scope.agentId?.trim();
    if (scopeAgentId) agentIds.add(scopeAgentId);
    const scopedKeyAgentId = scope.sessionKey
      ? parseAgentIdFromSessionKey(scope.sessionKey)
      : undefined;
    if (scopedKeyAgentId) agentIds.add(scopedKeyAgentId);
    for (const agentId of configuredAgentIds()) agentIds.add(agentId);

    const candidates = await collectSessionEntries([...agentIds]);
    const scopedSessionKey = scope.sessionKey?.trim();
    const scopedOwnerId = scopeAgentId ?? scopedKeyAgentId;
    if (scopedSessionKey && scopedOwnerId) {
      const known = candidates.some((candidate) => candidate.sessionKey === scopedSessionKey);
      if (!known) {
        try {
          const entry = await sessionStore.getSessionEntryAsync({
            sessionKey: scopedSessionKey,
            agentId: scopedOwnerId,
          });
          if (entry) {
            candidates.push({ sessionKey: scopedSessionKey, agentId: scopedOwnerId, entry });
          }
        } catch {
          // The optional calling session must not block fleet cleanup.
        }
      }
    }
    return collectAffectedSessions(candidates, providerId, removedIds);
  }

  async function reset({
    providerId,
    removedIds,
    scope,
  }: {
    providerId: string;
    removedIds: readonly string[];
    scope?: SessionSelectionScope;
  }): Promise<string[]> {
    const resetSessionKeys: string[] = [];
    if (removedIds.length === 0) return resetSessionKeys;
    const candidates = await affectedSessions(providerId, removedIds, scope);

    for (const candidate of candidates) {
      try {
        const latest = await sessionStore.getSessionEntryAsync({
          sessionKey: candidate.sessionKey,
          agentId: candidate.agentId,
        });
        if (!latest || latest.modelSelectionLocked === true) continue;
        if (!staleOverrideMatches(latest, providerId, removedIds)) continue;
        const updated = await sessionStore.patchSessionEntry({
          sessionKey: candidate.sessionKey,
          agentId: candidate.agentId,
          preserveActivity: true,
          update: () => staleSelectionResetUpdate(latest, providerId, removedIds),
        });
        if (updated) resetSessionKeys.push(candidate.sessionKey);
      } catch {
        // A single failing session must not abort the remaining cleanups.
      }
    }
    return resetSessionKeys;
  }

  return { affectedSessions, reset };
}

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type {
  CaseVariant,
  ProtectedModel,
} from "./schemas.js";
import {
  applyModelReferenceProtection,
  collectCaseVariantRelations,
  getProvider,
  migrateModelRefEntries,
  rewriteModelReferences,
  syncAgentModelEntries,
  syncConfiguredModelPolicyAllow,
  type ModelDefinitionLike,
  type ProviderLike,
} from "./model-fetch.js";

export type NormalizedRewrite = {
  protectedModelId: string;
  fromRef: string;
  toRef: string;
};

export type ProviderModelReplacement = {
  providerId: string;
  provider: ProviderLike;
  existingModels: readonly ModelDefinitionLike[];
  mergedModels: readonly ModelDefinitionLike[];
  rewrites?: readonly NormalizedRewrite[];
  caseVariants?: readonly CaseVariant[];
  targetAgents: readonly string[];
};

export type ProviderModelReplacementResult = {
  finalModels: ModelDefinitionLike[];
  removedIds: string[];
  protectedModels: ProtectedModel[];
  rewrittenReferences: string[];
  syncedAgents: string[];
};

const CONFIG_MUTATION_MAX_ATTEMPTS = 5;

function isRetryableConfigConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name !== "ConfigMutationConflictError") return false;
  return (error as { retryable?: unknown }).retryable !== false;
}

export async function mutateConfigFileWithRetry(
  runtime: OpenClawPluginApi["runtime"],
  params: Parameters<OpenClawPluginApi["runtime"]["config"]["mutateConfigFile"]>[0],
): Promise<Awaited<ReturnType<OpenClawPluginApi["runtime"]["config"]["mutateConfigFile"]>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CONFIG_MUTATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await runtime.config.mutateConfigFile(params);
    } catch (error) {
      lastError = error;
      if (!isRetryableConfigConflict(error)) throw error;
    }
  }
  throw lastError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare authored source fields without mistaking runtime defaults for drift. */
export function sameProviderModels(
  sourceProvider: ProviderLike,
  sourceModels: readonly ModelDefinitionLike[],
  runtimeProvider: ProviderLike,
  runtimeModels: readonly ModelDefinitionLike[],
): boolean {
  if (sourceModels.length !== runtimeModels.length) return false;

  const sourceValueMatches = (source: unknown, runtime: unknown): boolean => {
    if (source === undefined) return true;
    if (Array.isArray(source)) {
      return (
        Array.isArray(runtime) &&
        source.length === runtime.length &&
        source.every((entry, index) => sourceValueMatches(entry, runtime[index]))
      );
    }
    if (isRecord(source)) {
      if (!isRecord(runtime)) return false;
      return Object.entries(source).every(
        ([key, entry]) =>
          entry === undefined ||
          (Object.prototype.hasOwnProperty.call(runtime, key) &&
            sourceValueMatches(entry, runtime[key])),
      );
    }
    return Object.is(source, runtime);
  };

  const sourceShape = (provider: ProviderLike, model: ModelDefinitionLike) => {
    const sourceModel = { ...model };
    if (sourceModel.api !== undefined && sourceModel.api === provider.api) {
      delete sourceModel.api;
    }
    if (sourceModel.baseUrl !== undefined && sourceModel.baseUrl === provider.baseUrl) {
      delete sourceModel.baseUrl;
    }
    return sourceModel;
  };

  return sourceModels.every((sourceModel, index) => {
    const runtimeModel = runtimeModels[index];
    if (!runtimeModel || sourceModel.id !== runtimeModel.id) return false;
    return sourceValueMatches(
      sourceShape(sourceProvider, sourceModel),
      sourceShape(runtimeProvider, runtimeModel),
    );
  });
}

/** Apply one replacement against the final source draft shared by tool and UI. */
export function replaceProviderModels(
  draft: unknown,
  replacement: ProviderModelReplacement,
): ProviderModelReplacementResult {
  const {
    providerId,
    existingModels,
    mergedModels,
    rewrites = [],
    caseVariants = collectCaseVariantRelations(
      existingModels
        .map((model) => model.id)
        .filter((id) => !mergedModels.some((model) => model.id === id)),
      mergedModels.map((model) => model.id),
    ),
    targetAgents,
  } = replacement;
  const target = getProvider(draft, providerId);
  const draftExistingModels = target.models ?? [];
  const externalModels = draftExistingModels.filter(
    (model) =>
      !existingModels.some((existing) => existing.id === model.id) &&
      !mergedModels.some((merged) => merged.id === model.id),
  );
  const draftMergedModels = [...mergedModels, ...externalModels];
  const rewrittenReferences: string[] = [];

  for (const rewrite of rewrites) {
    const result = rewriteModelReferences(draft, rewrite.fromRef, rewrite.toRef);
    if (result.changed) rewrittenReferences.push(...result.paths);
  }

  const rewriteEntryMigration = migrateModelRefEntries(
    draft,
    rewrites.map((rewrite) => ({ fromRef: rewrite.fromRef, toRef: rewrite.toRef })),
    { onAliasConflict: "error" },
  );
  if (rewriteEntryMigration.changed) rewrittenReferences.push(...rewriteEntryMigration.paths);

  const caseEntryMigration = migrateModelRefEntries(
    draft,
    caseVariants.map((variant) => ({
      fromRef: `${providerId}/${variant.removedId}`,
      toRef: `${providerId}/${variant.survivingModelId}`,
    })),
    { targetAgents },
  );
  if (caseEntryMigration.changed) rewrittenReferences.push(...caseEntryMigration.paths);

  const protection = applyModelReferenceProtection({
    existing: draftExistingModels,
    merged: draftMergedModels,
    providerId,
    config: draft,
  });
  const finalModels = protection.models;
  const finalIds = new Set(finalModels.map((model) => model.id));
  const removedIds = draftExistingModels
    .map((model) => model.id)
    .filter((id) => !finalIds.has(id));
  const protectedModels = protection.protectedModels;

  target.models = finalModels;
  // Applying models must not rewrite the strategy and trigger a plugin reload.
  const syncResult = syncConfiguredModelPolicyAllow(draft, providerId, finalModels, {
    targetAgents,
  });
  syncAgentModelEntries(draft, providerId, finalModels, {
    targetAgents: syncResult.syncedAgents,
  });

  return {
    finalModels,
    removedIds,
    protectedModels,
    rewrittenReferences: [...new Set(rewrittenReferences)].sort((left, right) =>
      left.localeCompare(right),
    ),
    syncedAgents: syncResult.syncedAgents,
  };
}

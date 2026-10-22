import { Type, type Static } from "typebox";

const providerIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^\\S+$",
});

const regexSchema = Type.String({ maxLength: 1_024 });

export const modelFetchFilterSchema = Type.Object(
  {
    includeRegex: Type.Optional(regexSchema),
    excludeRegex: Type.Optional(regexSchema),
    manualIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        maxItems: 1_000,
        uniqueItems: true,
      }),
    ),
    replace: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type ModelFilterConfig = Static<typeof modelFetchFilterSchema>;

export const modelFetchConfigSchema = Type.Object(
  {
    providers: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            filter: Type.Optional(modelFetchFilterSchema),
            targetAgents: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
                maxItems: 256,
                uniqueItems: true,
              }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export type ModelFetchConfig = Static<typeof modelFetchConfigSchema>;

export const modelFetchParameters = Type.Object(
  {
    provider: Type.String({
      minLength: 1,
      maxLength: 128,
      description:
        "Provider id from models.providers. Only this provider's configured filter is used.",
    }),
    includeRegex: Type.Optional(
      Type.String({
        maxLength: 1_024,
        description:
          "Temporary include regex. When omitted, the provider's persisted includeRegex is used.",
      }),
    ),
    excludeRegex: Type.Optional(
      Type.String({
        maxLength: 1_024,
        description:
          "Temporary exclude regex. Manual IDs are never excluded. When omitted, the provider's persisted excludeRegex is used.",
      }),
    ),
    manualIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        maxItems: 1_000,
        description:
          "Temporary exact model IDs to select. Without includeRegex, only these IDs are selected; with includeRegex, they bypass include/exclude.",
      }),
    ),
    replace: Type.Optional(
      Type.Boolean({
        description:
          "Remove existing models absent from the selected fetched set. Defaults to true.",
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

export type ModelFetchParams = Static<typeof modelFetchParameters>;

/**
 * A model kept in the provider list because a non-agent config consumer still
 * references it, with the config paths that pinned it.
 */
export const protectedModelSchema = Type.Object(
  {
    modelId: Type.String({ minLength: 1, maxLength: 512 }),
    ref: Type.String({ minLength: 1, maxLength: 1_024 }),
    references: Type.Array(Type.String({ maxLength: 1_024 }), { maxItems: 256 }),
  },
  { additionalProperties: false },
);

export type ProtectedModel = Static<typeof protectedModelSchema>;

export const modelFetchResultSchema = Type.Object(
  {
    provider: providerIdSchema,
    fetched: Type.Integer({ minimum: 0 }),
    selected: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 1_000 }),
    protectedModels: Type.Array(protectedModelSchema, { maxItems: 2_000 }),
    added: Type.Integer({ minimum: 0 }),
    unchanged: Type.Integer({ minimum: 0 }),
    removed: Type.Integer({ minimum: 0 }),
    replace: Type.Boolean(),
    dryRun: Type.Boolean(),
    configPath: Type.String({ maxLength: 2_048 }),
    persisted: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type ModelFetchToolResult = Static<typeof modelFetchResultSchema>;

export const modelViewSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 512 }),
    name: Type.String({ maxLength: 512 }),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export type ModelView = Static<typeof modelViewSchema>;

export const providerSummarySchema = Type.Object(
  {
    id: providerIdSchema,
    label: Type.String({ minLength: 1, maxLength: 256 }),
    api: Type.String({ maxLength: 128 }),
    baseUrl: Type.String({ maxLength: 2_048 }),
    configPath: Type.String({ maxLength: 2_048 }),
    filter: modelFetchFilterSchema,
    targetAgents: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 256,
      uniqueItems: true,
    }),
    configuredModels: Type.Array(modelViewSchema, { maxItems: 2_000 }),
  },
  { additionalProperties: false },
);

export type ProviderSummary = Static<typeof providerSummarySchema>;

export const agentSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    hasModelAllowlist: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type AgentSummary = Static<typeof agentSummarySchema>;

const emptyInputSchema = Type.Object({}, { additionalProperties: false });
const providerInputSchema = Type.Object(
  { provider: providerIdSchema },
  { additionalProperties: false },
);

export const listProvidersOutputSchema = Type.Object(
  {
    providers: Type.Array(providerSummarySchema, { maxItems: 256 }),
    agents: Type.Array(agentSummarySchema, { maxItems: 512 }),
  },
  { additionalProperties: false },
);

export type ListProvidersOutput = Static<typeof listProvidersOutputSchema>;

export const fetchModelsOutputSchema = Type.Object(
  {
    provider: providerIdSchema,
    fetchedAt: Type.String({ maxLength: 64 }),
    models: Type.Array(modelViewSchema, { maxItems: 2_000 }),
  },
  { additionalProperties: false },
);

export type FetchModelsOutput = Static<typeof fetchModelsOutputSchema>;

export const saveStrategyOutputSchema = Type.Object(
  {
    provider: providerIdSchema,
    savedAt: Type.String({ maxLength: 64 }),
    configPath: Type.String({ maxLength: 2_048 }),
    filter: modelFetchFilterSchema,
    targetAgents: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 256,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export type SaveStrategyOutput = Static<typeof saveStrategyOutputSchema>;

export const saveStrategyInputSchema = Type.Object(
  {
    provider: providerIdSchema,
    filter: modelFetchFilterSchema,
    targetAgents: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 256,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false },
);

export type SaveStrategyInput = Static<typeof saveStrategyInputSchema>;

export const applyPlanSchema = Type.Object(
  {
    fingerprint: Type.String({ minLength: 64, maxLength: 64 }),
    fetchedAt: Type.String({ maxLength: 64 }),
    fetchedCount: Type.Integer({ minimum: 0 }),
    addedIds: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 2_000 }),
    removedIds: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 2_000 }),
    protectedModels: Type.Array(protectedModelSchema, { maxItems: 2_000 }),
    selectedIds: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 2_000 }),
    unchangedCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ApplyPlan = Static<typeof applyPlanSchema>;

export const previewApplyOutputSchema = Type.Object(
  {
    provider: providerIdSchema,
    plan: applyPlanSchema,
    models: Type.Array(modelViewSchema, { maxItems: 2_000 }),
  },
  { additionalProperties: false },
);

export type PreviewApplyOutput = Static<typeof previewApplyOutputSchema>;

export const applyStrategyInputSchema = Type.Object(
  {
    provider: providerIdSchema,
    fingerprint: Type.String({ minLength: 64, maxLength: 64 }),
    expectedRemovals: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 2_000 }),
    targetAgents: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 256,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false },
);

export type ApplyStrategyInput = Static<typeof applyStrategyInputSchema>;

export const applyStrategyOutputSchema = Type.Object(
  {
    provider: providerIdSchema,
    persisted: Type.Boolean(),
    configPath: Type.String({ maxLength: 2_048 }),
    fetchedAt: Type.String({ maxLength: 64 }),
    fetchedCount: Type.Integer({ minimum: 0 }),
    added: Type.Integer({ minimum: 0 }),
    unchanged: Type.Integer({ minimum: 0 }),
    removed: Type.Integer({ minimum: 0 }),
    selectedIds: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 2_000 }),
    protectedModels: Type.Array(protectedModelSchema, { maxItems: 2_000 }),
    targetAgents: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 256,
      uniqueItems: true,
    }),
    syncedAgents: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 256,
      uniqueItems: true,
    }),
    models: Type.Array(modelViewSchema, { maxItems: 2_000 }),
  },
  { additionalProperties: false },
);

export type ApplyStrategyOutput = Static<typeof applyStrategyOutputSchema>;

export { emptyInputSchema, providerInputSchema };

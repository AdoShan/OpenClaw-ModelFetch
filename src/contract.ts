import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import {
  applyStrategyInputSchema,
  applyStrategyOutputSchema,
  emptyInputSchema,
  fetchModelsOutputSchema,
  listProvidersOutputSchema,
  modelFetchParameters,
  modelFetchResultSchema,
  previewApplyOutputSchema,
  providerInputSchema,
  saveStrategyInputSchema,
  saveStrategyOutputSchema,
} from "./schemas.js";

export const modelFetchContract = defineFeatureContract({
  pluginId: "model-fetch",
  operations: {
    "providers.list": {
      kind: "query",
      description: "List configured model providers and their independent fetch filters.",
      input: emptyInputSchema,
      output: listProvidersOutputSchema,
    },
    "models.fetch": {
      kind: "query",
      description: "Fetch a provider's current remote model list without changing OpenClaw config.",
      input: providerInputSchema,
      output: fetchModelsOutputSchema,
    },
    "strategy.save": {
      kind: "action",
      description: "Save one provider's independent model selection strategy.",
      input: saveStrategyInputSchema,
      output: saveStrategyOutputSchema,
    },
    "strategy.preview": {
      kind: "action",
      description:
        "Fetch the provider again, apply its saved strategy, and return the exact pending config changes.",
      input: providerInputSchema,
      output: previewApplyOutputSchema,
    },
    "strategy.apply": {
      kind: "action",
      description:
        "Re-fetch a provider, verify the confirmed deletion list, and replace its configured models.",
      input: applyStrategyInputSchema,
      output: applyStrategyOutputSchema,
    },
    "provider.refresh": {
      kind: "action",
      description:
        "Fetch a configured provider's models, apply its independent strategy, and persist the replacement model list.",
      input: modelFetchParameters,
      output: modelFetchResultSchema,
      tool: {
        name: "model_fetch",
        label: "Fetch Provider Models",
      },
    },
  },
  events: {},
});

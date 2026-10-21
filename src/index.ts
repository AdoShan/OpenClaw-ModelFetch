import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  createModelFetchTool,
  MODEL_FETCH_TOOL_NAME,
  modelFetchConfigSchema,
  modelFetchParameters,
} from "./model-fetch.js";
import { registerModelFetchOperations } from "./operations.js";
import type { ModelFetchConfig } from "./schemas.js";

const entry = defineToolPlugin({
  id: "model-fetch",
  name: "Model Fetch",
  description:
    "Fetch and refresh configured provider model lists into OpenClaw config with independent per-provider filters.",
  configSchema: modelFetchConfigSchema,
  tools: (tool) => [
    tool({
      name: MODEL_FETCH_TOOL_NAME,
      label: "Fetch Provider Models",
      description:
        "Fetch a configured provider's model list, apply that provider's independent regex/manual selection strategy, and persist the selected models to OpenClaw config for WebUI use.",
      parameters: modelFetchParameters,
      factory: ({ api, config, toolContext }) =>
        createModelFetchTool({ api, toolContext, factoryConfig: config }),
    }),
  ],
});

const registerTools = entry.register;
entry.register = (api) => {
  registerTools?.(api);
  registerModelFetchOperations(api, {
    factoryConfig: api.pluginConfig as ModelFetchConfig | undefined,
  });
};

export default entry;

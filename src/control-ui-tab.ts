import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export const CONTROL_UI_TAB_ID = "model-fetch";

type ControlUiTabDescriptor = {
  surface: "tab";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  group?: "control" | "agent";
  order?: number;
  requiredScopes?: string[];
};

type DescriptorRegistrar = (descriptor: ControlUiTabDescriptor) => void;

/**
 * Descriptor advertised to every Gateway dashboard client.
 *
 * The browser Control UI renders the plugin's own navigation entry, but the
 * Android and iOS apps only learn about plugins from the `controlUiTabs`
 * payload in the Gateway hello message. Without a descriptor the plugin is
 * invisible on those clients.
 */
export const controlUiTabDescriptor: ControlUiTabDescriptor = {
  surface: "tab",
  id: CONTROL_UI_TAB_ID,
  label: "Model Fetch",
  description: "Fetch and refresh provider model lists into OpenClaw config.",
  icon: "download",
  group: "control",
  order: 620,
  requiredScopes: ["operator.read"],
};

/**
 * Register the tab descriptor on hosts that support it.
 *
 * `api.session.controls.registerControlUiDescriptor` is the current entry
 * point; the flat `api.registerControlUiDescriptor` is the deprecated
 * fallback kept for older OpenClaw releases. Hosts that support neither are
 * left untouched instead of failing plugin activation.
 */
export function registerControlUiTab(api: OpenClawPluginApi): boolean {
  const controls = api.session?.controls as
    | { registerControlUiDescriptor?: DescriptorRegistrar }
    | undefined;
  const grouped = controls?.registerControlUiDescriptor;
  if (typeof grouped === "function") {
    grouped.call(controls, controlUiTabDescriptor);
    return true;
  }

  const legacy = (api as { registerControlUiDescriptor?: DescriptorRegistrar })
    .registerControlUiDescriptor;
  if (typeof legacy === "function") {
    legacy.call(api, controlUiTabDescriptor);
    return true;
  }

  return false;
}

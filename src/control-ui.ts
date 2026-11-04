import "./control-ui.css";
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { modelFetchSettingsView } from "./settings-view.js";

export { modelFetchSettingsView } from "./settings-view.js";

export const NAVIGATION_ID = "model-fetch";

/**
 * OpenClaw only lists a plugin navigation item in the sidebar "Customize"
 * (pin editor) menu when the item declares `defaultVisible: false`. Items
 * without that flag are always visible and cannot be pinned or unpinned, so
 * Model Fetch used to be missing from the pin editor entirely.
 *
 * Declaring the flag also stops the host from adding the entry to the
 * sidebar on its own, so the first activation after the upgrade restores the
 * saved pin once. The marker keeps a later manual removal respected.
 */
export const PIN_MIGRATION_STORAGE_KEY = "openclaw.plugin.model-fetch.sidebar-pin.v1";

type NavigationHost = {
  ui: {
    pinNavigation?: (id: string) => void;
    isNavigationPinned?: (id: string) => boolean;
  };
};

/**
 * Restore the sidebar entry that `defaultVisible: false` would otherwise
 * drop, exactly once per browser profile.
 *
 * When browser storage is unavailable the migration is skipped instead of
 * pinning on every activation, so a later manual removal is never undone.
 */
export function restoreSidebarPin(host: NavigationHost): void {
  const { pinNavigation, isNavigationPinned } = host.ui;
  if (typeof pinNavigation !== "function") return;

  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
    if (!storage) return;
    if (storage.getItem(PIN_MIGRATION_STORAGE_KEY)) return;
  } catch {
    return;
  }

  try {
    if (
      typeof isNavigationPinned !== "function" ||
      !isNavigationPinned(NAVIGATION_ID)
    ) {
      pinNavigation(NAVIGATION_ID);
    }
    storage.setItem(PIN_MIGRATION_STORAGE_KEY, "1");
  } catch {
    // A blocked storage API must not break plugin activation.
  }
}

export default defineControlUiPlugin({
  id: "model-fetch",
  activate(host) {
    const disposePage = host.ui.registerPage({
      id: NAVIGATION_ID,
      label: "Model Fetch",
      mount: modelFetchSettingsView,
    });
    const disposeNavigation = host.ui.registerNavigation({
      id: NAVIGATION_ID,
      label: "Model Fetch",
      page: { id: NAVIGATION_ID },
      icon: "download",
      order: 620,
      defaultVisible: false,
    });

    restoreSidebarPin(host);

    return () => {
      disposeNavigation();
      disposePage();
    };
  },
});

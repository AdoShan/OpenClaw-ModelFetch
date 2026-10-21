import "./control-ui.css";
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { modelFetchSettingsView } from "./settings-view.js";

export { modelFetchSettingsView } from "./settings-view.js";

export default defineControlUiPlugin({
  id: "model-fetch",
  activate(host) {
    const disposePage = host.ui.registerPage({
      id: "model-fetch",
      label: "Model Fetch",
      mount: modelFetchSettingsView,
    });
    const disposeNavigation = host.ui.registerNavigation({
      id: "model-fetch",
      label: "Model Fetch",
      page: { id: "model-fetch" },
      icon: "download",
      order: 620,
    });

    return () => {
      disposeNavigation();
      disposePage();
    };
  },
});

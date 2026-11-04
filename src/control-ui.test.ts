import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, {
  NAVIGATION_ID,
  PIN_MIGRATION_STORAGE_KEY,
  restoreSidebarPin,
} from "./control-ui.js";
import {
  CONTROL_UI_TAB_ID,
  controlUiTabDescriptor,
  registerControlUiTab,
} from "./control-ui-tab.js";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: () => null,
    length: 0,
  };
}

type HostHarness = ReturnType<typeof createHost>;

function createHost(overrides: { pinned?: boolean; canPin?: boolean } = {}) {
  const pinned = new Set<string>(overrides.pinned ? [NAVIGATION_ID] : []);
  const pinNavigation = vi.fn((id: string) => {
    pinned.add(id);
  });
  const isNavigationPinned = vi.fn((id: string) => pinned.has(id));
  const registerPage = vi.fn(() => () => {});
  const registerNavigation = vi.fn(() => () => {});
  const host = {
    ui: {
      registerPage,
      registerNavigation,
      pinNavigation: overrides.canPin === false ? undefined : pinNavigation,
      isNavigationPinned,
    },
  };
  return {
    host,
    pinNavigation,
    isNavigationPinned,
    registerPage,
    registerNavigation,
    pinned,
  };
}

const originalLocalStorage = globalThis.localStorage;

function setLocalStorage(value: unknown) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value,
  });
}

describe("Model Fetch Control UI plugin", () => {
  beforeEach(() => {
    setLocalStorage(createStorage());
  });

  afterEach(() => {
    setLocalStorage(originalLocalStorage);
  });

  it("offers the navigation item in the sidebar pin editor", () => {
    const harness: HostHarness = createHost();
    plugin.activate(harness.host as never);

    expect(harness.registerNavigation).toHaveBeenCalledTimes(1);
    const item = harness.registerNavigation.mock.calls[0]![0] as {
      id: string;
      defaultVisible?: boolean;
    };
    expect(item.id).toBe(NAVIGATION_ID);
    expect(item.defaultVisible).toBe(false);
  });

  it("restores the sidebar pin once after the upgrade", () => {
    const harness = createHost();
    restoreSidebarPin(harness.host);
    expect(harness.pinNavigation).toHaveBeenCalledWith(NAVIGATION_ID);
    expect(globalThis.localStorage.getItem(PIN_MIGRATION_STORAGE_KEY)).toBe("1");

    const second = createHost();
    restoreSidebarPin(second.host);
    expect(second.pinNavigation).not.toHaveBeenCalled();
  });

  it("keeps an already pinned entry untouched", () => {
    const harness = createHost({ pinned: true });
    restoreSidebarPin(harness.host);
    expect(harness.pinNavigation).not.toHaveBeenCalled();
    expect(globalThis.localStorage.getItem(PIN_MIGRATION_STORAGE_KEY)).toBe("1");
  });

  it("skips the migration when browser storage is unavailable", () => {
    setLocalStorage(undefined);
    const harness = createHost();
    restoreSidebarPin(harness.host);
    expect(harness.pinNavigation).not.toHaveBeenCalled();
  });

  it("skips the migration when browser storage throws", () => {
    setLocalStorage({
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    const harness = createHost();
    expect(() => restoreSidebarPin(harness.host)).not.toThrow();
    expect(harness.pinNavigation).not.toHaveBeenCalled();
  });

  it("does nothing when the host cannot pin navigation items", () => {
    const harness = createHost({ canPin: false });
    expect(() => restoreSidebarPin(harness.host)).not.toThrow();
    expect(harness.pinNavigation).not.toHaveBeenCalled();
  });
});

describe("Model Fetch Control UI tab descriptor", () => {
  it("advertises a tab so dashboard clients can discover the plugin", () => {
    const register = vi.fn();
    const api = { session: { controls: { registerControlUiDescriptor: register } } };

    expect(registerControlUiTab(api as never)).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(controlUiTabDescriptor);
    expect(controlUiTabDescriptor.surface).toBe("tab");
    expect(controlUiTabDescriptor.id).toBe(CONTROL_UI_TAB_ID);
    expect(controlUiTabDescriptor.requiredScopes).toEqual(["operator.read"]);
  });

  it("falls back to the deprecated flat registrar on older hosts", () => {
    const register = vi.fn();
    const api = { session: {}, registerControlUiDescriptor: register };

    expect(registerControlUiTab(api as never)).toBe(true);
    expect(register).toHaveBeenCalledWith(controlUiTabDescriptor);
  });

  it("skips registration when the host supports neither registrar", () => {
    const api = { session: {} };
    expect(registerControlUiTab(api as never)).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  InkbookSettingsStore,
  type DeviceSettingsPort,
  type VaultSettingsPort,
} from "../../../../src/obsidian/settings/storage";
import {
  DEVICE_SETTINGS_STORAGE_KEY,
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";

class VaultFake implements VaultSettingsPort {
  public saves: unknown[] = [];

  public constructor(public loaded: unknown) {}

  public async loadData(): Promise<unknown> {
    return this.loaded;
  }

  public async saveData(data: ReturnType<typeof createBuiltInSettings>): Promise<void> {
    this.saves.push(structuredClone(data));
  }
}

class DeviceFake implements DeviceSettingsPort {
  public saves: { key: string; data: unknown }[] = [];

  public constructor(public loaded: unknown) {}

  public loadLocalStorage(key: string): unknown {
    expect(key).toBe(DEVICE_SETTINGS_STORAGE_KEY);
    return this.loaded;
  }

  public saveLocalStorage(key: string, data: ReturnType<typeof createBuiltInDeviceSettings>): void {
    this.saves.push({ key, data: structuredClone(data) });
  }
}

class DeviceMapFake implements DeviceSettingsPort {
  public readonly saves: { key: string; data: unknown }[] = [];

  public constructor(private readonly values: Readonly<Record<string, unknown>>) {}

  public loadLocalStorage(key: string): unknown {
    return this.values[key];
  }

  public saveLocalStorage(key: string, data: ReturnType<typeof createBuiltInDeviceSettings>): void {
    this.saves.push({ key, data: structuredClone(data) });
  }
}

describe("InkbookSettingsStore", () => {
  it("loads vault and device settings through their documented boundaries", async () => {
    const vaultValue = createBuiltInSettings();
    vaultValue.startupTool = "arrow";
    const deviceValue = createBuiltInDeviceSettings();
    deviceValue.motion = "reduced";
    const store = new InkbookSettingsStore(new VaultFake(vaultValue), new DeviceFake(deviceValue));

    const diagnostics = await store.load();

    expect(diagnostics).toEqual({ vault: [], device: [] });
    expect(store.getVaultSettings().startupTool).toBe("arrow");
    expect(store.getDeviceSettings().motion).toBe("reduced");
  });

  it("exposes migrated V3 vault settings as V4 runtime settings", async () => {
    const current = createBuiltInSettings();
    current.startupTool = "arrow";
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.version = 3;
    delete legacy.snapping;
    delete (legacy.toolDefaults as Record<string, unknown>).select;
    const store = new InkbookSettingsStore(
      new VaultFake(legacy),
      new DeviceFake(createBuiltInDeviceSettings()),
    );

    const diagnostics = await store.load();

    expect(diagnostics.vault).toEqual([]);
    expect(store.getVaultSettings()).toMatchObject({
      version: 4,
      startupTool: "arrow",
      snapping: createBuiltInSettings().snapping,
      toolDefaults: { select: { area: "lasso", inclusion: "touched" } },
    });
  });
});

describe("InkbookSettingsStore device migration", () => {
  it("migrates legacy device settings and persists the V2 result once", async () => {
    const legacy = {
      version: 1,
      fingerDrawingEnabled: true,
      leftHandedToolbar: true,
      motion: "reduced",
      penTapInsertion: "handwriting",
    };
    const device = new DeviceMapFake({ "inkbook:device-settings:v1": legacy });
    const store = new InkbookSettingsStore(new VaultFake(createBuiltInSettings()), device);

    const diagnostics = await store.load();

    expect(diagnostics.device).toEqual([]);
    expect(store.getDeviceSettings()).toEqual({
      ...legacy,
      version: 2,
      keyboardShortcuts: createBuiltInDeviceSettings().keyboardShortcuts,
    });
    expect(device.saves).toEqual([
      { key: DEVICE_SETTINGS_STORAGE_KEY, data: store.getDeviceSettings() },
    ]);
  });
});

describe("InkbookSettingsStore persistence", () => {
  it("uses field-level loader fallback and reports persisted-data diagnostics", async () => {
    const vaultValue = createBuiltInSettings() as unknown as Record<string, unknown>;
    vaultValue.startupTool = "invalid";
    const store = new InkbookSettingsStore(
      new VaultFake(vaultValue),
      new DeviceFake(createBuiltInDeviceSettings()),
    );

    const diagnostics = await store.load();

    expect(store.getVaultSettings().startupTool).toBe("draw");
    expect(diagnostics.vault).toContainEqual({
      code: "settings.invalid-field",
      path: "startupTool",
    });
  });

  it("persists resets to both scopes under the fixed local-storage key", async () => {
    const vault = new VaultFake(createBuiltInSettings());
    const device = new DeviceFake(createBuiltInDeviceSettings());
    const store = new InkbookSettingsStore(vault, device);
    await store.load();

    await store.resetAll();

    expect(vault.saves).toEqual([createBuiltInSettings()]);
    expect(device.saves).toEqual([
      { key: DEVICE_SETTINGS_STORAGE_KEY, data: createBuiltInDeviceSettings() },
    ]);
  });

  it("serializes concurrent vault updates without losing a newer field", async () => {
    const vault = new VaultFake(createBuiltInSettings());
    const store = new InkbookSettingsStore(vault, new DeviceFake(createBuiltInDeviceSettings()));
    await store.load();

    await Promise.all([
      store.updateVaultSettings((settings) => ({ ...settings, startupTool: "arrow" })),
      store.updateVaultSettings((settings) => {
        settings.toolDefaults.eraser.radius = 40;
        return settings;
      }),
    ]);

    expect(store.getVaultSettings()).toMatchObject({
      startupTool: "arrow",
      toolDefaults: { eraser: { radius: 40 } },
    });
    expect(vault.saves).toHaveLength(2);
  });
});

describe("InkbookSettingsStore device subscriptions", () => {
  it("publishes only validated device updates and isolates listener snapshots", async () => {
    const vault = new VaultFake(createBuiltInSettings());
    const device = new DeviceFake(createBuiltInDeviceSettings());
    const store = new InkbookSettingsStore(vault, device);
    await store.load();
    const first = vi.fn((settings: Readonly<ReturnType<typeof createBuiltInDeviceSettings>>) => {
      (settings as ReturnType<typeof createBuiltInDeviceSettings>).motion = "full";
    });
    const second = vi.fn();
    const unsubscribe = store.subscribeDeviceSettings(first);
    store.subscribeDeviceSettings(second);

    store.updateDeviceSettings((settings) => ({ ...settings, leftHandedToolbar: true }));

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith({
      ...createBuiltInDeviceSettings(),
      leftHandedToolbar: true,
    });
    expect(store.getDeviceSettings()).toEqual({
      ...createBuiltInDeviceSettings(),
      leftHandedToolbar: true,
    });

    expect(() =>
      store.updateDeviceSettings((settings) => ({ ...settings, motion: "invalid" as "system" })),
    ).toThrow("Invalid device settings");
    expect(first).toHaveBeenCalledOnce();

    unsubscribe();
    store.updateDeviceSettings((settings) => ({ ...settings, motion: "reduced" }));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("does not publish vault-only updates through the device subscription", async () => {
    const store = new InkbookSettingsStore(
      new VaultFake(createBuiltInSettings()),
      new DeviceFake(createBuiltInDeviceSettings()),
    );
    await store.load();
    const listener = vi.fn();
    store.subscribeDeviceSettings(listener);

    await store.updateVaultSettings((settings) => ({ ...settings, startupTool: "arrow" }));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("InkbookSettingsStore vault subscriptions", () => {
  it("publishes the persisted refresh profile after a successful serialized write", async () => {
    const store = new InkbookSettingsStore(
      new VaultFake(createBuiltInSettings()),
      new DeviceFake(createBuiltInDeviceSettings()),
    );
    await store.load();
    const listener = vi.fn();
    store.subscribeVaultSettings(listener);

    await store.updateVaultSettings((settings) => ({
      ...settings,
      refreshRatePreference: 144,
    }));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      ...createBuiltInSettings(),
      refreshRatePreference: 144,
    });
  });
});

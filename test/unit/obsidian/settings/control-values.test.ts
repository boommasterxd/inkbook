import { beforeEach, describe, expect, it } from "vitest";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";
import { SettingsControlValues } from "../../../../src/obsidian/settings/control-values";
import {
  InkbookSettingsStore,
  type DeviceSettingsPort,
  type VaultSettingsPort,
} from "../../../../src/obsidian/settings/storage";

class VaultFake implements VaultSettingsPort {
  public saved = createBuiltInSettings();
  public async loadData(): Promise<unknown> {
    return this.saved;
  }
  public async saveData(data: ReturnType<typeof createBuiltInSettings>): Promise<void> {
    this.saved = structuredClone(data);
  }
}

class DeviceFake implements DeviceSettingsPort {
  public saved = createBuiltInDeviceSettings();
  public loadLocalStorage(): unknown {
    return this.saved;
  }
  public saveLocalStorage(
    _key: string,
    data: ReturnType<typeof createBuiltInDeviceSettings>,
  ): void {
    this.saved = structuredClone(data);
  }
}

let values: SettingsControlValues;
let vault: VaultFake;
let device: DeviceFake;

beforeEach(async () => {
  vault = new VaultFake();
  device = new DeviceFake();
  const store = new InkbookSettingsStore(vault, device);
  await store.load();
  values = new SettingsControlValues(store);
});

describe("SettingsControlValues", () => {
  it("reads and writes nested vault values without flattened state", async () => {
    await values.set("toolDefaults.pen.width", "14");
    await values.set("toolDefaults.pen.color", "#6B7280FF");

    expect(values.get("toolDefaults.pen.width")).toBe(14);
    expect(vault.saved.toolDefaults.pen).toMatchObject({
      width: 14,
      color: { type: "rgba", value: "#6B7280FF" },
    });
  });

  it("persists both Select choices in vault defaults", async () => {
    await values.set("toolDefaults.select.area", "lasso");
    await values.set("toolDefaults.select.inclusion", "fully-enclosed");

    expect(values.get("toolDefaults.select.area")).toBe("lasso");
    expect(values.get("toolDefaults.select.inclusion")).toBe("fully-enclosed");
    expect(vault.saved.toolDefaults.select).toEqual({
      area: "lasso",
      inclusion: "fully-enclosed",
    });
  });

  it("persists global and per-kind snapping controls and selection highlights", async () => {
    expect(values.get("selectionHighlightsEnabled")).toBe(true);
    await values.set("selectionHighlightsEnabled", false);
    expect(values.get("selectionHighlightsEnabled")).toBe(false);
    expect(vault.saved.selectionHighlightsEnabled).toBe(false);
    expect(device.saved).toEqual(createBuiltInDeviceSettings());
    await values.set("snapping.enabled", false);
    await values.set("snapping.connections", false);

    expect(values.get("snapping.enabled")).toBe(false);
    expect(values.get("snapping.connections")).toBe(false);
    expect(vault.saved.snapping).toEqual({
      ...createBuiltInSettings().snapping,
      enabled: false,
      connections: false,
    });
  });

  it.each(["auto", "60", "90", "120", "144", "240"])(
    "persists refresh-rate preference %s in the vault scope",
    async (value) => {
      await values.set("refreshRatePreference", value);

      expect(values.get("refreshRatePreference")).toBe(value === "auto" ? "auto" : Number(value));
      expect(vault.saved.refreshRatePreference).toBe(value === "auto" ? "auto" : Number(value));
    },
  );

  it("routes device controls only through local storage", async () => {
    await values.set("device.motion", "reduced");

    expect(device.saved.motion).toBe("reduced");
    expect(vault.saved).toEqual(createBuiltInSettings());
  });

  it("maps the pen-tap insertion toggle onto the persisted device mode", async () => {
    expect(values.get("device.penTapInsertionEnabled")).toBe(false);

    await values.set("device.penTapInsertionEnabled", true);

    expect(values.get("device.penTapInsertionEnabled")).toBe(true);
    expect(device.saved.penTapInsertion).toBe("handwriting");
    expect(vault.saved).toEqual(createBuiltInSettings());
  });

  it("rejects invalid UI values without persisting them", async () => {
    await expect(values.set("toolDefaults.eraser.radius", 65)).rejects.toThrow(
      "Invalid setting value",
    );
    expect(vault.saved.toolDefaults.eraser.radius).toBe(20);
  });

  it("normalizes custom folder paths through the domain loader", async () => {
    await values.set("filePlacement.mode", "custom-vault-folder");
    await values.set("filePlacement.folder", " Notes\\Inkbook/ ");

    expect(vault.saved.filePlacement).toEqual({
      mode: "custom-vault-folder",
      folder: "Notes/Inkbook",
    });
  });
});

describe("SettingsControlValues preload margin", () => {
  it("parses and persists preload margins only in device storage", async () => {
    expect(values.get("device.scrollPreloadMarginPx")).toBe(300);
    await values.set("device.scrollPreloadMarginPx", "799");

    expect(values.get("device.scrollPreloadMarginPx")).toBe(799);
    expect(device.saved.scrollPreloadMarginPx).toBe(799);
    expect(vault.saved).toEqual(createBuiltInSettings());
  });

  it.each([99, 801, 300.5, Number.NaN, Infinity, "", "invalid"])(
    "rejects invalid preload margin %s without persisting it",
    async (value) => {
      await expect(values.set("device.scrollPreloadMarginPx", value)).rejects.toThrow(
        "Invalid setting value",
      );
      expect(values.get("device.scrollPreloadMarginPx")).toBe(300);
      expect(device.saved).toEqual(createBuiltInDeviceSettings());
    },
  );
});

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

describe("SettingsControlValues", () => {
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

  it("reads and writes nested vault values without flattened state", async () => {
    await values.set("toolDefaults.pen.width", "14");
    await values.set("toolDefaults.pen.color", "#3B82F6FF");

    expect(values.get("toolDefaults.pen.width")).toBe(14);
    expect(vault.saved.toolDefaults.pen).toMatchObject({
      width: 14,
      color: { type: "rgba", value: "#3B82F6FF" },
    });
  });

  it("routes device controls only through local storage", async () => {
    await values.set("device.motion", "reduced");

    expect(device.saved.motion).toBe("reduced");
    expect(vault.saved).toEqual(createBuiltInSettings());
  });

  it("rejects invalid UI values without persisting them", async () => {
    await expect(values.set("toolDefaults.eraser.radius", 65)).rejects.toThrow(
      "Invalid setting value",
    );
    expect(vault.saved.toolDefaults.eraser.radius).toBe(24);
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

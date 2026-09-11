import {
  Setting,
  SettingGroup,
  type SettingDefinitionGroup,
  type SettingDefinitionRender,
} from "obsidian";
import { vi } from "vitest";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";
import type { RefreshRateProfileStatus } from "../../../../src/obsidian/performance";
import type { SettingsControlKey } from "../../../../src/obsidian/settings/control-values";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import {
  InkbookSettingsStore,
  type DeviceSettingsPort,
  type VaultSettingsPort,
} from "../../../../src/obsidian/settings/storage";

const confirmActionMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

const platform = vi.hoisted(() => ({ isMobile: false }));

vi.mock("../../../../src/obsidian/dialogs/action-dialog", () => ({
  confirmInkbookAction: confirmActionMock,
}));

vi.mock("obsidian", () => ({
  Platform: platform,
  PluginSettingTab: class {
    public updates = 0;
    public refreshes = 0;
    public constructor(
      public app: unknown,
      public plugin: unknown,
    ) {}
    public update(): void {
      this.updates += 1;
    }
    public refreshDomState(): void {
      this.refreshes += 1;
    }
  },
  Setting: class {
    public constructor(public settingEl: HTMLElement) {}
  },
  SettingGroup: class {
    public constructor(public listEl: HTMLElement) {}
  },
  setIcon: (element: HTMLElement, icon: string) => {
    const svg = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "image/svg+xml",
    ).documentElement;
    svg.setAttribute("data-icon", icon);
    element.append(svg);
  },
}));

export class VaultAdapter implements VaultSettingsPort {
  public failure: Error | undefined;
  public loads = 0;
  public saves = 0;
  public value = createBuiltInSettings();

  public async loadData(): Promise<unknown> {
    this.loads += 1;
    return this.value;
  }

  public async saveData(data: ReturnType<typeof createBuiltInSettings>): Promise<void> {
    this.saves += 1;
    if (this.failure !== undefined) throw this.failure;
    this.value = structuredClone(data);
  }
}

export class DeviceAdapter implements DeviceSettingsPort {
  public loads = 0;
  public saves = 0;
  public value = createBuiltInDeviceSettings();

  public loadLocalStorage(): unknown {
    this.loads += 1;
    return this.value;
  }

  public saveLocalStorage(
    _key: string,
    data: ReturnType<typeof createBuiltInDeviceSettings>,
  ): void {
    this.saves += 1;
    this.value = structuredClone(data);
  }
}

export function groups(tab: InkbookSettingTab): SettingDefinitionGroup<SettingsControlKey>[] {
  return tab
    .getSettingDefinitions()
    .filter(
      (item): item is SettingDefinitionGroup<SettingsControlKey> =>
        "type" in item && item.type === "group",
    );
}

export function createTab(
  store: InkbookSettingsStore,
  refreshRateStatus?: () => RefreshRateProfileStatus,
): InkbookSettingTab {
  return new InkbookSettingTab(
    {} as ConstructorParameters<typeof InkbookSettingTab>[0],
    {} as ConstructorParameters<typeof InkbookSettingTab>[1],
    store,
    undefined,
    refreshRateStatus,
  );
}

export function setPlatformMobile(isMobile: boolean): void {
  platform.isMobile = isMobile;
}

export function renders(
  group: SettingDefinitionGroup<SettingsControlKey>,
): SettingDefinitionRender[] {
  return (group.items ?? []).filter(
    (item): item is SettingDefinitionRender => "render" in item && item.render !== undefined,
  );
}

export function renderDefinition(definition: SettingDefinitionRender): {
  readonly container: HTMLElement;
  readonly cleanup: () => void;
} {
  const container = window.createDiv();
  const cleanup = definition.render(new Setting(container), new SettingGroup(container));
  return { container, cleanup: cleanup ?? (() => undefined) };
}

export function requiredRender(
  definitions: SettingDefinitionRender[],
  name: string,
): SettingDefinitionRender {
  const definition = definitions.find((item) => item.name === name);
  if (definition === undefined) throw new Error(`Missing ${name} settings subsection`);
  return definition;
}

export function control(container: HTMLElement, id: string): HTMLElement {
  const result = container.querySelector<HTMLElement>(`[data-control='${id}']`);
  if (result === null) throw new Error(`Missing ${id} settings control.`);
  return result;
}

export function requiredElement<T extends Element>(container: HTMLElement, selector: string): T {
  const result = container.querySelector<T>(selector);
  if (result === null) throw new Error(`Missing ${selector} element.`);
  return result;
}

export function renderTool(tab: InkbookSettingTab, groupHeading: string, name: string) {
  const group = groups(tab).find((candidate) => candidate.heading === groupHeading);
  if (group === undefined) throw new Error(`Missing ${groupHeading} group.`);
  return renderDefinition(requiredRender(renders(group), name));
}

export const confirmAction = confirmActionMock;

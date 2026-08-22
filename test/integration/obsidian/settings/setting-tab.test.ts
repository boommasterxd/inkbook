// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
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
}));

import {
  Setting,
  SettingGroup,
  type SettingDefinitionAction,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingDefinitionRender,
} from "obsidian";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import type { SettingsControlKey } from "../../../../src/obsidian/settings/control-values";
import {
  InkbookSettingsStore,
  type DeviceSettingsPort,
  type VaultSettingsPort,
} from "../../../../src/obsidian/settings/storage";

class VaultAdapter implements VaultSettingsPort {
  public loads = 0;
  public saves = 0;
  public value = createBuiltInSettings();
  public async loadData(): Promise<unknown> {
    this.loads += 1;
    return this.value;
  }
  public async saveData(data: ReturnType<typeof createBuiltInSettings>): Promise<void> {
    this.saves += 1;
    this.value = structuredClone(data);
  }
}

class DeviceAdapter implements DeviceSettingsPort {
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

function groups(tab: InkbookSettingTab): SettingDefinitionGroup<SettingsControlKey>[] {
  return tab
    .getSettingDefinitions()
    .filter(
      (item): item is SettingDefinitionGroup<SettingsControlKey> =>
        "type" in item && item.type === "group",
    );
}

function createTab(store: InkbookSettingsStore): InkbookSettingTab {
  return new InkbookSettingTab(
    {} as ConstructorParameters<typeof InkbookSettingTab>[0],
    {} as ConstructorParameters<typeof InkbookSettingTab>[1],
    store,
  );
}

function renders(group: SettingDefinitionGroup<SettingsControlKey>): SettingDefinitionRender[] {
  return (group.items ?? []).filter(
    (item): item is SettingDefinitionRender => "render" in item && item.render !== undefined,
  );
}

function installDomCreationAdapter<T extends HTMLElement>(element: T): T {
  const create = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: DomElementInfo | string,
  ): HTMLElementTagNameMap[K] => {
    const child = installDomCreationAdapter(
      element.ownerDocument.createElementNS(
        "http://www.w3.org/1999/xhtml",
        tag,
      ) as HTMLElementTagNameMap[K],
    );
    if (typeof options === "string") child.className = options;
    else if (options !== undefined) {
      if (options.cls !== undefined) child.className = String(options.cls);
      if (typeof options.text === "string") child.textContent = options.text;
      else if (options.text !== undefined) child.append(options.text.cloneNode(true));
    }
    element.append(child);
    return child;
  };
  Object.defineProperties(element, {
    createEl: { configurable: true, value: create },
    createDiv: {
      configurable: true,
      value: (options?: DomElementInfo | string) => create("div", options),
    },
  });
  return element;
}

function renderDefinition(definition: SettingDefinitionRender): {
  readonly container: HTMLElement;
  readonly cleanup: () => void;
} {
  const container = installDomCreationAdapter(
    document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement,
  );
  const cleanup = definition.render(new Setting(container), new SettingGroup(container));
  return { container, cleanup: cleanup ?? (() => undefined) };
}

function requiredRender(
  definitions: SettingDefinitionRender[],
  name: string,
): SettingDefinitionRender {
  const definition = definitions.find((item) => item.name === name);
  if (definition === undefined) throw new Error(`Missing ${name} shape subsection`);
  return definition;
}

function declarativeLabels(
  definitions: readonly SettingDefinitionItem<SettingsControlKey>[],
): string[] {
  const labels: string[] = [];
  for (const definition of definitions) {
    if ("heading" in definition && definition.heading !== undefined) {
      labels.push(definition.heading);
    }
    if ("name" in definition) labels.push(definition.name);
    if (
      "control" in definition &&
      definition.control !== undefined &&
      definition.control.type === "dropdown"
    ) {
      labels.push(...Object.values(definition.control.options));
    }
    if ("items" in definition && definition.items !== undefined) {
      labels.push(...declarativeLabels(definition.items));
    }
  }
  return labels;
}

function renderedLabels(definition: SettingDefinitionRender): string[] {
  const rendered = renderDefinition(definition);
  const labels = [...rendered.container.querySelectorAll("summary, label, option")].flatMap(
    (element) => (element.textContent === null ? [] : [element.textContent]),
  );
  rendered.cleanup();
  return labels;
}

describe("InkbookSettingTab definitions", () => {
  it("returns the required unheaded and headed groups in order without storage access", () => {
    const vault = new VaultAdapter();
    const device = new DeviceAdapter();
    const tab = createTab(new InkbookSettingsStore(vault, device));

    const definitions = tab.getSettingDefinitions();

    expect(groups(tab).map((group) => group.heading)).toEqual([
      undefined,
      "Pen",
      "Highlighter",
      "Straight highlighter",
      "Shapes",
      "Eraser",
      "Input",
      "Interface",
    ]);
    expect(definitions[definitions.length - 1]).toMatchObject({
      name: "Reset all Inkbook settings",
    });
    expect(vault.loads).toBe(0);
    expect(vault.saves).toBe(0);
    expect(device.loads).toBe(0);
    expect(device.saves).toBe(0);
  });

  it("exposes structural pages and conditional folder rows", async () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const tab = createTab(store);
    const general = groups(tab)[0];
    expect(general).toBeDefined();
    expect(general?.items?.map((item) => item.name)).toEqual([
      "Startup tool",
      "File placement",
      "Custom vault folder",
      "Create custom folder",
      "Background",
      "Page buffer",
      "Reset group to defaults",
    ]);
    const customFolder = general?.items?.find((item) => item.name === "Custom vault folder");
    expect(typeof customFolder?.visible === "function" && customFolder.visible()).toBe(false);
    await tab.setControlValue("filePlacement.mode", "custom-vault-folder");
    expect(typeof customFolder?.visible === "function" && customFolder.visible()).toBe(true);
  });
});

describe("InkbookSettingTab shape subsections", () => {
  it("renders deterministic accessible collapsible controls", async () => {
    const store = new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter());
    const tab = createTab(store);
    const allGroups = groups(tab);
    const shapes = allGroups[4];
    expect(shapes).toBeDefined();

    const shapeSections = shapes === undefined ? [] : renders(shapes);
    expect(shapeSections).toHaveLength(10);
    const rectangle = requiredRender(shapeSections, "Rectangle");
    const line = requiredRender(shapeSections, "Line");

    const rectangleRender = renderDefinition(rectangle);
    const details = rectangleRender.container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Rectangle");
    expect(details?.querySelectorAll("select, input[type='range']")).toHaveLength(6);
    const widthId = "inkbook-setting-toolDefaults-shapes-rectangle-outlineWidth";
    const widthControl = details?.querySelector<HTMLSelectElement>(`#${widthId}`);
    expect(details?.querySelector(`label[for='${widthId}']`)?.textContent).toBe("Outline width");
    expect(widthControl?.getAttribute("aria-describedby")).toBe(
      `${widthId}-description ${widthId}-error`,
    );
    expect(widthControl?.value).toBe("4");

    if (widthControl === null || widthControl === undefined)
      throw new Error("Missing width control");
    widthControl.value = "8";
    widthControl.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(store.getVaultSettings().toolDefaults.shapes.rectangle.outlineWidth).toBe(8),
    );
    rectangleRender.cleanup();
    widthControl.value = "12";
    widthControl.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(store.getVaultSettings().toolDefaults.shapes.rectangle.outlineWidth).toBe(8);

    const lineRender = renderDefinition(line);
    expect(lineRender.container.querySelectorAll("select, input[type='range']")).toHaveLength(4);
    expect(lineRender.container.textContent).not.toContain("Fill color");
    lineRender.cleanup();

    const ids = shapeSections.flatMap((section) => {
      const rendered = renderDefinition(section);
      const sectionIds = [...rendered.container.querySelectorAll("[id]")].map(
        (element) => element.id,
      );
      rendered.cleanup();
      return sectionIds;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes the documented eraser range", () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const allGroups = groups(tab);

    const eraser = allGroups[5]?.items?.find((item) => item.name === "Radius");
    expect(eraser && "control" in eraser ? eraser.control : undefined).toMatchObject({
      type: "slider",
      min: 8,
      max: 64,
      step: 4,
    });
  });
});

describe("InkbookSettingTab visible labels", () => {
  it("uses sentence case for every multi-word designation", () => {
    const tab = createTab(new InkbookSettingsStore(new VaultAdapter(), new DeviceAdapter()));
    const definitions = tab.getSettingDefinitions();
    const shapes = groups(tab).find((group) => group.heading === "Shapes");
    if (shapes === undefined) throw new Error("Missing Shapes group");
    const shapeLabels = renders(shapes).flatMap(renderedLabels);
    const multiWordLabels = [...new Set([...declarativeLabels(definitions), ...shapeLabels])]
      .filter((label) => label.includes(" "))
      .sort();
    const sentenceCase = /^[A-Z][A-Za-z0-9-]*(?: (?:[a-z0-9][a-z0-9-]*|Inkbook|Obsidian|2D|3D))*$/u;

    expect(multiWordLabels).toEqual(
      expect.arrayContaining(["Straight highlighter", "Coordinate system"]),
    );
    expect(multiWordLabels.filter((label) => !sentenceCase.test(label))).toEqual([]);
  });
});

describe("InkbookSettingTab reset integration", () => {
  it("requires confirmation before resetting both scopes", async () => {
    const vault = new VaultAdapter();
    const device = new DeviceAdapter();
    const store = new InkbookSettingsStore(vault, device);
    await store.load();
    await store.updateVaultSettings((settings) => ({ ...settings, startupTool: "arrow" }));
    device.value.motion = "full";
    const tab = createTab(store);
    const definitions = tab.getSettingDefinitions();
    const action = definitions[definitions.length - 1] as SettingDefinitionAction;
    const confirmMock = vi.fn(() => false);
    const element = {
      ownerDocument: { defaultView: { confirm: confirmMock } },
    } as unknown as HTMLElement;

    action.action(element, 0);
    await Promise.resolve();
    expect(store.getVaultSettings().startupTool).toBe("arrow");

    confirmMock.mockReturnValue(true);
    action.action(element, 0);
    await vi.waitFor(() => expect(store.getVaultSettings().startupTool).toBe("draw"));
    expect(device.value).toEqual(createBuiltInDeviceSettings());
  });
});

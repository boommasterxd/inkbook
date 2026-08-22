import {
  PluginSettingTab,
  type App,
  type Plugin,
  type SettingDefinitionAction,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
} from "obsidian";

import {
  MOTION_PREFERENCES,
  PEN_TAP_INSERTIONS,
  createBuiltInDeviceSettings,
  createBuiltInSettings,
  type InkbookSettingsV1,
} from "../../domain/settings";
import { SettingsControlValues, type SettingsControlKey } from "./control-values";
import { dropdown, resetAction, slider, toggle } from "./definition-helpers";
import { generalGroup, labels } from "./general-definitions";
import { InkbookSettingsStore } from "./storage";
import { highlighterItems, penItems, shapeSections, toolGroup } from "./tool-definitions";

export interface CustomFolderPort {
  createFolder(path: string): Promise<void>;
}

function cloneDefaults<K extends keyof InkbookSettingsV1["toolDefaults"]>(
  key: K,
): InkbookSettingsV1["toolDefaults"][K] {
  return structuredClone(createBuiltInSettings().toolDefaults[key]);
}

export class InkbookSettingTab extends PluginSettingTab {
  private readonly controls: SettingsControlValues;

  public constructor(
    app: App,
    plugin: Plugin,
    private readonly store: InkbookSettingsStore,
    private readonly folderPort?: CustomFolderPort,
  ) {
    super(app, plugin);
    this.controls = new SettingsControlValues(store);
  }

  public override getControlValue(key: string): unknown {
    return this.controls.get(key as SettingsControlKey);
  }

  public override async setControlValue(key: string, value: unknown): Promise<void> {
    await this.controls.set(key as SettingsControlKey, value);
    this.refreshDomState();
  }

  public override getSettingDefinitions(): SettingDefinitionItem<SettingsControlKey>[] {
    return [
      generalGroup({
        isCustomFolder: () => this.isCustomFolder(),
        canCreateFolder: () => this.folderPort !== undefined && this.isCustomFolder(),
        createFolder: (element) => this.createCustomFolder(element),
        reset: () => this.resetGeneral(),
      }),
      toolGroup("Pen", penItems(), () => this.resetToolGroup("pen")),
      toolGroup("Highlighter", highlighterItems(false), () => this.resetToolGroup("highlighter")),
      toolGroup("Straight highlighter", highlighterItems(true), () =>
        this.resetToolGroup("straightHighlighter"),
      ),
      this.shapesGroup(),
      toolGroup(
        "Eraser",
        [
          slider(
            "toolDefaults.eraser.radius",
            "Radius",
            "Set the screen-relative radius for the eraser.",
            8,
            64,
            4,
          ),
        ],
        () => this.resetToolGroup("eraser"),
      ),
      ...this.deviceGroups(),
      this.resetAllAction(),
    ];
  }

  private isCustomFolder(): boolean {
    return this.store.getVaultSettings().filePlacement.mode === "custom-vault-folder";
  }

  private createCustomFolder(element: HTMLElement): void {
    const placement = this.store.getVaultSettings().filePlacement;
    if (placement.mode !== "custom-vault-folder") return;
    const confirmed = element.ownerDocument.defaultView?.confirm(
      `Create the vault folder “${placement.folder}”?`,
    );
    if (confirmed === true) void this.folderPort?.createFolder(placement.folder);
  }

  private resetGeneral(): void {
    const defaults = createBuiltInSettings();
    void this.store
      .updateVaultSettings((settings) => ({
        ...settings,
        startupTool: defaults.startupTool,
        pageDefaults: structuredClone(defaults.pageDefaults),
        filePlacement: structuredClone(defaults.filePlacement),
      }))
      .then(() => this.update());
  }

  private resetToolGroup<K extends keyof InkbookSettingsV1["toolDefaults"]>(key: K): void {
    void this.store
      .updateVaultSettings((settings) => {
        settings.toolDefaults[key] = cloneDefaults(key);
        return settings;
      })
      .then(() => this.update());
  }

  private shapesGroup(): SettingDefinitionGroup<SettingsControlKey> {
    return {
      type: "group",
      heading: "Shapes",
      items: [
        ...shapeSections({
          get: (key) => this.controls.get(key),
          set: async (key, value) => {
            await this.controls.set(key, value);
          },
        }),
        resetAction("Reset group to defaults", () => {
          void this.store
            .updateVaultSettings((settings) => {
              settings.toolDefaults.shapes = cloneDefaults("shapes");
              settings.toolDefaults.arrow = cloneDefaults("arrow");
              settings.toolDefaults.coordinateSystem = cloneDefaults("coordinateSystem");
              settings.toolDefaults.table = cloneDefaults("table");
              return settings;
            })
            .then(() => this.update());
        }),
      ],
    };
  }

  private deviceGroups(): SettingDefinitionGroup<SettingsControlKey>[] {
    const defaults = createBuiltInDeviceSettings();
    return [this.inputGroup(defaults), this.interfaceGroup(defaults)];
  }

  private inputGroup(
    defaults: ReturnType<typeof createBuiltInDeviceSettings>,
  ): SettingDefinitionGroup<SettingsControlKey> {
    return {
      type: "group",
      heading: "Input",
      items: [
        toggle(
          "device.fingerDrawingEnabled",
          "Finger drawing",
          "Show the session-only finger drawing toggle in each embed.",
        ),
        dropdown(
          "device.penTapInsertion",
          "Pen-tap insertion",
          "Choose how a pen tap inserts an Inkbook embed.",
          labels(PEN_TAP_INSERTIONS),
        ),
        resetAction("Reset group to defaults", () => {
          this.store.updateDeviceSettings((settings) => ({
            ...settings,
            fingerDrawingEnabled: defaults.fingerDrawingEnabled,
            penTapInsertion: defaults.penTapInsertion,
          }));
          this.update();
        }),
      ],
    };
  }

  private interfaceGroup(
    defaults: ReturnType<typeof createBuiltInDeviceSettings>,
  ): SettingDefinitionGroup<SettingsControlKey> {
    return {
      type: "group",
      heading: "Interface",
      items: [
        toggle(
          "device.leftHandedToolbar",
          "Left-handed toolbar",
          "Align the toolbar for left-handed use.",
        ),
        dropdown(
          "device.motion",
          "Motion",
          "Choose how Inkbook presents non-essential motion.",
          labels(MOTION_PREFERENCES),
        ),
        resetAction("Reset group to defaults", () => {
          this.store.updateDeviceSettings((settings) => ({
            ...settings,
            leftHandedToolbar: defaults.leftHandedToolbar,
            motion: defaults.motion,
          }));
          this.update();
        }),
      ],
    };
  }

  private resetAllAction(): SettingDefinitionAction {
    return {
      name: "Reset all Inkbook settings",
      desc: "Restore every built-in value without changing existing files or elements.",
      action: (element) => {
        if (element.ownerDocument.defaultView?.confirm("Reset all Inkbook settings?") === true) {
          void this.store.resetAll().then(() => this.update());
        }
      },
    };
  }
}

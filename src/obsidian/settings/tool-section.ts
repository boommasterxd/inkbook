import type { Setting, SettingDefinitionRender } from "obsidian";

import type { InkbookDeviceSettingsV2, StartupToolV1, ToolDefaultsV1 } from "../../domain/settings";
import { createToolStyleControls } from "../menus/tool-style-controls";
import type { SettingsControlKey } from "./control-values";
import { renderSettingsControlContent } from "./settings-control-content";
import { createSettingsDisclosure } from "./settings-disclosure";
import { SettingsPanelMotion } from "./settings-panel-motion";

export interface ToolSectionSpec {
  readonly controlDescriptions: Readonly<Record<string, string>>;
  readonly controlKeys: Readonly<Record<string, SettingsControlKey>>;
  readonly description: string;
  readonly name: string;
  readonly tool: StartupToolV1;
}

export interface ToolSectionValues {
  readonly getDefaults: () => ToolDefaultsV1;
  readonly getMotion: () => InkbookDeviceSettingsV2["motion"];
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
}

export function toolSectionDefinition(
  spec: ToolSectionSpec,
  values: ToolSectionValues,
): SettingDefinitionRender {
  return {
    name: spec.name,
    desc: spec.description,
    render: (setting) => renderToolSection(setting, spec, values),
  };
}

function renderToolSection(
  setting: Setting,
  spec: ToolSectionSpec,
  values: ToolSectionValues,
): () => void {
  setting.settingEl.replaceChildren();
  setting.settingEl.classList.add("inkbook-settings-tool-row");
  const panelId = `inkbook-settings-tool-${spec.tool}`;
  const {
    content: panelContent,
    panel,
    trigger,
  } = createSettingsDisclosure(setting.settingEl, {
    description: spec.description,
    expanded: false,
    panelId,
    title: spec.name,
  });
  const controls = panelContent.createDiv({ cls: "inkbook-settings-tool-controls" });
  let initialized = false;

  const panelMotion = new SettingsPanelMotion(panel, values.getMotion);
  const toggle = (): void => {
    const expanded = trigger.getAttribute("aria-expanded") !== "true";
    if (expanded && !initialized) {
      renderSettingsControlContent(controls, {
        controls: () => createToolStyleControls(values.getDefaults(), spec.tool),
        descriptions: spec.controlDescriptions,
        idPrefix: panelId,
        onChange: (controlId, value) => setToolControl(spec, values, controlId, value),
        ownerDocument: setting.settingEl.ownerDocument,
      });
      initialized = true;
    }
    trigger.setAttribute("aria-expanded", String(expanded));
    panelMotion.setExpanded(expanded);
  };
  trigger.addEventListener("click", toggle);
  return () => {
    trigger.removeEventListener("click", toggle);
    panelMotion.dispose();
  };
}

function setToolControl(
  spec: ToolSectionSpec,
  values: ToolSectionValues,
  controlId: string,
  value: boolean | number | string,
): Promise<void> {
  const key = spec.controlKeys[controlId];
  return key === undefined
    ? Promise.reject(new RangeError(`Missing settings key for ${spec.tool}.${controlId}.`))
    : values.set(key, value);
}

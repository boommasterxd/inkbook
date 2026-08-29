import { Platform, setIcon, type Setting, type SettingDefinitionRender } from "obsidian";

import type { StartupToolV1, ToolDefaultsV1 } from "../../domain/settings";
import { createToolStyleControls } from "../menus/tool-style-controls";
import type { SettingsControlKey } from "./control-values";
import { renderSettingsControlContent } from "./settings-control-content";

export interface ToolSectionSpec {
  readonly controlDescriptions: Readonly<Record<string, string>>;
  readonly controlKeys: Readonly<Record<string, SettingsControlKey>>;
  readonly description: string;
  readonly name: string;
  readonly tool: StartupToolV1;
}

export interface ToolSectionValues {
  readonly getDefaults: () => ToolDefaultsV1;
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
  const section = setting.settingEl.createEl("section", { cls: "inkbook-settings-tool-section" });
  const trigger = section.createEl("button", { cls: "inkbook-settings-tool-trigger" });
  if (Platform.isMobile) trigger.classList.add("inkbook-settings-tool-trigger-touch");
  const panelId = `inkbook-settings-tool-${spec.tool}`;
  const descriptionId = `${panelId}-description`;
  trigger.type = "button";
  trigger.setAttribute("aria-controls", panelId);
  trigger.setAttribute("aria-describedby", descriptionId);
  trigger.setAttribute("aria-expanded", "false");
  trigger.createSpan({ cls: "inkbook-settings-tool-title", text: spec.name });
  const accessibleDescription = trigger.createSpan({
    cls: "inkbook-menu-visually-hidden",
    text: spec.description,
  });
  accessibleDescription.id = descriptionId;
  const chevron = trigger.createSpan({ cls: "inkbook-settings-tool-chevron" });
  setIcon(chevron, "chevron-right");

  const panel = section.createDiv({ cls: "inkbook-settings-tool-panel" });
  panel.id = panelId;
  panel.hidden = true;
  panel.createEl("p", {
    cls: "inkbook-settings-tool-description",
    text: spec.description,
  });
  const controls = panel.createDiv({ cls: "inkbook-settings-tool-controls" });
  renderSettingsControlContent(controls, {
    controls: () => createToolStyleControls(values.getDefaults(), spec.tool),
    descriptions: spec.controlDescriptions,
    idPrefix: panelId,
    onChange: (controlId, value) => setToolControl(spec, values, controlId, value),
    ownerDocument: setting.settingEl.ownerDocument,
  });

  const toggle = (): void => {
    const expanded = trigger.getAttribute("aria-expanded") !== "true";
    trigger.setAttribute("aria-expanded", String(expanded));
    panel.hidden = !expanded;
  };
  trigger.addEventListener("click", toggle);
  return () => trigger.removeEventListener("click", toggle);
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

import type { StyleChoiceOption, StyleControl } from "../../menus/editor-menu-types";
import type { Translator } from "../../../domain/localization";
import type { Keymap, Setting, SettingDefinitionRender } from "obsidian";

import type {
  InkbookDeviceSettingsV2,
  StartupToolV1,
  ToolDefaultsV1,
} from "../../../domain/settings";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { isReducedMotion } from "../../../rendering/motion/transitions";
import { createToolStyleControls } from "../../menus/tool-style-controls";
import type { SettingsControlKey } from "../control-values";
import { renderSettingsControlContent } from "../settings-control-content";
import { createSettingsDisclosure } from "../settings-disclosure";
import { SettingsPanelMotion } from "../settings-panel-motion";
import { SettingsViewState } from "../settings-view-state";
import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";
import type {
  FontOptionPreviewPort,
  FontChoiceDropdownOptions,
} from "../../menus/font-choice-dropdown";

export interface ToolSectionSpec {
  readonly controlDescriptions: Readonly<Record<string, string>>;
  readonly controlKeys: Readonly<Record<string, SettingsControlKey>>;
  readonly description: string;
  readonly name: string;
  readonly tool: StartupToolV1;
}

export interface ToolSectionValues {
  readonly keymap?: Pick<Keymap, "pushScope" | "popScope"> | undefined;
  readonly createFontPreviews?: (document: Document) => FontOptionPreviewPort & { dispose(): void };
  readonly fontManagementAction?: FontChoiceDropdownOptions["fontManagementAction"];
  readonly t?: Translator;
  readonly viewState?: SettingsViewState;
  readonly observeMotion?: NativeControlFeedbackOptions["observeMotion"];
  readonly workScheduler: (ownerWindow: Window | null) => WorkScheduler;
  readonly getDefaults: () => ToolDefaultsV1;
  readonly getTextFontOptions?: () => readonly StyleChoiceOption[];
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
  const viewState = values.viewState ?? new SettingsViewState();
  const stateKey = `tool:${spec.tool}`;
  const initiallyExpanded = viewState.expandedSections.has(stateKey);
  const {
    content: panelContent,
    panel,
    trigger,
    setExpanded,
    dispose,
  } = createSettingsDisclosure(setting.settingEl, {
    description: spec.description,
    deferDescriptionUntilExpanded: true,
    expanded: initiallyExpanded,
    panelId,
    readMotion: values.getMotion,
    ...(values.observeMotion === undefined ? {} : { observeMotion: values.observeMotion }),
    title: spec.name,
  });
  let initialized = false;
  let releaseControls: (() => void) | undefined;

  const initializeControls = (): void => {
    if (!initialized) {
      const controls = panelContent.createDiv({ cls: "inkbook-settings-tool-controls" });
      const previews =
        spec.tool === "text"
          ? values.createFontPreviews?.(setting.settingEl.ownerDocument)
          : undefined;
      const release = renderSettingsControlContent(controls, {
        workScheduler: values.workScheduler(setting.settingEl.ownerDocument.defaultView),
        fontPreviews: previews,
        fontManagementAction: spec.tool === "text" ? values.fontManagementAction : undefined,
        keymap: values.keymap,
        ...(values.t === undefined ? {} : { t: values.t }),
        controls: () => toolSectionControls(spec, values),
        descriptions: spec.controlDescriptions,
        idPrefix: panelId,
        onChange: (controlId, value) => setToolControl(spec, values, controlId, value),
        ownerDocument: setting.settingEl.ownerDocument,
        readMotion: values.getMotion,
        ...(values.observeMotion === undefined ? {} : { observeMotion: values.observeMotion }),
      });
      releaseControls = () => {
        release();
        previews?.dispose();
      };
      initialized = true;
    }
  };
  if (initiallyExpanded) initializeControls();
  const panelMotion = new SettingsPanelMotion(panel, values.getMotion, values.observeMotion);
  const toggle = (): void => {
    const expanded = trigger.getAttribute("aria-expanded") !== "true";
    if (expanded) {
      initializeControls();
      viewState.expandedSections.add(stateKey);
    } else viewState.expandedSections.delete(stateKey);
    trigger.setAttribute("aria-expanded", String(expanded));
    setExpanded(
      expanded,
      isReducedMotion(
        values.getMotion(),
        panel.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    );
    panelMotion.setExpanded(expanded);
  };
  trigger.addEventListener("click", toggle);
  return () => {
    trigger.removeEventListener("click", toggle);
    releaseControls?.();
    dispose();
    panelMotion.dispose();
  };
}

function toolSectionControls(
  spec: ToolSectionSpec,
  values: ToolSectionValues,
): readonly StyleControl[] {
  return createToolStyleControls(
    values.getDefaults(),
    spec.tool,
    values.t,
    spec.tool === "text" ? values.getTextFontOptions?.() : undefined,
  );
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

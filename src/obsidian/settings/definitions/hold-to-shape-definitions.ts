import { createEnglishLocalization, type Translator } from "../../../domain/localization";
import type { SettingDefinitionGroup, SettingDefinitionRender } from "obsidian";

import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";
import type { SettingsControlKey } from "../control-values";
import { renderSettingsControlContent } from "../settings-control-content";
import { createSettingsVisualControlRow } from "../settings-row";
import { resetAction, toggle } from "./definition-helpers";

interface HoldToShapeValues extends NativeControlFeedbackOptions {
  readonly t?: Translator;
  readonly observeMotion: NonNullable<NativeControlFeedbackOptions["observeMotion"]>;
  readonly get: (key: SettingsControlKey) => unknown;
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
}

interface HoldNumberDefinition {
  readonly key: "holdToShape.holdDurationMs" | "holdToShape.jitterTolerancePx";
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export function holdToShapeGroup(
  values: HoldToShapeValues,
  reset: () => void | Promise<void>,
): SettingDefinitionGroup<SettingsControlKey> {
  const t = values.t ?? createEnglishLocalization().t;
  return {
    type: "group",
    heading: t("settings.controls.holdToShape"),
    cls: "inkbook-hold-to-shape-group",
    items: [
      toggle(
        "holdToShape.enabled",
        t("settings.controls.holdEnabled"),
        t("settings.controls.holdEnabledHelp"),
      ),
      holdNumberDefinition(values, {
        id: "hold-duration-ms",
        key: "holdToShape.holdDurationMs",
        name: t("settings.controls.holdDelay"),
        description: t("settings.controls.holdDelayHelp"),
        min: 200,
        max: 2000,
        step: 50,
      }),
      holdNumberDefinition(values, {
        id: "jitter-tolerance-px",
        key: "holdToShape.jitterTolerancePx",
        name: t("settings.controls.holdTolerance"),
        description: t("settings.controls.holdToleranceHelp"),
        min: 1,
        max: 32,
        step: 1,
      }),
      resetAction(t("settings.controls.resetGroup"), reset, t),
    ],
  };
}

function holdNumberDefinition(
  values: HoldToShapeValues,
  definition: HoldNumberDefinition,
): SettingDefinitionRender {
  return {
    name: definition.name,
    desc: definition.description,
    render: (setting) => {
      const content = createSettingsVisualControlRow(
        setting,
        definition.name,
        definition.description,
      );
      const release = renderSettingsControlContent(content, {
        ...(values.t === undefined ? {} : { t: values.t }),
        controls: () => [
          {
            id: definition.id,
            kind: "number",
            label: definition.name,
            min: definition.min,
            max: definition.max,
            step: definition.step,
            value: Number(values.get(definition.key)),
          },
        ],
        descriptions: { [definition.id]: definition.description },
        idPrefix: `inkbook-setting-${definition.id}`,
        onChange: (_controlId, value) => values.set(definition.key, value),
        ownerDocument: setting.settingEl.ownerDocument,
        readMotion: values.readMotion,
        observeMotion: values.observeMotion,
      });
      const disabled = values.get("holdToShape.enabled") !== true;
      setting.setDisabled(disabled);
      for (const input of content.querySelectorAll<HTMLInputElement>("input")) {
        input.disabled = disabled;
      }
      return release;
    },
  };
}

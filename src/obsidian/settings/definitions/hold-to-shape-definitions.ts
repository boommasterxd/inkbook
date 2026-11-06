import type { SettingDefinitionGroup, SettingDefinitionRender } from "obsidian";

import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";
import type { SettingsControlKey } from "../control-values";
import { renderSettingsControlContent } from "../settings-control-content";
import { createSettingsVisualControlRow } from "../settings-row";
import { resetAction, toggle } from "./definition-helpers";

interface HoldToShapeValues extends NativeControlFeedbackOptions {
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
  return {
    type: "group",
    heading: "Hold to shape",
    cls: "inkbook-hold-to-shape-group",
    items: [
      toggle(
        "holdToShape.enabled",
        "Enable hold to shape",
        "Hold the end of a pen stroke still to recognize a shape. Changes apply to the next stroke.",
      ),
      holdNumberDefinition(values, {
        id: "hold-duration-ms",
        key: "holdToShape.holdDurationMs",
        name: "Hold delay",
        description:
          "Choose how long to hold still before the shape preview appears, from 200 to 2000 milliseconds.",
        min: 200,
        max: 2000,
        step: 50,
      }),
      holdNumberDefinition(values, {
        id: "jitter-tolerance-px",
        key: "holdToShape.jitterTolerancePx",
        name: "Movement tolerance",
        description:
          "Allow this much movement while holding, from 1 to 32 screen pixels, independent of zoom.",
        min: 1,
        max: 32,
        step: 1,
      }),
      resetAction("Reset group to defaults", reset),
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

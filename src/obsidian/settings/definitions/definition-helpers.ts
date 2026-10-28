import type { SettingDefinition, SettingDefinitionRender } from "obsidian";

import type { SettingsControlKey } from "../control-values";
import { bindSettingsAction, type InkbookSettingActionTone } from "../settings-row";
import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";
import { createSettingsWriteError, SettingsWriteFeedback } from "../settings-write-feedback";

interface SettingsActionFeedback {
  readonly feedback?: NativeControlFeedbackOptions;
}

/** Carries the owning settings preference through existing group callback interfaces. */
export function withSettingsActionFeedback<
  Action extends (...arguments_: never[]) => void | Promise<void>,
>(activate: Action, feedback: NativeControlFeedbackOptions): Action & SettingsActionFeedback {
  return Object.assign(activate, { feedback });
}

export function sentenceCaseLabel(value: string): string {
  const words = value.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function dropdown(
  key: SettingsControlKey,
  name: string,
  desc: string,
  options: Record<string, string>,
): SettingDefinition<SettingsControlKey> {
  return { name, desc, control: { type: "dropdown", key, options } };
}

export function toggle(
  key: SettingsControlKey,
  name: string,
  desc: string,
): SettingDefinition<SettingsControlKey> {
  return { name, desc, control: { type: "toggle", key } };
}

export function settingsAction(
  name: string,
  desc: string,
  tone: InkbookSettingActionTone | undefined,
  activate: ((element: HTMLElement) => void | Promise<void>) & SettingsActionFeedback,
  failureMessage?: string,
): SettingDefinitionRender {
  return {
    name,
    desc,
    render: (setting) => {
      const element = setting.settingEl;
      const writes = new SettingsWriteFeedback();
      const error = createSettingsWriteError(
        element,
        activate.feedback ?? {
          readMotion: () => "system",
        },
      );
      error.associate(element);
      const unbind = bindSettingsAction(
        element,
        () => {
          void writes.run("action", () => activate(element), {
            error: error.set,
            restore: () => undefined,
            ...(failureMessage === undefined ? {} : { failureMessage }),
          });
        },
        tone,
      );
      return () => {
        unbind();
        writes.dispose();
        error.dispose();
      };
    },
  };
}

export function resetAction(
  name: string,
  activate: (() => void | Promise<void>) & SettingsActionFeedback,
): SettingDefinitionRender {
  return settingsAction(
    name,
    "Restore the built-in values without changing existing files or elements.",
    "caution",
    activate,
  );
}

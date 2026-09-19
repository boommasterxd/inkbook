import type { PhoneSheetNavigation } from "../menus/panel-page";
import type { PhoneSheetHostPort } from "../menus/phone-sheet-host";
import type { Keymap } from "obsidian";

import type { InkbookDeviceSettingsV2, InkbookSettingsV4 } from "../../domain/settings/types";
import type { InkbookFeedbackCode } from "../feedback";
import type { ObsidianEmbedActions } from "../commands";
import { ActiveInkbookScene } from "./active-scene";
import type { ActiveDocumentEditorContext } from "./vault-document-session";
import { copyWorkspaceEmbed, deleteWorkspaceEmbed } from "./workspace-embed-actions";
import { presentationPreviewOptions, type PresentationAttachment } from "./presentation-port";

export interface WorkspaceRuntimeSettings {
  readonly device: InkbookDeviceSettingsV2;
  readonly vault: InkbookSettingsV4;
}

export interface WorkspaceActiveSceneOptions {
  readonly confirmEraseAll?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly attachment: PresentationAttachment;
  readonly backgroundSpacing: () => InkbookSettingsV4["pageDefaults"]["backgroundSpacing"];
  readonly deviceSettings: InkbookDeviceSettingsV2;
  readonly editorContext: ActiveDocumentEditorContext;
  readonly embedActions: ObsidianEmbedActions;
  readonly isCurrent: (scene: ActiveInkbookScene) => boolean;
  readonly createPhoneSheetHost?: () => PhoneSheetHostPort;
  readonly keymap: Pick<Keymap, "popScope" | "pushScope"> | undefined;
  readonly markFirstStroke: () => void;
  readonly onLock: () => void;
  readonly onOpenSettings: (navigation?: PhoneSheetNavigation) => void;
  readonly onOpenShortcuts: (navigation?: PhoneSheetNavigation) => void;
  readonly scheme: "dark" | "light";
  readonly showFeedback: (code: InkbookFeedbackCode) => void;
  readonly sliceBudgetMs: () => number;
  readonly vaultSettings: InkbookSettingsV4;
}

export function createWorkspaceActiveScene(
  options: WorkspaceActiveSceneOptions,
): ActiveInkbookScene {
  const attachment = options.attachment;
  let scene: ActiveInkbookScene | undefined;
  scene = new ActiveInkbookScene({
    backgroundSpacing: options.backgroundSpacing,
    confirmEraseAll: options.confirmEraseAll,
    defaults: options.vaultSettings.toolDefaults,
    deviceSettings: options.deviceSettings,
    history: options.editorContext.history,
    ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
    ...(options.createPhoneSheetHost === undefined
      ? {}
      : { createPhoneSheetHost: options.createPhoneSheetHost }),
    model: options.editorContext.model,
    onLock: options.onLock,
    onFeedback: options.showFeedback,
    onCopyEmbed: () => {
      void copyWorkspaceEmbed(options.embedActions, attachment.embedReference, {
        show: options.showFeedback,
      });
    },
    onDeleteEmbed: () => {
      const invokingScene = scene;
      if (invokingScene === undefined) return;
      void deleteWorkspaceEmbed({
        actions: options.embedActions,
        feedback: { show: options.showFeedback },
        isCurrent: () => options.isCurrent(invokingScene),
        reference: attachment.embedReference,
        ...(attachment.removal === undefined ? {} : { removal: attachment.removal }),
        scene: invokingScene,
      });
    },
    onFirstStrokeCommitted: options.markFirstStroke,
    onOpenSettings: options.onOpenSettings,
    onOpenShortcuts: options.onOpenShortcuts,
    root: attachment.root,
    scheme: options.scheme,
    scrollOwner: attachment.scrollOwner,
    sliceBudgetMs: options.sliceBudgetMs,
    selectionHighlightsEnabled: options.vaultSettings.selectionHighlightsEnabled,
    snapping: options.vaultSettings.snapping,
    startupTool: options.vaultSettings.startupTool,
    ...presentationPreviewOptions(attachment),
  });
  return scene;
}

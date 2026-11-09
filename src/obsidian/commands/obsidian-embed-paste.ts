import { Localization } from "../../domain/localization";
import type { App } from "obsidian";

import type { InkbookSettingsStore } from "../settings";
import type { PlacementFallbackFeedbackPort } from "./command-ports";
import { EmbedPasteController } from "./embed-paste";
import { chooseInkbookAction } from "../dialogs/action-dialog";
import {
  validateDocumentOutput,
  type DocumentOutputScheduling,
} from "./document-output-validation";
import type { ObsidianInkbookDocumentRecognition } from "../embeds/preview/document-recognition";
import {
  activeMarkdownOwnerWindow,
  createObsidianCommandVaultPorts,
  notifyPlacementFallback,
} from "./obsidian-host";

export function createObsidianEmbedPasteController(
  app: App,
  settings: InkbookSettingsStore,
  placementFeedback: PlacementFallbackFeedbackPort,
  signal?: AbortSignal,
  recognition?: ObsidianInkbookDocumentRecognition,
  scheduling?: DocumentOutputScheduling & { readonly localization?: Localization },
): EmbedPasteController {
  const localization = scheduling?.localization ?? new Localization();
  const { files, links, managedFiles, placement } = createObsidianCommandVaultPorts(
    app,
    () => true,
  );
  return new EmbedPasteController({
    ...(signal === undefined ? {} : { signal }),
    ...(recognition === undefined ? {} : { confirmedOutput: recognition }),
    choices: {
      choose: () =>
        chooseInkbookAction(app, {
          workScheduler: scheduling?.workScheduler,
          localization,
          ...(signal === undefined ? {} : { signal }),
          readMotion: () => settings.getDeviceSettings().motion,
          observeMotion: (listener) => settings.subscribeDeviceSettings(listener),
          title: () => localization.t("host.dialog.pasteTitle"),
          description: () => localization.t("host.dialog.pasteDescription"),
          actions: [
            {
              value: "reference",
              label: () => localization.t("host.dialog.reference"),
              description: () => localization.t("host.dialog.referenceDescription"),
            },
            {
              value: "duplicate",
              label: () => localization.t("host.dialog.copy"),
              description: () => localization.t("host.dialog.copyDescription"),
            },
          ],
        }),
    },
    documents: {
      createOwnedAndReadBack: (path, content, maximumBytes, onCreated) =>
        files.createOwnedAndReadBack(path, content, maximumBytes, onCreated),
      readWithMetadataGuard: (path, maximumBytes) =>
        files.readWithMetadataGuard(path, maximumBytes),
    },
    links,
    placement: {
      preparePath: async (sourcePath) => {
        const resolved = await placement.resolve(
          settings.getVaultSettings().filePlacement,
          sourcePath,
          new Date(),
          { fill: (bytes) => activeMarkdownOwnerWindow(app).crypto.getRandomValues(bytes) },
        );
        notifyPlacementFallback(resolved.fallback, placementFeedback);
        return resolved.path;
      },
    },
    trash: managedFiles,
    validation: {
      validate: (content) => {
        if (scheduling === undefined) throw new Error("Embed paste requires a work scheduler.");
        return validateDocumentOutput(app, content, scheduling);
      },
    },
  });
}

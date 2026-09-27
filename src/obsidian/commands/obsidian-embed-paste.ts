import type { App } from "obsidian";

import type { InkbookSettingsStore } from "../settings";
import type { PlacementFallbackFeedbackPort } from "./command-ports";
import { EmbedPasteController } from "./embed-paste";
import { chooseInkbookAction } from "../dialogs/action-dialog";
import { validateDocumentOutput } from "./document-output-validation";
import type { ObsidianInkbookDocumentRecognition } from "../embeds/document-recognition";
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
): EmbedPasteController {
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
          ...(signal === undefined ? {} : { signal }),
          readMotion: () => settings.getDeviceSettings().motion,
          title: "Paste Inkbook embed",
          description: "Choose how this drawing should be inserted.",
          actions: [
            {
              value: "reference",
              label: "Insert reference",
              description: "Edits appear in every embed that uses this file.",
            },
            {
              value: "duplicate",
              label: "Create copy",
              description: "Create an independent SVG copy.",
            },
          ],
        }),
    },
    documents: {
      createAndReadBack: (path, content, maximumBytes) =>
        files.createAndReadBack(path, content, maximumBytes),
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
    validation: { validate: (content) => validateDocumentOutput(app, content) },
  });
}

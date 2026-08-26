import type { App } from "obsidian";

import type { InkbookSettingsStore } from "../settings";
import type { PlacementFallbackFeedbackPort } from "./command-ports";
import { EmbedPasteController, OwnerWindowEmbedPasteChoice } from "./embed-paste";
import { validateDocumentOutput } from "./document-output-validation";
import {
  activeMarkdownOwnerWindow,
  createObsidianCommandVaultPorts,
  notifyPlacementFallback,
} from "./obsidian-host";

export function createObsidianEmbedPasteController(
  app: App,
  settings: InkbookSettingsStore,
  placementFeedback: PlacementFallbackFeedbackPort,
): EmbedPasteController {
  const { files, links, managedFiles, placement } = createObsidianCommandVaultPorts(
    app,
    () => true,
  );
  return new EmbedPasteController({
    choices: {
      choose: () => new OwnerWindowEmbedPasteChoice(activeMarkdownOwnerWindow(app)).choose(),
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

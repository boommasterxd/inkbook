import type { App } from "obsidian";

import {
  CANONICAL_LOCKED_BUFFER_LINES,
  type BackgroundV1,
  type InkSnapshotV1,
} from "../../domain/schema/public";
import type { InkbookSettingsStore } from "../settings";
import { serializeInkbookDocument } from "../../persistence/serialization/public";
import {
  EmptyLineInsertionController,
  type EmptyLineInsertionNotifications,
} from "./empty-line-insertion";
import type { PlacementFallbackFeedbackPort } from "./command-ports";
import {
  validateDocumentOutput,
  type DocumentOutputScheduling,
} from "./document-output-validation";
import {
  activeMarkdownOwnerWindow,
  createObsidianCommandVaultPorts,
  notifyPlacementFallback,
} from "./obsidian-host";

function snapshotBackground(settings: InkbookSettingsStore): BackgroundV1 {
  const page = settings.getVaultSettings().pageDefaults;
  switch (page.backgroundType) {
    case "none":
      return { type: "none" };
    case "lines":
      return { spacing: page.backgroundSpacing.lines, type: "lines" };
    case "dots":
      return { spacing: page.backgroundSpacing.dots, type: "dots" };
    case "squares":
      return { spacing: page.backgroundSpacing.squares, type: "squares" };
  }
}

function emptySnapshot(settings: InkbookSettingsStore): InkSnapshotV1 {
  const page = settings.getVaultSettings().pageDefaults;
  return {
    elements: [],
    format: "inkbook",
    page: {
      activeBufferLines: page.activeBufferLines,
      background: snapshotBackground(settings),
      innerWidth: 2000,
      lockedBufferLines: CANONICAL_LOCKED_BUFFER_LINES,
      margin: 24.3,
    },
    revision: 0,
    version: 1,
  };
}

function fillRandomBytes(app: App, bytes: Uint8Array<ArrayBuffer>): void {
  activeMarkdownOwnerWindow(app).crypto.getRandomValues(bytes);
}

export function createObsidianInsertionController(
  app: App,
  settings: InkbookSettingsStore,
  notifications: EmptyLineInsertionNotifications,
  placementFeedback: PlacementFallbackFeedbackPort,
  scheduling: DocumentOutputScheduling,
): EmptyLineInsertionController {
  const { files, links, managedFiles, placement } = createObsidianCommandVaultPorts(
    app,
    () => true,
  );
  return new EmptyLineInsertionController({
    documents: {
      prepare: async (sourcePath) => {
        const resolved = await placement.resolve(
          settings.getVaultSettings().filePlacement,
          sourcePath,
          new Date(),
          { fill: (bytes) => fillRandomBytes(app, bytes) },
        );
        notifyPlacementFallback(resolved.fallback, placementFeedback);
        const serialized = serializeInkbookDocument(emptySnapshot(settings));
        if (!serialized.ok) throw new Error(serialized.error.message);
        return { content: serialized.value.svg, path: resolved.path };
      },
      verifyCreated: (content) => {
        return validateDocumentOutput(app, content, scheduling);
      },
    },
    files,
    links,
    notifications,
    trash: managedFiles,
  });
}

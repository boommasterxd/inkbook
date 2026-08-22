import type { App } from "obsidian";

import type { BackgroundV1, InkSnapshotV1 } from "../../domain/schema/public";
import type { InkbookSettingsStore } from "../settings";
import { serializeInkbookDocument } from "../../persistence/serialization/public";
import {
  EmptyLineInsertionController,
  type EmptyLineInsertionNotifications,
} from "./empty-line-insertion";
import type { PlacementFallbackNoticePort } from "./command-ports";
import { validateDocumentOutput } from "./document-output-validation";
import {
  activeMarkdownOwnerWindow,
  createObsidianCommandVaultPorts,
  notifyPlacementFallback,
  ObsidianPlacementFallbackNoticeAdapter,
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
      lockedBufferLines: page.lockedBufferLines,
      margin: 24.3,
      writingLineHeight: page.writingLineHeight,
    },
    revision: 0,
    version: 1,
  };
}

function fillRandomBytes(app: App, bytes: Uint8Array): void {
  activeMarkdownOwnerWindow(app).crypto.getRandomValues(bytes);
}

export function createObsidianInsertionController(
  app: App,
  settings: InkbookSettingsStore,
  notifications: EmptyLineInsertionNotifications,
  placementNotices: PlacementFallbackNoticePort = new ObsidianPlacementFallbackNoticeAdapter(),
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
        notifyPlacementFallback(resolved.fallback, placementNotices);
        const serialized = serializeInkbookDocument(emptySnapshot(settings));
        if (!serialized.ok) throw new Error(serialized.error.message);
        return { content: serialized.value.svg, path: resolved.path };
      },
      verifyCreated: (content) => validateDocumentOutput(app, content),
    },
    files,
    links,
    notifications,
    trash: managedFiles,
  });
}

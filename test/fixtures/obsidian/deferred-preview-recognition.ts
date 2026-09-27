import { TFile, type Vault } from "obsidian";
import { vi } from "vitest";

import { ObsidianInkbookDocumentRecognition } from "../../../src/obsidian/embeds/document-recognition";

export function deferredPreviewRecognition(path: string, size: number) {
  const File = TFile as unknown as new (filePath: string, fileSize: number) => TFile;
  const file = new File(path, size);
  let release!: (content: string) => void;
  const cachedRead = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const recognition = new ObsidianInkbookDocumentRecognition({
    getFileByPath: (candidate: string) => (candidate === file.path ? file : null),
    getResourcePath: () => `app://${path}`,
    cachedRead,
  } as unknown as Vault);
  return { file, recognition, cachedRead, release: (content: string) => release(content) };
}

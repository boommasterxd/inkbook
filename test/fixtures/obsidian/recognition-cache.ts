import { TFile, type Vault } from "obsidian";
import type { ObsidianInkbookDocumentRecognition } from "../../../src/obsidian/embeds/document-recognition";

export function recognitionCacheFixture(
  recognitionConstructor: typeof ObsidianInkbookDocumentRecognition,
  fileCount: number,
) {
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const files = Array.from(
    { length: fileCount },
    (_, index) => new File(`${String(index)}.svg`, 10),
  );
  const byPath = new Map(files.map((file) => [file.path, file]));
  const recognition = new recognitionConstructor({
    getFileByPath: (path: string) => byPath.get(path) ?? null,
    cachedRead: async () => "invalid",
  } as unknown as Vault);
  return { files, recognition };
}

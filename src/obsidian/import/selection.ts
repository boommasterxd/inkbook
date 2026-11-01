import type { InkImportPreview } from "./types";

export function selectInkImportSources(
  preview: InkImportPreview,
  paths: ReadonlySet<string>,
): InkImportPreview {
  const sources = preview.sources.filter((source) => paths.has(source.path));
  const notePaths = new Set(
    sources.flatMap((source) => source.references.map((ref) => ref.notePath)),
  );
  const notes = Object.fromEntries(
    Object.entries(preview.notes).filter(([path]) => notePaths.has(path)),
  );
  return { ...preview, sources, notes };
}

import { selectInkImportSources } from "../../import/selection";
import type { InkImportPreview } from "../../import/types";
import { renderImportFile, type ImportViewContext } from "./import-findings";

/** Keeps the full scan selection independent of the currently published page. */
export function createImportSelection(
  preview: InkImportPreview,
  context: ImportViewContext,
  changed: (count: number, notes: number) => void,
) {
  const selected =
    context.state?.selection ?? new Set(preview.sources.map((source) => source.path));
  if (context.state !== undefined) context.state.selection = selected;
  const sourceNotes = new Map(
    preview.sources.map((source) => [
      source.path,
      new Set(source.references.map((reference) => reference.notePath)),
    ]),
  );
  const noteCounts = new Map<string, number>();
  const countNotes = (path: string, delta: number): void => {
    for (const note of sourceNotes.get(path) ?? []) {
      if (preview.notes[note] === undefined) continue;
      const count = (noteCounts.get(note) ?? 0) + delta;
      if (count === 0) noteCounts.delete(note);
      else noteCounts.set(note, count);
    }
  };
  for (const path of selected) countNotes(path, 1);
  let controls: HTMLElement | undefined;
  let all: HTMLInputElement | undefined;
  const update = (): void => {
    if (all !== undefined) {
      all.checked = selected.size === preview.sources.length;
      all.indeterminate = selected.size > 0 && selected.size < preview.sources.length;
    }
    for (const input of controls?.querySelectorAll<HTMLInputElement>(
      "input[data-inkbook-import-source]",
    ) ?? [])
      input.checked = selected.has(input.dataset.inkbookImportSource!);
    changed(selected.size, noteCounts.size);
  };
  return {
    noteCount: noteCounts.size,
    selectedCount: selected.size,
    snapshot: () => selectInkImportSources(preview, selected),
    renderControls: (container: HTMLElement): void => {
      controls = container;
      const label = container.createEl("label", { cls: "inkbook-import-select-all" });
      all = label.createEl("input");
      all.type = "checkbox";
      all.checked = selected.size === preview.sources.length;
      all.indeterminate = selected.size > 0 && selected.size < preview.sources.length;
      label.createSpan({ text: context.localization.t("import.selectAll") });
      all.addEventListener("change", () => {
        context.mutate(() => {
          selected.clear();
          noteCounts.clear();
          if (all!.checked)
            for (const source of preview.sources) {
              selected.add(source.path);
              countNotes(source.path, 1);
            }
          update();
        });
      });
    },
    renderFile: (row: HTMLElement, index: number): void => {
      const source = preview.sources[index]!;
      renderImportFile(row, source, {
        selected: selected.has(source.path),
        localization: context.localization,
        change: (include) => {
          if (selected.has(source.path) === include) return;
          context.mutate(() => {
            if (include) selected.add(source.path);
            else selected.delete(source.path);
            countNotes(source.path, include ? 1 : -1);
            update();
          });
        },
      });
    },
  };
}

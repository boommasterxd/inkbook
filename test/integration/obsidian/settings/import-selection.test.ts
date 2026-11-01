// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { InkImportPreview } from "../../../../src/obsidian/import/types";
import { renderImportFindings } from "../../../../src/obsidian/settings/import/import-findings";
import { createImportSelection } from "../../../../src/obsidian/settings/import/import-selection";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function largePreview(referencesRead: () => void): InkImportPreview {
  return {
    id: "selection-run",
    sources: Array.from({ length: 1000 }, (_, index) => ({
      path: `Ink/source-${index}.svg`,
      targetPath: `Ink/source-${index}.inkbook.svg`,
      hash: `source-hash-${index}`,
      legacyWriting: true,
      warnings: [],
      get references() {
        referencesRead();
        return [
          {
            notePath: "shared.md",
            sourcePath: `Ink/source-${index}.svg`,
            start: index,
            original: "embed",
          },
        ];
      },
    })),
    notes: { "shared.md": "note-hash" },
    warnings: [],
    truncated: false,
  };
}

it("retains the full selection across bounded pages and updates shared note counts without rebuilding rows", () => {
  const referencesRead = vi.fn();
  const preview = largePreview(referencesRead);
  const changed = vi.fn();
  const disposers: Array<() => void> = [];
  const context = {
    mutate: (update: () => void) => update(),
    readMotion: () => "reduced" as const,
    own: (dispose: () => void) => disposers.push(dispose),
  };
  const selection = createImportSelection(preview, context, changed);
  const container = document.body.createDiv();
  const renderEntry = vi.fn(selection.renderFile);
  renderImportFindings(
    container,
    {
      label: "Files",
      count: 1000,
      icon: "file",
      before: selection.renderControls,
      entry: renderEntry,
    },
    context,
  );
  const button = (name: string): HTMLButtonElement => {
    const element = [...container.querySelectorAll("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === name || candidate.textContent?.includes(name),
    );
    expect(element).toBeDefined();
    return element!;
  };
  const inputs = (): HTMLInputElement[] => [
    ...container.querySelectorAll<HTMLInputElement>("input[data-inkbook-import-source]"),
  ];
  try {
    expect(selection.noteCount).toBe(1);
    expect(renderEntry).not.toHaveBeenCalled();
    button("Files (1000)").click();
    const all = container.querySelector<HTMLInputElement>(".inkbook-import-select-all input")!;
    expect(inputs()).toHaveLength(25);
    expect(renderEntry).toHaveBeenCalledTimes(25);
    expect(all.checked).toBe(true);
    const create = vi.spyOn(document, "createElement");
    const createNamespaced = vi.spyOn(document, "createElementNS");
    referencesRead.mockClear();
    inputs()[0]!.click();
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
    expect(changed).toHaveBeenLastCalledWith(999, 1);
    expect(renderEntry).toHaveBeenCalledTimes(25);
    expect(create).not.toHaveBeenCalled();
    expect(createNamespaced).not.toHaveBeenCalled();
    expect(referencesRead).not.toHaveBeenCalled();
    button("Next page: files").click();
    expect(inputs()).toHaveLength(25);
    expect(inputs().every((input) => input.checked)).toBe(true);
    button("Previous page: files").click();
    expect(inputs()[0]!.checked).toBe(false);
    all.click();
    expect(changed).toHaveBeenLastCalledWith(1000, 1);
    expect(all.indeterminate).toBe(false);
    all.click();
    expect(changed).toHaveBeenLastCalledWith(0, 0);
    expect(inputs().every((input) => !input.checked)).toBe(true);
    inputs()[0]!.focus();
    expect(document.activeElement).toBe(inputs()[0]);
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    inputs()[0]!.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    inputs()[0]!.click();
    expect(changed).toHaveBeenLastCalledWith(1, 1);
    expect(all.indeterminate).toBe(true);
    const snapshot = selection.snapshot();
    expect(snapshot.sources).toEqual([preview.sources[0]]);
    expect(snapshot.sources[0]).toBe(preview.sources[0]);
    expect(snapshot.notes).toEqual({ "shared.md": "note-hash" });
    expect(inputs()).toHaveLength(25);
  } finally {
    for (const dispose of disposers.splice(0)) dispose();
  }
});

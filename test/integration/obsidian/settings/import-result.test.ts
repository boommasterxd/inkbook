// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { InkImportJournal, InkImportResult } from "../../../../src/obsidian/import/types";
import { renderImportResult } from "../../../../src/obsidian/settings/import/import-view";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const activeViews = new Set<() => void>();

beforeEach(() => installObsidianDomHelpers());
afterEach(() => {
  activeViews.forEach((dispose) => dispose());
  activeViews.clear();
  document.body.replaceChildren();
});

function result(): InkImportResult {
  return {
    journal: {
      version: 1,
      id: "run-1",
      createdAt: "2026-10-29",
      status: "complete",
      sources: [],
      notes: [],
      issues: [],
    },
    imported: 1,
    conflicts: 0,
    cancelled: false,
  };
}

function view(
  value: InkImportResult,
  operation: "import" | "undo" | "cleanup" = "import",
  initialMotion: "full" | "reduced" = "reduced",
) {
  const container = document.body.createDiv();
  const disposers: Array<() => void> = [];
  const listeners = new Set<() => void>();
  let motion = initialMotion;
  const dispose = (): void => {
    for (const release of disposers.splice(0)) release();
    activeViews.delete(dispose);
  };
  activeViews.add(dispose);
  renderImportResult(
    container,
    value,
    {
      mutate: (update) => update(),
      readMotion: () => motion,
      observeMotion: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      own: (release) => disposers.push(release),
    },
    operation,
  );
  const graphic = container.querySelector<SVGElement>(".inkbook-import-completion");
  return {
    container,
    graphic,
    check: graphic?.querySelector<SVGElement>("path"),
    listeners,
    dispose,
    setMotion: (next: "full" | "reduced") => {
      motion = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function note(index: number): InkImportJournal["notes"][number] {
  return {
    path: `notes/${index}.md`,
    backupPath: `backups/${index}.md`,
    originalHash: "original",
    importedHash: "imported",
    patches: [],
    status: "applied",
  };
}

it("offers a bounded list of applied notes to review after conversion", () => {
  const value = result();
  value.journal.notes.push(...Array.from({ length: 27 }, (_, index) => note(index)));
  value.journal.notes.push({ ...note(99), status: "conflict" });
  const { container } = view({ ...value, conflicts: 1 });
  const disclosure = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Notes to review (27)"),
  );
  expect(disclosure).toBeDefined();
  expect(container.querySelectorAll('ul[aria-label="Notes to review"] > li')).toHaveLength(0);
  disclosure!.click();
  const notes = () => container.querySelectorAll('ul[aria-label="Notes to review"] > li');
  expect(notes()).toHaveLength(25);
  expect(notes()[0]?.textContent).toContain("notes/0.md");
  container.querySelector<HTMLButtonElement>('[aria-label="Next page: notes to review"]')!.click();
  expect(notes()).toHaveLength(2);
  expect(notes()[1]?.textContent).toContain("notes/26.md");
  expect(container.textContent).not.toContain("notes/99.md");
});

it("does not report a successful restore before the journal is durably undone", () => {
  const value = result();
  value.journal.status = "conflict";
  const { container } = view(value, "undo");
  expect(container.querySelector("h3")?.textContent).toContain("review");
  expect(container.textContent).not.toContain("Obsidian Ink embeds restored");
});

it.each([
  { cancelled: true, status: "cancelled" as const, conflicts: 0, issues: [] },
  { cancelled: false, status: "complete" as const, conflicts: 1, issues: [] },
  { cancelled: false, status: "complete" as const, conflicts: 0, issues: ["Review source"] },
])("never shows the success illustration for a stopped or incomplete import: %j", (state) => {
  const value = result();
  value.journal.status = state.status;
  value.journal.issues.push(...state.issues);
  const { container } = view({ ...value, cancelled: state.cancelled, conflicts: state.conflicts });
  expect(container.querySelector(".inkbook-import-completion")).toBeNull();
  expect(container.querySelector("h3")?.textContent).not.toBe("Import complete");
});

it("settles the finite confirmation when motion is reduced and releases its ownership", () => {
  const { graphic, check, setMotion, dispose, listeners } = view(result(), "import", "full");
  expect(graphic?.getAttribute("aria-hidden")).toBe("true");
  expect(check?.style.strokeDashoffset).toBe("1");
  setMotion("reduced");
  expect(check?.style.strokeDashoffset).toBe("");
  expect(graphic?.style.scale).toBe("");
  dispose();
  expect(listeners.size).toBe(0);
});

it("cancels the confirmation when its view is disposed before motion finishes", () => {
  vi.useFakeTimers();
  try {
    const { graphic, check, dispose, listeners } = view(result(), "import", "full");
    expect(check?.style.strokeDashoffset).toBe("1");
    dispose();
    expect(listeners.size).toBe(0);
    vi.runAllTimers();
    expect(check?.style.strokeDashoffset).toBe("");
    expect(graphic?.style.scale).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

it("reports originals that remain after cleanup", () => {
  const value = result();
  const source = {
    path: "original.svg",
    backupPath: "backup.svg",
    hash: "original",
    targetPath: "copy.svg",
    outputHash: "copy",
    warnings: [],
    status: "created" as const,
  };
  value.journal.sources.push(source, { ...source, path: "cleaned.svg", status: "cleaned" });
  const { container } = view(value, "cleanup");
  expect(container.textContent).toContain("1 original cleaned up; 1 original remaining");
  expect(container.textContent).toContain("Some originals remain");
});

it("settles the confirmation when the document becomes hidden", () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const { graphic, check } = view(result(), "import", "full");
  expect(check?.style.strokeDashoffset).toBe("1");
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(check?.style.strokeDashoffset).toBe("");
  expect(graphic?.style.scale).toBe("");
  hidden.mockRestore();
});

it("completes full motion once and releases its resources on disposal", () => {
  vi.useFakeTimers();
  try {
    const { graphic, check, dispose, listeners } = view(result(), "import", "full");
    expect(graphic?.style.scale).toBe("0.88");
    expect(check?.style.strokeDashoffset).toBe("1");
    vi.runAllTimers();
    expect(graphic?.style.scale).toBe("");
    expect(check?.style.strokeDashoffset).toBe("");
    dispose();
    expect(listeners.size).toBe(0);
    vi.runAllTimers();
    expect(graphic?.style.scale).toBe("");
    expect(check?.style.strokeDashoffset).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

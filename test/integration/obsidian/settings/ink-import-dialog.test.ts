// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Keymap, type App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  InkImportJournal,
  InkImportPreview,
  InkImportResult,
} from "../../../../src/obsidian/import/types";
import {
  InkImportDialog,
  type InkImportDialogOptions,
} from "../../../../src/obsidian/settings/import/ink-import-dialog";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";
import { appliedImportFixture } from "../import/import-fixture";

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function preview(count = 1): InkImportPreview {
  return {
    id: "scan-1",
    sources: Array.from({ length: count }, (_, index) => ({
      path: `drawing-${index}.svg`,
      hash: "hash",
      targetPath: `drawing-${index}.inkbook.svg`,
      legacyWriting: false,
      references: [
        {
          notePath: "Note.md",
          sourcePath: `drawing-${index}.svg`,
          start: 0,
          original: "Original writing block",
        },
      ],
      warnings: [],
    })),
    notes: { "Note.md": "hash" },
    warnings: ["Unsupported Ink block in Other.md was skipped."],
    truncated: false,
  };
}

function journal(): InkImportJournal {
  return {
    version: 1,
    id: "run-1",
    createdAt: "2026-10-29",
    status: "complete",
    sources: [],
    notes: [],
    issues: [],
  };
}

function result(): InkImportResult {
  return { journal: journal(), imported: 1, conflicts: 0, cancelled: false };
}

function fixture(signal?: AbortSignal, initialJournal?: InkImportJournal) {
  const anchor = document.body.createEl("button", { text: "Open import" });
  anchor.focus();
  const service = {
    scan: vi.fn<InkImportDialogOptions["service"]["scan"]>().mockResolvedValue(preview()),
    apply: vi.fn<InkImportDialogOptions["service"]["apply"]>().mockResolvedValue(result()),
    history: vi.fn<InkImportDialogOptions["service"]["history"]>().mockResolvedValue([journal()]),
    undo: vi
      .fn<InkImportDialogOptions["service"]["undo"]>()
      .mockResolvedValue({ ...result(), journal: { ...journal(), status: "undone" } }),
    cleanup: vi.fn<InkImportDialogOptions["service"]["cleanup"]>().mockResolvedValue(result()),
  };
  const app = { keymap: new Keymap(), workspace: { containerEl: document.body } } as App;
  const dialog = new InkImportDialog(app, {
    service,
    signal,
    initialJournal,
    readMotion: () => "reduced",
    workScheduler: () => workSchedulerFromFrames(window),
  });
  dialog.open();
  return { dialog, service, anchor };
}

async function settle(status: string): Promise<void> {
  await vi.waitFor(() =>
    expect(document.querySelector('[role="status"]')?.textContent).toContain(status),
  );
}

function disclosure(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
    (element) => element.textContent?.startsWith(label),
  );
  if (button === undefined) throw new Error(`Missing disclosure: ${label}`);
  return button;
}

it("requires a reviewed preview before writes and announces an accessible result", async () => {
  const { dialog, service, anchor } = fixture();
  const reviewed = {
    ...preview(),
    sources: [
      {
        ...preview().sources[0]!,
        path: "Ink/Notes/drawing.svg",
        targetPath: "Ink/Notes/drawing.inkbook.svg",
        warnings: [
          "Stroke outlines, smoothing and pressure response use Inkbook's native brush.",
          "Stroke timing and source-specific metadata beyond creation time are not retained.",
        ],
      },
    ],
    warnings: [
      "Ink/Notes/drawing.svg: Stroke outlines, smoothing and pressure response use Inkbook's native brush.",
      "Ink/Notes/drawing.svg: Stroke timing and source-specific metadata beyond creation time are not retained.",
      "Unsupported or invalid writing source: Skipped.svg",
      "Other.md: Unknown source must remain identifiable.",
    ],
  };
  service.scan.mockResolvedValueOnce(reviewed);
  expect(document.activeElement).toBe(dialogButton("Scan vault"));
  await assertAccessibleSemantics(dialog.modalEl, ["aria-dialog-name", "button-name"]);
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  expect(service.apply).not.toHaveBeenCalled();
  expect(document.activeElement?.textContent).toBe("1 handwriting file found");
  expect(document.activeElement?.tagName).toBe("H3");
  expect(dialog.contentEl.textContent).toContain(
    "Local conversion · Copies and recovery backups use extra vault and sync storage.",
  );
  disclosure("Handwriting files (1)").click();
  const file = dialog.contentEl.querySelector('ul[aria-label="Handwriting files"] li');
  expect(file?.textContent).toContain("Ink/Notes/drawing.svg");
  expect(file?.textContent).toContain("Ink/Notes/drawing.inkbook.svg");
  const warnings = disclosure("Warnings (2)");
  expect(warnings.getAttribute("aria-expanded")).toBe("false");
  expect(dialog.contentEl.textContent).not.toContain("source-specific metadata");
  warnings.click();
  const findings = dialog.contentEl.querySelectorAll('ul[aria-label="Warnings"] > li');
  expect(findings[0]?.querySelector(".inkbook-import-finding-message")?.textContent).toBe(
    "Stroke timing and source-specific metadata beyond creation time are not retained.",
  );
  expect(findings[0]?.querySelector(".inkbook-import-finding-source")?.textContent).toBe(
    "Ink/Notes/drawing.svg",
  );
  expect(findings[0]?.textContent).toContain("Note.md");
  expect(findings[1]?.textContent).toBe("Other.md: Unknown source must remain identifiable.");
  expect(warnings.getAttribute("aria-expanded")).toBe("true");
  disclosure("Appearance differences (1)").click();
  expect(dialog.contentEl.textContent).toContain(
    "Stroke outlines, smoothing and pressure response",
  );
  disclosure("Skipped items (1)").click();
  expect(dialog.contentEl.textContent).toContain("Skipped.svg");
  dialogButton("Import handwriting").click();
  await settle("Operation finished");
  expect(service.apply).toHaveBeenCalledWith(reviewed, expect.any(AbortSignal));
  expect(dialog.contentEl.textContent).toContain("1 handwriting file; 0 conflicts");
  expect(document.activeElement?.textContent).toBe("Import complete");
  expect(dialogButton("View import").disabled).toBe(false);
  await assertAccessibleSemantics(dialog.modalEl, ["aria-dialog-name", "button-name"]);
  dialogButton("Done").click();
  expect(dialog.containerEl.isConnected).toBe(false);
  expect(document.activeElement).toBe(anchor);
});

it("withholds writes for an empty selection and imports only selected files", async () => {
  const { dialog, service } = fixture();
  const reviewed = preview(2);
  service.scan.mockResolvedValueOnce(reviewed);
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  disclosure("Handwriting files (2)").click();
  dialog.contentEl.querySelector<HTMLInputElement>(".inkbook-import-select-all input")!.click();
  expect(dialogButton("Import handwriting").disabled).toBe(true);
  dialogButton("Import handwriting").click();
  expect(service.apply).not.toHaveBeenCalled();
  dialog.contentEl
    .querySelector<HTMLInputElement>('input[data-inkbook-import-source="drawing-1.svg"]')!
    .click();
  expect(dialogButton("Import handwriting").disabled).toBe(false);
  dialogButton("Import handwriting").click();
  await settle("Operation finished");
  expect(service.apply).toHaveBeenCalledWith(
    { ...reviewed, sources: [reviewed.sources[1]] },
    expect.any(AbortSignal),
  );
});

it("lazily reveals findings, omits unnecessary pagination and bounds large pages", async () => {
  const { dialog, service } = fixture();
  service.scan.mockResolvedValueOnce(preview(25)).mockResolvedValueOnce(preview(67));
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  const findings = () => dialog.contentEl.querySelectorAll('ul[aria-label="Handwriting files"] li');
  expect(findings()).toHaveLength(0);
  const smallFiles = disclosure("Handwriting files (25)");
  expect(smallFiles.getAttribute("aria-expanded")).toBe("false");
  const panel = document.getElementById(smallFiles.getAttribute("aria-controls")!)!;
  expect(panel.hidden).toBe(true);
  smallFiles.click();
  expect(panel.hidden).toBe(false);
  expect(panel.inert).toBe(false);
  expect(findings()).toHaveLength(25);
  expect(
    dialog.contentEl.querySelector('button[aria-label="Next page: handwriting files"]'),
  ).toBeNull();
  smallFiles.click();
  expect(panel.hidden).toBe(true);
  expect(panel.inert).toBe(true);
  dialogButton("Back").click();
  expect(document.activeElement).toBe(dialogButton("Scan vault"));
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  expect(findings()).toHaveLength(0);
  disclosure("Handwriting files (67)").click();
  expect(findings()).toHaveLength(25);
  expect(findings()[0]?.textContent).toContain("drawing-0.svg");
  expect(dialogButton("Previous page: handwriting files").disabled).toBe(true);
  dialogButton("Next page: handwriting files").click();
  expect(findings()).toHaveLength(25);
  expect(findings()[0]?.textContent).toContain("drawing-25.svg");
  dialogButton("Next page: handwriting files").click();
  expect(findings()).toHaveLength(17);
  expect(findings()[16]?.textContent).toContain("drawing-66.svg");
  expect(dialogButton("Next page: handwriting files").disabled).toBe(true);
  expect(document.activeElement).toBe(dialogButton("Previous page: handwriting files"));
  dialogButton("Previous page: handwriting files").click();
  expect(findings()[0]?.textContent).toContain("drawing-25.svg");
});

it("offers only Stop during work, cancels safely and disposes on owner close", async () => {
  const owner = new AbortController();
  const { dialog, service } = fixture(owner.signal);
  let finish: ((value: InkImportPreview) => void) | undefined;
  service.scan.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  dialogButton("Scan vault").click();
  const signal = service.scan.mock.calls[0]![0]!;
  expect(
    [...dialog.contentEl.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual(["Stop"]);
  expect(document.activeElement).toBe(dialogButton("Stop"));
  expect(dialog.contentEl.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(service.history).not.toHaveBeenCalled();
  expect(dialog.busy).toBe(true);
  dialogButton("Stop").click();
  expect(signal.aborted).toBe(true);
  expect(dialogButton("Stop").disabled).toBe(true);
  owner.abort();
  expect(dialog.isClosed).toBe(true);
  finish?.(preview());
  await vi.waitFor(() => expect(dialog.busy).toBe(false));
  expect(dialog.containerEl.isConnected).toBe(false);
  expect(service.apply).not.toHaveBeenCalled();
});

it("hides private failure details and returns to the start or settings", async () => {
  const { dialog, service } = fixture();
  service.scan.mockRejectedValueOnce(new Error("Private file content must not appear"));
  dialogButton("Scan vault").click();
  await settle("could not finish");
  expect(document.activeElement?.textContent).toBe("The operation could not finish");
  expect(dialog.contentEl.textContent).not.toContain("Private file content");
  await assertAccessibleSemantics(dialog.modalEl, ["aria-dialog-name", "button-name"]);
  dialogButton("Back").click();
  expect(document.activeElement).toBe(dialogButton("Scan vault"));
  expect(service.history).not.toHaveBeenCalled();
  dialogButton("Close").click();
  expect(dialog.isClosed).toBe(true);
});

it.each([
  ["undo", "missing"],
  ["undo", "changed"],
  ["cleanup", "missing"],
  ["cleanup", "changed"],
] as const)("explains a %s failure caused by a %s note backup", async (operation, fault) => {
  const imported = await appliedImportFixture();
  const note = imported.journal.notes[0]!;
  if (fault === "missing") imported.files.delete(note.backupPath);
  else imported.files.set(note.backupPath, "Changed backup contents must not appear");
  const before = new Map(imported.files);
  imported.writes.length = 0;
  const { dialog, service } = fixture(undefined, imported.journal);
  service[operation].mockImplementation((id, signal) => imported.service[operation](id, signal));
  dialogButton(operation === "undo" ? "Undo import" : "Clean up originals").click();
  dialogButton(operation === "undo" ? "Restore embeds" : "Move to trash").click();
  const heading = fault === "missing" ? "Recovery backup unavailable" : "Recovery backup changed";
  await settle(heading);
  expect(document.activeElement?.textContent).toBe(heading);
  expect(dialog.contentEl.textContent).toContain(`Note: ${note.path}`);
  expect(dialog.contentEl.textContent).toContain(`Recovery backup: ${note.backupPath}`);
  expect(dialog.contentEl.textContent).toContain("Restore the exact original backup");
  expect(dialog.contentEl.textContent).toContain("Do not replace it with the current note");
  expect(dialog.contentEl.textContent).not.toContain("Changed backup contents");
  expect(dialog.contentEl.querySelector('[aria-busy="true"]')).toBeNull();
  expect(imported.files).toEqual(before);
  expect(imported.writes).toEqual([]);
  await assertAccessibleSemantics(dialog.modalEl, ["aria-dialog-name", "button-name"]);
  dialogButton("Close").click();
  expect(dialog.isClosed).toBe(true);
});

it.each(["undo", "cleanup"] as const)("keeps unknown %s failures private", async (operation) => {
  const { dialog, service } = fixture(undefined, journal());
  service[operation].mockRejectedValueOnce(new Error("Private filesystem diagnostics"));
  dialogButton(operation === "undo" ? "Undo import" : "Clean up originals").click();
  dialogButton(operation === "undo" ? "Restore embeds" : "Move to trash").click();
  await settle("The operation could not finish");
  expect(document.activeElement?.textContent).toBe("The operation could not finish");
  expect(dialog.contentEl.textContent).toContain("Some changes may already be complete");
  expect(dialog.contentEl.textContent).not.toContain("Private filesystem diagnostics");
  expect(dialog.contentEl.textContent).not.toContain("Recovery backup:");
});

it("opens a selected import directly and requires explicit recovery confirmations", async () => {
  const { dialog, service } = fixture(undefined, journal());
  expect(service.scan).not.toHaveBeenCalled();
  expect(service.history).not.toHaveBeenCalled();
  dialogButton("Undo import").click();
  expect(document.activeElement).toBe(dialogButton("Cancel"));
  expect(service.undo).not.toHaveBeenCalled();
  dialogButton("Cancel").click();
  dialogButton("Clean up originals").click();
  expect(document.activeElement).toBe(dialogButton("Cancel"));
  expect(dialog.contentEl.textContent).toContain("Obsidian trash");
  expect(dialog.contentEl.textContent).toContain("recovery backups are kept");
  expect(service.cleanup).not.toHaveBeenCalled();
  dialogButton("Move to trash").click();
  await settle("Operation finished");
  expect(service.cleanup).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
  expect(document.activeElement?.textContent).toBe("Original files checked");
  dialogButton("View import").click();
  dialogButton("Undo import").click();
  expect(document.activeElement).toBe(dialogButton("Cancel"));
  await assertAccessibleSemantics(dialog.modalEl, ["aria-dialog-name", "button-name"]);
  dialogButton("Restore embeds").click();
  await settle("Operation finished");
  expect(service.undo).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
  expect(document.activeElement?.textContent).toBe("Obsidian Ink embeds restored");
  dialogButton("View import").click();
  expect(dialog.contentEl.textContent).toContain("Undone");
  expect(
    [...dialog.contentEl.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual(["Close"]);
});

it("explains a bounded scan with no convertible files and returns to settings", async () => {
  const { dialog, service } = fixture();
  service.scan.mockResolvedValue({ ...preview(0), truncated: true });
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  expect(dialog.contentEl.textContent).toContain("Scan limit reached");
  expect(
    [...dialog.contentEl.querySelectorAll("button")].some(
      (button) => button.textContent === "Import handwriting",
    ),
  ).toBe(false);
  expect(dialog.contentEl.querySelector('ul[aria-label="Handwriting files"]')).toBeNull();
  dialogButton("Back").click();
  expect(dialogButton("Scan vault").disabled).toBe(false);
  await assertAccessibleSemantics(dialog.modalEl, ["aria-dialog-name", "button-name"]);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(dialog.containerEl.isConnected).toBe(false);
});

it("reports cancelled work through lazy issues", async () => {
  const { dialog, service } = fixture();
  service.apply.mockResolvedValue({
    ...result(),
    cancelled: true,
    journal: { ...journal(), status: "cancelled", issues: ["Stopped before the next source."] },
  });
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  dialogButton("Import handwriting").click();
  await settle("Stopped. Completed changes");
  expect(document.activeElement?.textContent).toBe("Import stopped");
  expect(dialog.contentEl.textContent).not.toContain("Stopped before the next source");
  disclosure("Issues (1)").click();
  expect(dialog.contentEl.textContent).toContain("Stopped before the next source");
  expect(service.undo).not.toHaveBeenCalled();
  expect(service.cleanup).not.toHaveBeenCalled();
});

it.each([
  { conflicts: 1, issues: [] },
  { conflicts: 0, issues: ["The source changed before conversion."] },
])("keeps recovery available when a completed import needs review: %j", async (partial) => {
  const { dialog, service } = fixture();
  service.apply.mockResolvedValue({
    ...result(),
    conflicts: partial.conflicts,
    journal: { ...journal(), issues: partial.issues },
  });
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  dialogButton("Import handwriting").click();
  await settle("Operation finished");
  expect(document.activeElement?.textContent).toBe("Import needs review");
  expect(dialog.contentEl.textContent).not.toContain("Import complete");
  dialogButton("View import").click();
  expect(dialogButton("Undo import").disabled).toBe(false);
  expect(service.undo).not.toHaveBeenCalled();
});

it("withholds recovery for a damaged history record", async () => {
  const { dialog, service } = fixture(undefined, {
    ...journal(),
    id: "damaged",
    createdAt: "",
    status: "conflict",
    unreadable: true,
    issues: ["This import record could not be read. Keep its recovery files."],
  });
  expect(dialog.contentEl.textContent).toContain("Record unavailable");
  expect(dialog.contentEl.textContent).toContain("damaged");
  expect(dialog.contentEl.textContent).toContain("undo and cleanup are unavailable");
  disclosure("Issues (1)").click();
  expect(dialog.contentEl.textContent).toContain("This import record could not be read");
  expect(
    [...dialog.contentEl.querySelectorAll("button")].some(
      (button) =>
        button.textContent === "Undo import" || button.textContent === "Clean up originals",
    ),
  ).toBe(false);
  expect(service.undo).not.toHaveBeenCalled();
  expect(service.cleanup).not.toHaveBeenCalled();
  await assertAccessibleSemantics(dialog.modalEl, ["aria-dialog-name", "button-name"]);
  dialogButton("Close").click();
  expect(dialog.isClosed).toBe(true);
});

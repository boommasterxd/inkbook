// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { Keymap, type App } from "obsidian";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { Localization } from "../../../../src/domain/localization";
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
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";
export function setupImportDialogTests(): void {
  beforeEach(() => {
    installObsidianDomHelpers();
    document.body.replaceChildren();
  });
  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });
}

export function preview(count = 1): InkImportPreview {
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

export function journal(): InkImportJournal {
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

export function result(): InkImportResult {
  return { journal: journal(), imported: 1, conflicts: 0, cancelled: false };
}

export function fixture(
  signal?: AbortSignal,
  initialJournal?: InkImportJournal,
  language: "en" | "de" = "en",
) {
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
  const localization = new Localization(language);
  const dialog = new InkImportDialog(app, {
    localization,
    service,
    signal,
    initialJournal,
    readMotion: () => "reduced",
    workScheduler: () => workSchedulerFromFrames(window),
  });
  dialog.open();
  return { dialog, service, anchor, localization };
}

export async function settle(status: string): Promise<void> {
  await vi.waitFor(() =>
    expect(document.querySelector('[role="status"]')?.textContent).toContain(status),
  );
}

export function disclosure(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
    (element) => element.textContent?.startsWith(label),
  );
  if (button === undefined) throw new Error(`Missing disclosure: ${label}`);
  return button;
}

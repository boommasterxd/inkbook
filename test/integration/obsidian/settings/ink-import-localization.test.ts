// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { InkImportPreview } from "../../../../src/obsidian/import/types";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import {
  setupImportDialogTests,
  fixture,
  journal,
  preview,
  settle,
  disclosure,
} from "./ink-import-dialog-fixture";
setupImportDialogTests();
it("localizes the reviewed import and recovery flow without changing vault paths", async () => {
  const { dialog, service } = fixture(undefined, undefined, "de");
  expect(dialog.modalEl.lang).toBe("de");
  const reviewed = preview(2);
  service.scan.mockResolvedValueOnce(reviewed);
  dialogButton("Vault durchsuchen").click();
  await settle("Suche abgeschlossen");
  expect(dialog.contentEl.textContent).toContain("2 Handschriftdateien gefunden");
  expect(dialog.contentEl.textContent).toContain("2 von 2 ausgewählt · 1 betroffene Notiz");
  disclosure("Handschriftdateien (2)").click();
  const source = dialog.contentEl.querySelector<HTMLInputElement>(
    'input[aria-label="drawing-0.svg importieren"]',
  )!;
  source.click();
  expect(dialog.contentEl.textContent).toContain("1 von 2 ausgewählt");
  dialogButton("Handschrift importieren").click();
  await settle("Vorgang abgeschlossen");
  expect(service.apply).toHaveBeenCalledWith(
    { ...reviewed, sources: [reviewed.sources[1]] },
    expect.any(AbortSignal),
  );
  expect(dialog.contentEl.textContent).toContain("1 Handschriftdatei; 0 Konflikte.");
  dialogButton("Import ansehen").click();
  dialogButton("Import rückgängig machen").click();
  expect(dialog.contentEl.textContent).toContain("Obsidian-Ink-Einbettungen wiederherstellen?");
  dialogButton("Einbettungen wiederherstellen").click();
  await settle("Vorgang abgeschlossen");
  expect(service.undo).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
  expect(dialog.contentEl.textContent).toContain("Obsidian-Ink-Einbettungen wiederhergestellt");
  dialogButton("Fertig").click();
});

it("keeps selection, expanded findings, pagination, focus and scroll when language changes", async () => {
  const { dialog, service, localization } = fixture();
  service.scan.mockResolvedValueOnce(preview(30));
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  disclosure("Handwriting files (30)").click();
  dialog.contentEl
    .querySelector<HTMLInputElement>('input[data-inkbook-import-source="drawing-0.svg"]')!
    .click();
  dialog.contentEl
    .querySelector<HTMLButtonElement>('[aria-label="Next page: Handwriting files"]')!
    .click();
  const source = dialog.contentEl.querySelector<HTMLInputElement>(
    'input[data-inkbook-import-source="drawing-26.svg"]',
  )!;
  source.click();
  source.focus();
  const body = dialog.contentEl.querySelector<HTMLElement>(".inkbook-import-body")!;
  body.scrollTop = 180;
  localization.setLanguage("de");
  expect(dialog.modalEl.lang).toBe("de");
  expect(disclosure("Handschriftdateien (30)").getAttribute("aria-expanded")).toBe("true");
  expect(dialog.contentEl.textContent).toContain("26–30 von 30");
  expect(dialog.contentEl.textContent).toContain("28 von 30 ausgewählt");
  expect((document.activeElement as HTMLElement).dataset.inkbookImportSource).toBe(
    "drawing-26.svg",
  );
  expect((document.activeElement as HTMLInputElement).checked).toBe(false);
  expect(body.scrollTop).toBe(180);
  expect(service.scan).toHaveBeenCalledTimes(1);
  dialogButton("Handschrift importieren").click();
  await settle("Vorgang abgeschlossen");
  const selected = service.apply.mock.calls[0]![0].sources.map((source) => source.path);
  expect(selected).toHaveLength(28);
  expect(selected).not.toContain("drawing-0.svg");
  expect(selected).not.toContain("drawing-26.svg");
  dialogButton("Fertig").click();
});

it("refreshes pending and stopped states without restarting work on a language change", async () => {
  const { dialog, service, localization } = fixture();
  let finish: ((value: InkImportPreview) => void) | undefined;
  service.scan.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  dialogButton("Scan vault").click();
  localization.setLanguage("de");
  expect(dialog.contentEl.textContent).toContain("Vault wird durchsucht…");
  dialogButton("Stoppen").click();
  localization.setLanguage("en");
  expect(dialog.contentEl.textContent).toContain("Stopping safely…");
  expect(dialogButton("Stop").disabled).toBe(true);
  expect(service.scan).toHaveBeenCalledTimes(1);
  expect(service.scan.mock.calls[0]![0]!.aborted).toBe(true);
  finish?.(preview());
  await settle("Scan complete");
  dialog.close();
});

it("renders semantic recovery reasons in German and preserves unrecognized legacy details", () => {
  const saved = journal();
  saved.issues.push(
    "Original diagnostic retained for compatibility.",
    "User-authored diagnostic detail",
  );
  saved.issueDetails = [{ code: "writeConflict", path: "Ink/Meine Zeichnung.svg" }, null];
  const { dialog } = fixture(undefined, saved, "de");
  disclosure("Probleme (2)").click();
  expect(dialog.contentEl.textContent).toContain("Importkonflikt oder Schreibfehler");
  expect(dialog.contentEl.textContent).toContain("Ink/Meine Zeichnung.svg");
  expect(dialog.contentEl.textContent).toContain(
    "Details aus dem ursprünglichen Import: User-authored diagnostic detail",
  );
  expect(dialog.contentEl.textContent).not.toContain(
    "Original diagnostic retained for compatibility.",
  );
  dialog.close();
});

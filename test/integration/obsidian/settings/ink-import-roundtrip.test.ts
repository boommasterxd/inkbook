// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Keymap } from "obsidian";
import { expect, it, onTestFinished, vi } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import { createInkImportConverter } from "../../../../src/obsidian/import/convert";
import { ObsidianInkImportService } from "../../../../src/obsidian/import/service";
import { InkImportAccess } from "../../../../src/obsidian/settings/import/import-access";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { canvasSnapshot, inkSvg } from "../../../unit/persistence/import/obsidian-ink/fixtures";
import { importAdapterFixture } from "../import/adapter-fixture";
import { writingEmbed } from "../import/import-fixture";
import { disclosure, settle, setupImportDialogTests } from "./ink-import-dialog-fixture";

setupImportDialogTests();

it("imports selected Ink handwriting and restores it from persisted history", async () => {
  vi.stubGlobal("Worker", undefined);
  const owner = new AbortController();
  onTestFinished(() => {
    owner.abort();
    vi.unstubAllGlobals();
  });
  const workScheduler = immediateWorkScheduler();
  const convert = createInkImportConverter({
    ownerWindow: window,
    workScheduler,
    frameIntervalMilliseconds: () => 1000 / 120,
    createId: () => "test",
    timestamp: () => 1000,
  });
  const vault = importAdapterFixture(workScheduler, convert);
  Object.assign(vault.app, { keymap: new Keymap() });
  Object.assign(vault.app.workspace, { containerEl: document.body });
  const access = new InkImportAccess({
    app: vault.app,
    signal: owner.signal,
    localization: new Localization(),
    createService: () => new ObsidianInkImportService(vault.ports),
    workScheduler: () => workScheduler,
    readMotion: () => "reduced",
  });

  const sourcePath = "Ink/example.svg";
  const excludedPath = "Ink/other.svg";
  const target = "Ink/example.inkbook.svg";
  const ink = inkSvg(canvasSnapshot());
  const excludedInk = inkSvg(canvasSnapshot({ strokes: [] }));
  const excludedEmbed = writingEmbed(excludedPath);
  const note = `Introduction\n\n${writingEmbed(sourcePath, "Sketch")}\n\n${excludedEmbed}`;
  vault.put(sourcePath, ink);
  vault.put(excludedPath, excludedInk);
  vault.put("note.md", note);
  const before = new Map(vault.text);

  await access.open(window);
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  expect(vault.text).toEqual(before);
  disclosure("Handwriting files (2)").click();
  document.querySelector<HTMLInputElement>(`input[aria-label="Import ${excludedPath}"]`)!.click();
  dialogButton("Import handwriting").click();
  await settle("Operation finished");
  expect(vault.text.get("note.md")).toBe(
    `Introduction\n\n![[${target}|Sketch]]\n\n${excludedEmbed}`,
  );
  expect(vault.text.get(sourcePath)).toBe(ink);
  expect(vault.text.has("Ink/other.inkbook.svg")).toBe(false);
  const output = vault.text.get(target);
  if (output === undefined) throw new Error("Missing persisted Inkbook drawing.");
  const parsed = await parseInkbookDocumentForTest(output);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(parsed.value.snapshot.elements).toMatchObject([
    { kind: "stroke", offset: { x: 34.3, y: 44.3 } },
  ]);
  dialogButton("Done").click();

  const history = await access.history(window, owner.signal);
  expect(history).toMatchObject([{ status: "complete", sources: [{ path: sourcePath }] }]);
  await access.open(window, history[0]);
  dialogButton("Clean up originals").click();
  dialogButton("Move to trash").click();
  await settle("Operation finished");
  expect(vault.text.has(sourcePath)).toBe(false);
  expect(vault.text.get(excludedPath)).toBe(excludedInk);
  dialogButton("View import").click();
  dialogButton("Undo import").click();
  expect(vault.text.has(sourcePath)).toBe(false);
  dialogButton("Restore embeds").click();
  await settle("Operation finished");
  expect(vault.text.get(sourcePath)).toBe(ink);
  expect(vault.text.get("note.md")).toBe(note);
  dialogButton("Done").click();
  expect(await access.history(window, owner.signal)).toMatchObject([{ status: "undone" }]);
});

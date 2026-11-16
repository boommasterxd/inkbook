// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { expect, it } from "vitest";
import {
  setupImportDialogTests,
  fixture,
  preview,
  settle,
  disclosure,
} from "./ink-import-dialog-fixture";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";

setupImportDialogTests();

it("creates optional examples on first expansion and reuses them across disclosure toggles", async () => {
  const { dialog, service } = fixture();
  expect(dialog.contentEl.querySelectorAll("img")).toHaveLength(0);
  expect(dialog.contentEl.querySelector(".inkbook-import-journey")).toBeNull();
  const help = disclosure("Examples and steps");
  expect(help.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(dialogButton("Scan vault"));
  help.click();
  const images = [...dialog.contentEl.querySelectorAll("img")];
  expect(images).toHaveLength(2);
  expect(dialog.contentEl.querySelectorAll(".inkbook-import-journey li")).toHaveLength(3);
  const panel = document.getElementById(help.getAttribute("aria-controls")!)!;
  expect(panel.inert).toBe(false);
  help.click();
  expect(panel.inert).toBe(true);
  help.click();
  expect([...dialog.contentEl.querySelectorAll("img")]).toEqual(images);
  expect(service.scan).not.toHaveBeenCalled();
  expect(service.apply).not.toHaveBeenCalled();
  await assertAccessibleSemantics(dialog.modalEl, ["button-name", "aria-dialog-name", "image-alt"]);
});

it("shows a dedicated empty result, preserves skipped sources and rescans without import writes", async () => {
  const { dialog, service } = fixture();
  service.scan.mockResolvedValueOnce({ ...preview(0), warnings: ["Missing source: Missing.svg"] });
  dialogButton("Scan vault").click();
  await settle("No supported handwriting found");
  expect(dialog.contentEl.querySelector("h3")?.textContent).toBe("No supported handwriting found");
  expect(dialog.contentEl.textContent).not.toContain("0 of 0");
  expect(dialog.contentEl.querySelector(".inkbook-import-guidance")).toBeNull();
  expect(dialog.contentEl.querySelector(".inkbook-import-storage-note")).toBeNull();
  disclosure("Skipped items (1)").click();
  expect(dialog.contentEl.textContent).toContain("Missing.svg");
  service.scan.mockResolvedValueOnce(preview(1));
  dialogButton("Scan again").click();
  await settle("Scan complete");
  expect(service.scan).toHaveBeenCalledTimes(2);
  expect(dialog.contentEl.textContent).toContain("1 handwriting file found");
  expect(dialogButton("Import handwriting").disabled).toBe(false);
  expect(service.apply).not.toHaveBeenCalled();
});

it("updates only selection-dependent findings while retaining checkbox focus and global scan problems", async () => {
  const { dialog, service } = fixture();
  const warning =
    "Stroke timing and source-specific metadata beyond creation time are not retained.";
  const base = preview(2);
  const scan = {
    ...base,
    sources: base.sources.map((source, index) =>
      index === 0 ? { ...source, warnings: [warning] } : source,
    ),
  };
  service.scan.mockResolvedValueOnce({
    ...scan,
    warnings: [`${scan.sources[0]!.path}: ${warning}`, "Missing source: Missing.svg"],
  });
  dialogButton("Scan vault").click();
  await settle("Scan complete");
  disclosure("Handwriting files (2)").click();
  const inputs = [
    ...dialog.contentEl.querySelectorAll<HTMLInputElement>("input[data-inkbook-import-source]"),
  ];
  const warnings = disclosure("Warnings (1)");
  warnings.click();
  inputs[1]!.click();
  expect(disclosure("Warnings (1)")).toBe(warnings);
  inputs[0]!.focus();
  inputs[0]!.click();
  expect(document.activeElement).toBe(inputs[0]);
  expect(warnings.isConnected).toBe(false);
  expect(dialog.contentEl.textContent).not.toContain(warning);
  expect(dialogButton("Import handwriting").disabled).toBe(true);
  disclosure("Skipped items (1)").click();
  expect(dialog.contentEl.textContent).toContain("Missing.svg");
  inputs[0]!.click();
  expect(disclosure("Warnings (1)").getAttribute("aria-expanded")).toBe("true");
  expect(dialog.contentEl.textContent).toContain(warning);
  expect(dialogButton("Import handwriting").disabled).toBe(false);
  expect(service.apply).not.toHaveBeenCalled();
});

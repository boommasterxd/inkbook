// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import type { Window as HappyWindow } from "happy-dom";
import { expect, it, vi } from "vitest";
import {
  setupImportDialogTests,
  fixture,
  preview,
  settle,
  disclosure,
} from "./ink-import-dialog-fixture";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";

vi.mock("../../../../src/obsidian/settings/import/import-example-loader", () => ({
  acquireImportExamples: () => ({
    module: import("../../../../src/obsidian/settings/import/import-example-images"),
    release: () => undefined,
  }),
}));

setupImportDialogTests();

it("creates optional examples on first expansion and reuses them across disclosure toggles", async () => {
  const { dialog, service } = fixture();
  expect(dialog.contentEl.querySelectorAll("img")).toHaveLength(0);
  expect(dialog.contentEl.querySelector(".inkbook-import-journey")).toBeNull();
  const help = disclosure("Examples and steps");
  expect(help.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(dialogButton("Scan vault"));
  help.click();
  await vi.waitFor(() => expect(dialog.contentEl.querySelectorAll("img")).toHaveLength(2));
  const images = [...dialog.contentEl.querySelectorAll("img")];
  expect(images).toHaveLength(2);
  const panel = document.getElementById(help.getAttribute("aria-controls")!)!;
  expect([...panel.querySelectorAll("ol > li > strong")].map((step) => step.textContent)).toEqual([
    "Scan the vault",
    "Review the results",
    "Switch the embeds",
  ]);
  expect(panel.textContent).toContain("Restore original embeds from the import history.");
  expect(panel.inert).toBe(false);
  help.click();
  expect(panel.inert).toBe(true);
  help.click();
  expect([...dialog.contentEl.querySelectorAll("img")]).toEqual(images);
  expect(service.scan).not.toHaveBeenCalled();
  expect(service.apply).not.toHaveBeenCalled();
  await assertAccessibleSemantics(dialog.modalEl, ["button-name", "aria-dialog-name", "image-alt"]);
});

it("opens all three finding examples in one gallery with focus and phone-side selection", async () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const browser = window as unknown as HappyWindow;
  browser.happyDOM.setViewport({ width: 360, height: 800 });
  try {
    const { dialog, service } = fixture();
    const scan = preview();
    service.scan.mockResolvedValueOnce({
      ...scan,
      sources: [
        {
          ...scan.sources[0]!,
          warnings: [
            "Rounded rectangles were converted to Inkbook rectangles with square corners.",
            "Geometry, pressure and opacity were rounded to Inkbook's native precision.",
            "Stroke outlines, smoothing and pressure response use Inkbook's native brush.",
          ],
          warningCodes: ["squareCorners", "nativePrecision", "nativeBrush"],
        },
      ],
    });
    dialogButton("Scan vault").click();
    await settle("Scan complete");
    disclosure("Appearance differences (3)").click();
    const example = dialogButton("View example (Rounded corners)");
    expect(example.closest("li")?.textContent).toContain("Rounded rectangles were converted");
    expect(dialog.contentEl.querySelectorAll("img")).toHaveLength(0);
    const gallery = document.getElementById(example.getAttribute("aria-controls")!)!;
    const body = gallery.closest<HTMLElement>(".inkbook-import-body")!;
    body.scrollTop = 300;
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 110, 328, 464));
    vi.spyOn(gallery, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 30, 296, 300));
    example.click();
    expect(body.scrollTop).toBe(220);
    expect(document.activeElement).toBe(dialogButton("Rounded corners"));
    const before = dialogButton("Before · Obsidian Ink");
    const after = dialogButton("After · Inkbook");
    const beforeFigure = document.getElementById(before.getAttribute("aria-controls")!)!;
    const afterFigure = document.getElementById(after.getAttribute("aria-controls")!)!;
    expect(before.getAttribute("aria-pressed")).toBe("true");
    expect(beforeFigure.hidden).toBe(false);
    expect(afterFigure.hidden).toBe(true);
    expect(afterFigure.querySelector("img")?.hasAttribute("src")).toBe(false);
    after.focus();
    expect(afterFigure.querySelector("img")?.hasAttribute("src")).toBe(true);
    expect(afterFigure.hidden).toBe(true);
    after.click();
    expect(document.activeElement).toBe(after);
    expect(before.getAttribute("aria-pressed")).toBe("false");
    expect(after.getAttribute("aria-pressed")).toBe("true");
    expect(beforeFigure.hidden).toBe(true);
    expect(afterFigure.hidden).toBe(false);
    expect(afterFigure.querySelector("img")?.alt).toContain("square corners");

    const images = [...dialog.contentEl.querySelectorAll("img")];
    const precision = dialogButton("View example (Coordinate rounding)");
    expect(precision.getAttribute("aria-controls")).toBe(example.getAttribute("aria-controls"));
    precision.click();
    expect(document.activeElement).toBe(dialogButton("Coordinate rounding"));
    expect(afterFigure.querySelector("img")?.alt).toContain("12.346 on the same magnified axis");
    const brush = dialogButton("View example (Curves and pressure)");
    expect(brush.getAttribute("aria-controls")).toBe(example.getAttribute("aria-controls"));
    brush.click();
    expect(document.activeElement).toBe(dialogButton("Curves and pressure"));
    await vi.waitFor(() =>
      expect(afterFigure.querySelector("img")?.alt).toContain("less pronounced wedges"),
    );
    expect([...dialog.contentEl.querySelectorAll("img")]).toEqual(images);
    expect(dialogButton("After · Inkbook")).toBe(after);
    expect(after.getAttribute("aria-pressed")).toBe("true");
    await assertAccessibleSemantics(dialog.modalEl, ["button-name", "image-alt"]);
  } finally {
    browser.happyDOM.setViewport({ width, height });
  }
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
  expect(dialog.contentEl.querySelector(".inkbook-import-example-choices")).toBeNull();
  disclosure("Skipped items (1)").click();
  disclosure("1 handwriting file").click();
  expect(dialog.contentEl.textContent).toContain("Missing.svg");
  service.scan.mockResolvedValueOnce(preview(1));
  dialogButton("Scan again").click();
  await settle("Scan complete");
  expect(service.scan).toHaveBeenCalledTimes(2);
  expect(dialog.contentEl.textContent).toContain("1 handwriting file found");
  expect(dialog.contentEl.querySelectorAll("img")).toHaveLength(0);
  dialogButton("Cursive handwriting").click();
  await vi.waitFor(() =>
    expect(dialog.contentEl.querySelector("img")?.alt).toContain("cursive handwriting"),
  );
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
  disclosure("1 handwriting file").click();
  expect(dialog.contentEl.textContent).toContain("Missing.svg");
  inputs[0]!.click();
  expect(disclosure("Warnings (1)").getAttribute("aria-expanded")).toBe("true");
  expect(dialog.contentEl.textContent).toContain(warning);
  expect(dialogButton("Import handwriting").disabled).toBe(false);
  expect(service.apply).not.toHaveBeenCalled();
});

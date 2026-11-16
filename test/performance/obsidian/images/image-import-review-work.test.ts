// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { PdfImageResolution } from "../../../../src/obsidian/images/pdf-image-source";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { capacityImageResource } from "../../../fixtures/persistence/images";
import {
  changeImportField,
  imageImportSubmit,
  imageImportMocks,
  installImageImportTestLifecycle,
  selectImportFile,
  setupPdfImport,
} from "../../../fixtures/obsidian/image-import-dialog";

const { readImageSource, openPdfImageSource } = imageImportMocks;
installImageImportTestLifecycle();

async function ready(): Promise<void> {
  await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
}

function previewPage(value: number): void {
  changeImportField(
    document.querySelector<HTMLInputElement>('[aria-label="Preview page"]')!,
    String(value),
  );
}

function quality(value: string): void {
  const field = document.querySelector<HTMLSelectElement>("select")!;
  field.value = value;
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

it("reuses reviewed PDF rasters and their DPI metadata through browsing and batch insertion", async () => {
  const state = await setupPdfImport(3);
  let resolution: PdfImageResolution | undefined;
  state.render.mockImplementation(async (page) => {
    resolution = { page, dpi: page === 1 ? 144 : 72, limited: page !== 1 };
    return state.resource;
  });
  vi.mocked(openPdfImageSource).mockResolvedValue({
    pageCount: 3,
    render: state.render,
    dispose: state.dispose,
    get resolution() {
      return resolution;
    },
  });
  selectImportFile("pages.pdf");
  await ready();
  const warning = document.querySelector<HTMLElement>(".inkbook-image-import-resize-warning")!;
  previewPage(2);
  await ready();
  expect(warning.hidden).toBe(false);
  expect(document.querySelector("figcaption")?.textContent).toContain("approx. 72 dpi");
  previewPage(1);
  await ready();
  expect(warning.hidden).toBe(true);
  expect(document.querySelector("figcaption")?.textContent).toContain("approx. 144 dpi");
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  previewPage(2);
  await ready();
  expect(warning.hidden).toBe(false);
  imageImportSubmit().click();
  expect((await state.pending)?.resources).toEqual(Array(3).fill(state.resource));
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  expect(readImageSource).toHaveBeenCalledOnce();
  expect(openPdfImageSource).toHaveBeenCalledOnce();
  expect(state.dispose).toHaveBeenCalled();
});

it("retains High and Ultra together but evicts highly compressed rasters by pixel and string cost", async () => {
  const high = await capacityImageResource(1);
  const ultra = await capacityImageResource(2, 4000);
  const second = await capacityImageResource(3, 4000);
  const state = await setupPdfImport(2);
  state.render.mockImplementation(async (page) => {
    const profile = document.querySelector<HTMLSelectElement>("select")!.value;
    return profile === "high" ? high : page === 1 ? ultra : second;
  });
  selectImportFile("pages.pdf");
  await ready();
  quality("ultra");
  await ready();
  quality("high");
  await ready();
  expect(document.querySelector("img")?.getAttribute("src")).toContain(high.data);
  quality("ultra");
  await ready();
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 1]);
  previewPage(2);
  await ready();
  expect(document.querySelector("img")?.getAttribute("src")).toContain(second.data);
  previewPage(1);
  await ready();
  expect(document.querySelector("img")?.getAttribute("src")).toContain(ultra.data);
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 1, 2, 1]);
  dialogButton("Cancel").click();
  expect(await state.pending).toBeUndefined();
  expect(state.dispose).toHaveBeenCalled();
});

it("bounds retained small-page variants to twenty entries without revisiting source bytes", async () => {
  const state = await setupPdfImport(21);
  selectImportFile("pages.pdf");
  await ready();
  for (let page = 2; page <= 21; page += 1) {
    previewPage(page);
    await ready();
  }
  previewPage(2);
  await ready();
  expect(state.render).toHaveBeenCalledTimes(21);
  previewPage(1);
  await ready();
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([
    ...Array.from({ length: 21 }, (_, index) => index + 1),
    1,
  ]);
  expect(readImageSource).toHaveBeenCalledOnce();
  dialogButton("Cancel").click();
  expect(await state.pending).toBeUndefined();
});

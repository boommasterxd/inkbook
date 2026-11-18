// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { PdfImageResolution } from "../../../../src/obsidian/images/pdf-image-source";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { installImageRasterBoundary } from "../../../fixtures/obsidian/image-raster";
import {
  capacityImageResource,
  imageHeaderBytes,
  validImageResource,
} from "../../../fixtures/persistence/images";
import {
  changeImportField,
  imageImportSubmit,
  imageImportMocks,
  installImageImportTestLifecycle,
  selectImportFile,
  setImportThumbnailVisibility,
  setupImageImport,
  setupPdfImport,
} from "../../../fixtures/obsidian/image-import-dialog";

const { readImageSource, openPdfImageSource } = imageImportMocks;
installImageImportTestLifecycle();

const THUMBNAIL_CANVAS = ".inkbook-image-import-thumbnails canvas";

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
    renderThumbnail: state.renderThumbnail,
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

it("reuses reviewed High and Ultra pages without charging released canvas pixels", async () => {
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
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 1, 2]);
  dialogButton("Cancel").click();
  expect(await state.pending).toBeUndefined();
  expect(state.dispose).toHaveBeenCalled();
});

it("bounds reviewed pages to twenty and protects later insertion hits when the first page was evicted", async () => {
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
  imageImportSubmit().click();
  expect((await state.pending)?.resources).toHaveLength(20);
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([
    ...Array.from({ length: 21 }, (_, index) => index + 1),
    1,
  ]);
  expect(readImageSource).toHaveBeenCalledOnce();
});

it("stops at the first new resource exceeding retained session capacity and accepts duplicate pages on retry", async () => {
  const retained = await capacityImageResource(1, 4000);
  const second = await capacityImageResource(2, 4000);
  const incoming = await capacityImageResource(3);
  const state = await setupPdfImport(8, undefined, () => [retained, second]);
  state.render.mockImplementation(async (page) => (page === 2 ? incoming : retained));
  selectImportFile("pages.pdf");
  await ready();
  imageImportSubmit().click();
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("capacity"),
  );
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  expect(state.submit).not.toHaveBeenCalled();
  const range = document.querySelector<HTMLInputElement>('input[type="text"]')!;
  changeImportField(range, "1,3");
  imageImportSubmit().click();
  expect((await state.pending)?.resources).toEqual([retained, retained]);
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
});

it("only rasterizes visible PDF thumbnails, reuses the displayed page and releases the bounded cache", async () => {
  setImportThumbnailVisibility(false);
  const state = await setupPdfImport(10_000);
  selectImportFile("large.pdf");
  await ready();
  expect(state.renderThumbnail).not.toHaveBeenCalled();
  const image = document.querySelector("figure img")!;
  Object.defineProperties(image, {
    complete: { get: () => true },
    naturalWidth: { get: () => 1600 },
    naturalHeight: { get: () => 2400 },
  });
  const { draws } = installImageRasterBoundary(new Uint8Array());
  setImportThumbnailVisibility(true);
  await vi.waitFor(() => expect(document.querySelectorAll(THUMBNAIL_CANVAS)).toHaveLength(4));
  expect(draws).toEqual([{ width: 96, height: 144 }]);
  expect(state.renderThumbnail.mock.calls.map(([page]) => page)).toEqual([2, 3, 4]);
  const first = [...document.querySelectorAll<HTMLCanvasElement>(THUMBNAIL_CANVAS)];
  const reviewControl = document.querySelector('[aria-label="Include page 1"]');
  dialogButton("Next thumbnails").click();
  await vi.waitFor(() => expect(state.renderThumbnail).toHaveBeenCalledTimes(7));
  const second = [...document.querySelectorAll<HTMLCanvasElement>(THUMBNAIL_CANVAS)];
  expect(second).toHaveLength(4);
  expect(document.querySelector('[aria-label="Include page 5"]')).toBe(reviewControl);
  dialogButton("Previous thumbnails").click();
  expect([...document.querySelectorAll(THUMBNAIL_CANVAS)]).toEqual(first);
  expect(state.renderThumbnail).toHaveBeenCalledTimes(7);
  const strip = document.querySelector<HTMLElement>(".inkbook-image-import-thumbnails-strip")!;
  Object.defineProperty(strip, "clientWidth", { value: 400 });
  strip.scrollLeft = 50;
  strip.dispatchEvent(new Event("scroll"));
  const duringScroll = [...document.querySelectorAll(THUMBNAIL_CANVAS)];
  expect(duringScroll).toEqual([...first, second[0]]);
  expect(state.renderThumbnail).toHaveBeenCalledTimes(7);
  strip.scrollLeft = 0;
  strip.dispatchEvent(new Event("scroll"));
  dialogButton("Next thumbnails").click();
  dialogButton("Next thumbnails").click();
  await vi.waitFor(() => expect(state.renderThumbnail).toHaveBeenCalledTimes(11));
  expect(document.querySelectorAll(THUMBNAIL_CANVAS)).toHaveLength(4);
  expect(first.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  expect(state.render).toHaveBeenCalledExactlyOnceWith(1, expect.anything());
  expect(openPdfImageSource).toHaveBeenCalledOnce();
  dialogButton("Cancel").click();
  expect(await state.pending).toBeUndefined();
  expect(second.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
});

it("aborts an in-flight thumbnail on viewport exit and releases a late result before returning", async () => {
  setImportThumbnailVisibility(false);
  const state = await setupPdfImport(10_000);
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 144;
  let finish!: (value: HTMLCanvasElement) => void;
  state.renderThumbnail.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  selectImportFile("large.pdf");
  await ready();
  setImportThumbnailVisibility(true);
  await vi.waitFor(() => expect(state.renderThumbnail).toHaveBeenCalledOnce());
  setImportThumbnailVisibility(false);
  expect(state.renderThumbnail.mock.calls[0]?.[1].signal.aborted).toBe(true);
  finish(canvas);
  await vi.waitFor(() => expect(canvas.width).toBe(0));
  expect(canvas.height).toBe(0);
  expect(state.renderThumbnail).toHaveBeenCalledOnce();
  expect(document.querySelector(THUMBNAIL_CANVAS)).toBeNull();
  setImportThumbnailVisibility(true);
  await vi.waitFor(() => expect(document.querySelectorAll(THUMBNAIL_CANVAS)).toHaveLength(4));
  expect(state.renderThumbnail.mock.calls.map(([page]) => page)).toEqual([1, 1, 2, 3, 4]);
  state.abort.abort();
  expect(await state.pending).toBeUndefined();
});

it("pauses thumbnail work while navigating and resumes for the latest scrolled pages", async () => {
  const state = await setupPdfImport(13);
  selectImportFile("pages.pdf");
  await ready();
  await vi.waitFor(() => expect(document.querySelectorAll(THUMBNAIL_CANVAS)).toHaveLength(4));
  const stopAt = state.renderThumbnail.mock.calls.length;
  let finish!: () => void;
  state.render.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return state.resource;
  });

  previewPage(6);
  previewPage(7);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const strip = document.querySelector<HTMLElement>(".inkbook-image-import-thumbnails-strip")!;
  Object.defineProperty(strip, "clientWidth", { value: 400 });
  strip.scrollLeft = 850;
  strip.dispatchEvent(new Event("scroll"));
  expect(document.querySelector('[aria-label="Include page 13"]')).not.toBeNull();
  expect(state.renderThumbnail).toHaveBeenCalledTimes(stopAt);
  const include = document.querySelector<HTMLInputElement>('[aria-label="Include page 9"]')!;
  include.click();
  expect(include.checked).toBe(false);

  finish();
  await ready();
  await vi.waitFor(() => expect(document.querySelectorAll(THUMBNAIL_CANVAS)).toHaveLength(5));
  expect(state.renderThumbnail.mock.calls.slice(stopAt).map(([page]) => page)).toEqual([
    9, 10, 11, 12, 13,
  ]);
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 6, 7]);
  dialogButton("Cancel").click();
  expect(await state.pending).toBeUndefined();
});

it("uses one decode and encode pair per distinct raster size across review and insertion", async () => {
  const small = await validImageResource();
  const bytes = Uint8Array.from(atob(small.data), (char) => char.charCodeAt(0));
  const source = imageHeaderBytes(bytes, 1920, 1080);
  const { prepareRasterImage } = await vi.importActual<
    typeof import("../../../../src/obsidian/images/image-import")
  >("../../../../src/obsidian/images/image-import");
  vi.mocked(imageImportMocks.prepareRasterImage).mockImplementation(prepareRasterImage);
  vi.mocked(readImageSource).mockResolvedValue(source);
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 1920, height: 1080, close }));
  vi.stubGlobal("createImageBitmap", decode);
  const { draw, draws, encode } = installImageRasterBoundary(bytes);
  encode.mockImplementation(function (this: HTMLCanvasElement, callback, mime) {
    callback(
      mime === "image/webp"
        ? null
        : new Blob([imageHeaderBytes(bytes, this.width, this.height)], {
            type: "image/png",
          }),
    );
  });
  const state = setupImageImport();
  selectImportFile();
  await ready();
  const preview = document.querySelector<HTMLImageElement>("figure img")!;
  const initial = preview.src;
  quality("standard");
  await ready();
  expect([preview.width, preview.height]).toEqual([1885, 1060]);
  expect(preview.src).not.toBe(initial);
  for (const profile of ["very-high", "ultra", "high"]) {
    quality(profile);
    await ready();
    expect(preview.src).toBe(initial);
  }
  imageImportSubmit().click();
  const batch = await state.pending;
  expect(batch?.resources[0]?.data).toBe(initial.split(",")[1]);
  expect(readImageSource).toHaveBeenCalledOnce();
  expect(decode).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
  expect(draw).toHaveBeenCalledTimes(2);
  expect(draws).toEqual([
    { width: 1920, height: 1080 },
    { width: 1885, height: 1060 },
  ]);
  expect(encode.mock.calls.map(([, mime]) => mime)).toEqual([
    "image/webp",
    "image/png",
    "image/webp",
    "image/png",
  ]);
});

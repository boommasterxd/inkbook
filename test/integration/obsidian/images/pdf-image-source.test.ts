// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPdfImageSource } from "../../../../src/obsidian/images/pdf-image-source";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { validImageResource } from "../../../fixtures/persistence/images";
import { installImageRasterBoundary } from "../../../fixtures/obsidian/image-raster";
import { webpBytes } from "../../../fixtures/persistence/webp-images";

const host = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("obsidian", () => ({ loadPdfJs: host.load }));
afterEach(() => vi.restoreAllMocks());

async function pdfSetup(width = 10_000, height = 10_000) {
  const resource = await validImageResource();
  const bytes = Uint8Array.from(atob(resource.data), (char) => char.charCodeAt(0));
  const { canvases, encode } = installImageRasterBoundary(bytes);
  const cancel = vi.fn();
  const cleanup = vi.fn();
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
    }),
    render,
    cleanup,
  };
  const getPage = vi.fn(async () => page);
  const destroy = vi.fn(async () => undefined);
  const getDocument = vi.fn((_options: Record<string, unknown>) => ({
    promise: Promise.resolve({ numPages: 3, getPage }),
    destroy,
  }));
  host.load.mockResolvedValue({ getDocument });
  const abort = new AbortController();
  const source = await openPdfImageSource(new TextEncoder().encode("%PDF-1.7"), abort.signal);
  return {
    expectedResource: resource,
    source,
    abort,
    canvases,
    encode,
    getDocument,
    getPage,
    render,
    cancel,
    cleanup,
    destroy,
    options: { document, scheduler: new TestWorkScheduler(), signal: abort.signal },
  };
}

describe("owned host PDF rasterization", () => {
  it("uses the shared lossless WebP selection for rendered PDF pages", async () => {
    const state = await pdfSetup();
    const fallback = new Blob(
      [Uint8Array.from(atob(state.expectedResource.data), (value) => value.charCodeAt(0))],
      { type: "image/png" },
    );
    state.encode.mockImplementation((callback, type) =>
      callback(type === "image/webp" ? new Blob([webpBytes()], { type: "image/webp" }) : fallback),
    );
    expect(await state.source.render(1, state.options)).toMatchObject({
      mimeType: "image/webp",
      width: 3,
      height: 2,
    });
    expect(state.encode.mock.calls.map(([, type]) => type)).toEqual(["image/webp", "image/png"]);
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    await state.source.dispose();
  });

  it("bounds each page before rasterization, releases canvas/page state and blocks external font/CMap retrieval", async () => {
    const state = await pdfSetup();
    const resource = await state.source.render(2, state.options);
    expect(resource).toEqual(state.expectedResource);
    expect(state.getPage).toHaveBeenCalledWith(2);
    expect(state.render).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { width: 2000, height: 2000 } }),
    );
    expect(state.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(state.cleanup).toHaveBeenCalledOnce();
    const options = state.getDocument.mock.calls[0]![0];
    expect(options).toMatchObject({
      isEvalSupported: false,
      useWorkerFetch: false,
      useSystemFonts: false,
      useWasm: false,
      stopAtErrors: true,
    });
    expect(options).not.toHaveProperty("maxImageSize");
    const Factory = options["CMapReaderFactory"] as new () => { fetch(): Promise<unknown> };
    await expect(new Factory().fetch()).rejects.toThrow("local host");
    await state.source.dispose();
    await state.source.dispose();
    expect(state.destroy).toHaveBeenCalledOnce();
  });
});

describe("higher PDF raster resolutions", () => {
  it("honors a 16MP render budget and reports the actual limited DPI only after successful rendering", async () => {
    const state = await pdfSetup();
    expect(state.source.resolution).toBeUndefined();
    await state.source.render(1, { ...state.options, scale: 400 / 72, maximumPixels: 16_000_000 });
    expect(state.render).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { width: 4000, height: 4000 } }),
    );
    expect(state.source.resolution).toEqual({ page: 1, dpi: 28.8, limited: true });
    expect(state.getPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.canvases).toHaveLength(1);
    expect(state.canvases[0]).toMatchObject({ width: 0, height: 0 });
    const retained = state.source.resolution;
    state.render.mockImplementationOnce(() => {
      throw new Error("Native render failed");
    });
    await expect(state.source.render(2, state.options)).rejects.toThrow("Native render failed");
    expect(state.source.resolution).toBe(retained);
    expect(state.cleanup).toHaveBeenCalledTimes(2);
    await state.source.dispose();
  });

  it.each([
    [300, 9_000_000],
    [400, 16_000_000],
  ])(
    "renders an A4 page at the requested %s DPI within its profile",
    async (dpi, maximumPixels) => {
      const state = await pdfSetup(595, 842);
      const scale = dpi / 72;
      await state.source.render(1, { ...state.options, scale, maximumPixels });
      expect(state.render).toHaveBeenCalledWith(
        expect.objectContaining({ viewport: { width: 595 * scale, height: 842 * scale } }),
      );
      expect(state.source.resolution?.dpi).toBeCloseTo(dpi);
      expect(state.source.resolution).toMatchObject({ page: 1, limited: false });
      expect(state.getPage).toHaveBeenCalledOnce();
      expect(state.render).toHaveBeenCalledOnce();
      expect(state.cleanup).toHaveBeenCalledOnce();
      await state.source.dispose();
    },
  );
});

describe("owned PDF cancellation and loading failures", () => {
  it("bounds thumbnail rendering and gives a pending foreground raster priority without encoding thumbnails", async () => {
    const state = await pdfSetup(2_000, 3_000);
    const thumbnail = await state.source.renderThumbnail(1, state.options);
    expect(thumbnail).toMatchObject({ width: 96, height: 144 });
    expect(state.render).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ viewport: { width: 96, height: 144 } }),
    );
    expect(state.encode).not.toHaveBeenCalled();
    expect(state.source.resolution).toBeUndefined();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejected) => {
      reject = rejected;
    });
    state.cancel.mockImplementationOnce(() => reject(new Error("Cancelled thumbnail")));
    state.render.mockReturnValueOnce({ promise: pending, cancel: state.cancel });
    const background = state.source.renderThumbnail(2, state.options);
    await vi.waitFor(() => expect(state.render).toHaveBeenCalledTimes(2));
    const foreground = state.source.render(3, state.options);
    await expect(background).rejects.toThrow("Cancelled thumbnail");
    expect(await foreground).toEqual(state.expectedResource);
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.getPage.mock.calls).toEqual([[1], [2], [3]]);
    expect(state.cleanup).toHaveBeenCalledTimes(3);
    expect(state.canvases[1]).toMatchObject({ width: 0, height: 0 });
    expect(state.source.resolution?.page).toBe(3);
    await state.source.dispose();
  });

  it("cancels an in-flight render on owner unload and releases its resources", async () => {
    const state = await pdfSetup();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejected) => {
      reject = rejected;
    });
    state.cancel.mockImplementation(() => reject(new Error("Cancelled PDF rendering")));
    state.render.mockReturnValue({ promise: pending, cancel: state.cancel });
    const rendered = state.source.render(1, state.options);
    await vi.waitFor(() => expect(state.render).toHaveBeenCalled());
    state.abort.abort();
    await expect(rendered).rejects.toThrow("Cancelled");
    expect(state.destroy).toHaveBeenCalledOnce();
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it("rejects incompatible host exports and excessive source page counts", async () => {
    host.load.mockResolvedValue({});
    await expect(
      openPdfImageSource(new TextEncoder().encode("%PDF-1.7"), new AbortController().signal),
    ).rejects.toThrow("unavailable");
    const destroy = vi.fn(async () => undefined);
    host.load.mockResolvedValue({
      getDocument: () => ({
        promise: Promise.resolve({ numPages: 10_001, getPage: vi.fn() }),
        destroy,
      }),
    });
    await expect(
      openPdfImageSource(new TextEncoder().encode("%PDF-1.7"), new AbortController().signal),
    ).rejects.toThrow("capacity");
    expect(destroy).toHaveBeenCalledOnce();
  });
});

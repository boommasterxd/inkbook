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

async function pdfSetup() {
  const resource = await validImageResource();
  const bytes = Uint8Array.from(atob(resource.data), (char) => char.charCodeAt(0));
  const { canvases, encode } = installImageRasterBoundary(bytes);
  const cancel = vi.fn();
  const cleanup = vi.fn();
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 10_000 * scale,
      height: 10_000 * scale,
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

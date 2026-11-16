// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePdfPages,
  prepareRasterImage,
  readImageSource,
} from "../../../../src/obsidian/images/image-import";
import { IMAGE_LIMITS } from "../../../../src/domain/images/image-limits";
import { imageHeaderBytes, validImageResource } from "../../../fixtures/persistence/images";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { installImageRasterBoundary } from "../../../fixtures/obsidian/image-raster";
import { imageImportErrorMessage } from "../../../../src/obsidian/images/image-import-error";
import { webpBytes } from "../../../fixtures/persistence/webp-images";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local image source admission", () => {
  it("rejects oversized source files before reading their bytes", async () => {
    let reads = 0;
    const file = {
      size: IMAGE_LIMITS.sourceBytes + 1,
      arrayBuffer: () => {
        reads += 1;
        return Promise.resolve(new ArrayBuffer(0));
      },
    } as File;
    await expect(readImageSource(file, new AbortController().signal)).rejects.toMatchObject({
      reason: "sourceSize",
    });
    expect(reads).toBe(0);
  });

  it("reads admitted bytes once and rejects cancelled or changed sources", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const file = { size: 3, arrayBuffer: () => Promise.resolve(bytes.buffer) } as File;
    expect(await readImageSource(file, new AbortController().signal)).toEqual(bytes);
    const abort = new AbortController();
    abort.abort();
    await expect(readImageSource(file, abort.signal)).rejects.toThrow();
    await expect(
      readImageSource({ ...file, size: 4 }, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "sourceRead" });
  });

  it("rejects empty sources without reading them", async () => {
    const arrayBuffer = vi.fn();
    await expect(
      readImageSource({ size: 0, arrayBuffer } as unknown as File, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "sourceRead" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("identifies native file read failures without exposing their details", async () => {
    const file = {
      size: 3,
      arrayBuffer: () => Promise.reject(new DOMException("private path", "NotReadableError")),
    } as File;
    const error: unknown = await readImageSource(file, new AbortController().signal).catch(
      (error: unknown) => error,
    );
    expect(imageImportErrorMessage(error)).toBe("images.failureSourceRead");
  });

  it("distinguishes invalid headers, pixel limits and native decoding failures before rasterization", async () => {
    const resource = await validImageResource();
    const bytes = Uint8Array.from(atob(resource.data), (char) => char.charCodeAt(0));
    const createImageBitmap = vi.fn(async () => {
      throw new Error("native decoder details must stay private");
    });
    const createElement = vi.fn();
    const options = {
      document: { defaultView: { createImageBitmap }, createElement } as unknown as Document,
      scheduler: new TestWorkScheduler(),
      signal: new AbortController().signal,
    };
    const oversized = bytes.slice();
    new DataView(oversized.buffer).setUint32(16, IMAGE_LIMITS.sourcePixels + 1);
    for (const [source, message] of [
      [new Uint8Array(24), "images.failureFormat"],
      [oversized, "images.failureDimensions"],
    ] as const) {
      const error: unknown = await prepareRasterImage(source, options).catch(
        (error: unknown) => error,
      );
      expect(imageImportErrorMessage(error)).toBe(message);
    }
    expect(createImageBitmap).not.toHaveBeenCalled();
    const error: unknown = await prepareRasterImage(bytes, options).catch(
      (error: unknown) => error,
    );
    expect(imageImportErrorMessage(error)).toBe("images.failureDecode");
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect(createElement).not.toHaveBeenCalled();
  });
});

describe("explicit PDF page selection", () => {
  it("deduplicates the requested pages and returns them in document order", () => {
    expect(parsePdfPages("5, 1, 3-5", 10)).toEqual([1, 3, 4, 5]);
    expect(parsePdfPages("1-20", 100)).toHaveLength(20);
  });

  it.each(["", "0", "5-2", "101", "1-21", "1-20,21", "1,", "1.5", "1e2"])(
    "rejects invalid or oversized selections: %s",
    (value) => {
      expect(() => parsePdfPages(value, 100)).toThrow(RangeError);
    },
  );
});

describe("raster image fitting", () => {
  it("admits WebP source bytes through the native decoder and preserves the raster result contract", async () => {
    const source = webpBytes();
    const png = await validImageResource();
    const output = imageHeaderBytes(
      Uint8Array.from(atob(png.data), (value) => value.charCodeAt(0)),
      3,
      2,
    );
    const decode = vi.fn(async (_blob: Blob) => ({ width: 3, height: 2, close: vi.fn() }));
    vi.stubGlobal("createImageBitmap", decode);
    installImageRasterBoundary(output);
    const result = await prepareRasterImage(source, {
      document,
      scheduler: new TestWorkScheduler(),
      signal: new AbortController().signal,
    });
    expect(result).not.toHaveProperty("resizedFrom");
    expect(result.resource).toMatchObject({ mimeType: "image/png", width: 3, height: 2 });
    expect(decode.mock.calls[0]?.[0]).toMatchObject({ type: "image/webp" });
  });

  it.each([
    [6000, 4000, 2449, 1632],
    [4000, 6000, 1632, 2449],
  ])(
    "fits decoded %s × %s proportionally, including normalized orientation",
    async (width, height, targetWidth, targetHeight) => {
      const resource = await validImageResource();
      const bytes = Uint8Array.from(atob(resource.data), (char) => char.charCodeAt(0));
      const source = imageHeaderBytes(bytes, 6000, 4000);
      const output = imageHeaderBytes(bytes, targetWidth, targetHeight);
      vi.stubGlobal("createImageBitmap", async () => ({ width, height, close: vi.fn() }));
      const { draw } = installImageRasterBoundary(output);
      const result = await prepareRasterImage(source, {
        document,
        scheduler: new TestWorkScheduler(),
        signal: new AbortController().signal,
      });
      expect(result.resizedFrom).toEqual({ width, height });
      expect(result.resource).toMatchObject({ width: targetWidth, height: targetHeight });
      expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, targetWidth, targetHeight);
      expect(targetWidth * targetHeight).toBeLessThanOrEqual(IMAGE_LIMITS.resourcePixels);
    },
  );
});

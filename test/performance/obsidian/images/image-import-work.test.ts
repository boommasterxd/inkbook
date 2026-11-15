// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { prepareRasterImage } from "../../../../src/obsidian/images/image-import";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  capacityImageResource,
  imageHeaderBytes,
  validImageResource,
} from "../../../fixtures/persistence/images";
import { installImageRasterBoundary } from "../../../fixtures/obsidian/image-raster";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function rasterOptions(signal = new AbortController().signal) {
  return { document, scheduler: new TestWorkScheduler(), signal };
}

function expectReleasedRaster(
  boundary: ReturnType<typeof installImageRasterBoundary>,
  close: ReturnType<typeof vi.fn>,
  encodes = 1,
): void {
  expect(boundary.encode).toHaveBeenCalledTimes(encodes);
  expect(close).toHaveBeenCalledOnce();
  expect(boundary.canvases).toHaveLength(1);
  expect(boundary.canvases[0]!.width).toBe(0);
  expect(boundary.canvases[0]!.height).toBe(0);
}

async function cancellationFixture() {
  const resource = await validImageResource();
  const bytes = Uint8Array.from(atob(resource.data), (char) => char.charCodeAt(0));
  return { bytes, abort: new AbortController(), close: vi.fn() };
}

it("normalizes one admitted image without upscaling and releases its native resources", async () => {
  const resource = await validImageResource();
  const bytes = Uint8Array.from(atob(resource.data), (char) => char.charCodeAt(0));
  const close = vi.fn();
  const bitmap = { width: 1, height: 1, close };
  const decode = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  const boundary = installImageRasterBoundary(bytes);
  const { draw, contexts, draws } = boundary;
  const options = rasterOptions();
  expect(await prepareRasterImage(bytes, options)).toEqual({ resource });
  expect(decode).toHaveBeenCalledOnce();
  expect(decode).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: "from-image" });
  expect(draw).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0, 1, 1);
  expect(draws).toEqual([{ width: 1, height: 1 }]);
  expect(contexts[0]?.imageSmoothingQuality).toBeUndefined();
  expectReleasedRaster(boundary, close);
  await expect(prepareRasterImage(imageHeaderBytes(bytes, 8001, 4000), options)).rejects.toThrow();
  expect(decode).toHaveBeenCalledOnce();
});

it.each([2000, 4000] as const)(
  "decodes a 25.4MP source once and draws and encodes one %spx raster",
  async (axis) => {
    const resource = await capacityImageResource(1, axis);
    const bytes = Uint8Array.from(atob(resource.data), (char) => char.charCodeAt(0));
    const source = imageHeaderBytes(bytes, 5040, 5040);
    const close = vi.fn();
    const bitmap = { width: 5040, height: 5040, close };
    close.mockImplementation(() => {
      bitmap.width = 0;
      bitmap.height = 0;
    });
    const decode = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    const boundary = installImageRasterBoundary(bytes);
    const { draw, contexts, draws } = boundary;
    boundary.encode.mockImplementation((callback) => {
      expect(close).toHaveBeenCalledOnce();
      expect(draw).toHaveBeenCalledOnce();
      callback(new Blob([bytes], { type: "image/png" }));
    });
    const options = {
      ...rasterOptions(),
      ...(axis === 4000 ? { maximumPixels: 16_000_000 } : {}),
    };
    expect(await prepareRasterImage(source, options)).toEqual({
      resource,
      resizedFrom: { width: 5040, height: 5040 },
    });
    expect(decode).toHaveBeenCalledOnce();
    expect(draw).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0, axis, axis);
    expect(draws).toEqual([{ width: axis, height: axis }]);
    expect(contexts[0]).toMatchObject({
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
    });
    expectReleasedRaster(boundary, close);
  },
);

it("closes a decoded bitmap when its owner cancels before rasterization", async () => {
  const { bytes, abort, close } = await cancellationFixture();
  vi.stubGlobal("createImageBitmap", () => {
    abort.abort();
    return Promise.resolve({ width: 1, height: 1, close });
  });
  const { draw, encode } = installImageRasterBoundary(bytes);
  await expect(prepareRasterImage(bytes, rasterOptions(abort.signal))).rejects.toThrow();
  expect(close).toHaveBeenCalledOnce();
  expect(draw).not.toHaveBeenCalled();
  expect(encode).not.toHaveBeenCalled();
});

it.each(["cancel", "failure"])("releases bitmap and canvas after encoding %s", async (outcome) => {
  const { bytes, abort, close } = await cancellationFixture();
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close }));
  const boundary = installImageRasterBoundary(bytes);
  const { draw, encode } = boundary;
  encode.mockImplementation((callback) => {
    if (outcome === "cancel") abort.abort();
    callback(outcome === "cancel" ? new Blob([bytes]) : null);
  });
  await expect(prepareRasterImage(bytes, rasterOptions(abort.signal))).rejects.toThrow();
  expect(draw).toHaveBeenCalledOnce();
  expectReleasedRaster(boundary, close, outcome === "failure" ? 2 : 1);
});

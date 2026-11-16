// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeImageCanvas } from "../../../../src/obsidian/images/image-canvas-encoding";
import { IMAGE_LIMITS } from "../../../../src/domain/images/image-limits";
import { validImageResource, progressiveJpegBytes } from "../../../fixtures/persistence/images";
import { webpBytes, webpChunk, webpContainer } from "../../../fixtures/persistence/webp-images";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

afterEach(() => vi.restoreAllMocks());

async function encodingSetup() {
  const png = await validImageResource();
  const fallback = new Blob([Uint8Array.from(atob(png.data), (value) => value.charCodeAt(0))], {
    type: "image/png",
  });
  const candidate = new Blob([webpBytes()], { type: "image/webp" });
  const candidateRead = vi.spyOn(candidate, "arrayBuffer");
  const fallbackRead = vi.spyOn(fallback, "arrayBuffer");
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback, type) => callback(type === "image/webp" ? candidate : fallback));
  const canvas = document.createElement("canvas");
  canvas.width = 3;
  canvas.height = 2;
  const abort = new AbortController();
  return {
    png,
    fallback,
    candidate,
    candidateRead,
    fallbackRead,
    encode,
    canvas,
    abort,
    options: { scheduler: new TestWorkScheduler(), signal: abort.signal },
  };
}

describe("native image encoding selection", () => {
  it("selects strictly smaller lossless WebP and reads only its byte buffer once", async () => {
    const state = await encodingSetup();
    const result = await encodeImageCanvas(state.canvas, "image/png", state.options);
    expect(result).toMatchObject({ mimeType: "image/webp", width: 3, height: 2 });
    expect(result).not.toHaveProperty("lossless");
    expect(atob(result.data).length).toBe(state.candidate.size);
    expect(state.encode.mock.calls.map(([, type, quality]) => [type, quality])).toEqual([
      ["image/webp", 1],
      ["image/png", 0.9],
    ]);
    expect(state.candidateRead).toHaveBeenCalledOnce();
    expect(state.fallbackRead).not.toHaveBeenCalled();
  });

  it("reuses the PNG returned by an unsupported WebP encoder without encoding again", async () => {
    const state = await encodingSetup();
    state.encode.mockImplementation((callback) => callback(state.fallback));
    expect(await encodeImageCanvas(state.canvas, "image/png", state.options)).toEqual(state.png);
    expect(state.encode).toHaveBeenCalledExactlyOnceWith(expect.any(Function), "image/webp", 1);
    expect(state.fallbackRead).toHaveBeenCalledOnce();
  });

  it.each(["null", "throw", "lossy", "malformed"])(
    "uses the existing JPEG baseline when the WebP candidate is %s",
    async (failure) => {
      const state = await encodingSetup();
      const jpeg = new Blob([progressiveJpegBytes()], { type: "image/jpeg" });
      const read = vi.spyOn(jpeg, "arrayBuffer");
      state.encode.mockImplementation((callback, type) => {
        if (type !== "image/webp") return callback(jpeg);
        if (failure === "throw") throw new Error("Native encoder unavailable");
        callback(
          failure === "null"
            ? null
            : new Blob([failure === "lossy" ? webpBytes("lossy") : new Uint8Array(24)], {
                type: "image/webp",
              }),
        );
      });
      expect(await encodeImageCanvas(state.canvas, "image/jpeg", state.options)).toMatchObject({
        mimeType: "image/jpeg",
        width: 16,
        height: 16,
      });
      expect(state.encode.mock.calls.map(([, type, quality]) => [type, quality])).toEqual([
        ["image/webp", 1],
        ["image/jpeg", 0.9],
      ]);
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it.each([0, 2])("keeps PNG when WebP is %s bytes larger, including equality", async (extra) => {
    const state = await encodingSetup();
    const bytes = webpBytes();
    const padded = webpContainer(
      bytes.subarray(12),
      webpChunk("JUNK", new Uint8Array(state.fallback.size + extra - bytes.length - 8)),
    );
    const candidate = new Blob([padded], { type: "image/webp" });
    const read = vi.spyOn(candidate, "arrayBuffer");
    state.encode.mockImplementation((callback, type) =>
      callback(type === "image/webp" ? candidate : state.fallback),
    );
    expect(candidate.size).toBe(state.fallback.size + extra);
    expect(await encodeImageCanvas(state.canvas, "image/png", state.options)).toEqual(state.png);
    expect(read).not.toHaveBeenCalled();
    expect(state.fallbackRead).toHaveBeenCalledOnce();
    expect(state.encode).toHaveBeenCalledTimes(2);
  });
});

describe("native image encoding capacity", () => {
  it("does not admit WebP above 8 MiB even when it is smaller than the fallback", async () => {
    const state = await encodingSetup();
    const candidate = new Blob([new Uint8Array(IMAGE_LIMITS.resourceBytes + 1)], {
      type: "image/webp",
    });
    const fallback = new Blob([new Uint8Array(IMAGE_LIMITS.resourceBytes + 2)], {
      type: "image/png",
    });
    const candidateRead = vi.spyOn(candidate, "arrayBuffer");
    const fallbackRead = vi.spyOn(fallback, "arrayBuffer");
    state.encode.mockImplementation((callback, type) =>
      callback(type === "image/webp" ? candidate : fallback),
    );
    await expect(encodeImageCanvas(state.canvas, "image/png", state.options)).rejects.toMatchObject(
      { reason: "encodedSize" },
    );
    expect(state.encode).toHaveBeenCalledTimes(2);
    expect(candidateRead).not.toHaveBeenCalled();
    expect(fallbackRead).not.toHaveBeenCalled();
  });

  it("skips WebP for the supported 16,384-pixel axis", async () => {
    const state = await encodingSetup();
    state.canvas.width = 16_384;
    await encodeImageCanvas(state.canvas, "image/png", state.options);
    expect(state.encode).toHaveBeenCalledExactlyOnceWith(expect.any(Function), "image/png", 0.9);
  });

  it("rejects an oversized fallback before reading its bytes", async () => {
    const state = await encodingSetup();
    const oversized = new Blob([new Uint8Array(IMAGE_LIMITS.resourceBytes + 1)], {
      type: "image/png",
    });
    const read = vi.spyOn(oversized, "arrayBuffer");
    state.encode.mockImplementation((callback) => callback(oversized));
    await expect(encodeImageCanvas(state.canvas, "image/png", state.options)).rejects.toMatchObject(
      {
        reason: "encodedSize",
      },
    );
    expect(state.encode).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects unsupported fallback MIME without reading an unrelated image format", async () => {
    const state = await encodingSetup();
    const fallback = new Blob([webpBytes()], { type: "image/gif" });
    const read = vi.spyOn(fallback, "arrayBuffer");
    state.encode.mockImplementation((callback) => callback(fallback));
    await expect(encodeImageCanvas(state.canvas, "image/png", state.options)).rejects.toThrow(
      "unsupported",
    );
    expect(read).not.toHaveBeenCalled();
  });
});

describe("serial encoding admission and cancellation", () => {
  it("stops validation without reading fallback bytes when cancellation occurs at a header checkpoint", async () => {
    const state = await encodingSetup();
    const candidate = new Blob(
      [webpContainer(webpBytes().subarray(12), webpChunk("JUNK", new Uint8Array(4096)))],
      { type: "image/webp" },
    );
    const fallback = new Blob([progressiveJpegBytes(), new Uint8Array(8192)], {
      type: "image/jpeg",
    });
    const read = vi.spyOn(fallback, "arrayBuffer");
    state.encode.mockImplementation((callback, type) =>
      callback(type === "image/webp" ? candidate : fallback),
    );
    let checkpoints = 0;
    const scheduler = new TestWorkScheduler({
      checkpoint: () => {
        checkpoints += 1;
        if (checkpoints === 2) state.abort.abort();
        return undefined;
      },
    });
    await expect(
      encodeImageCanvas(state.canvas, "image/jpeg", { ...state.options, scheduler }),
    ).rejects.toThrow();
    expect(checkpoints).toBe(2);
    expect(state.encode).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["resume", "cancel"])(
    "keeps fallback behind central admission until %s",
    async (action) => {
      const state = await encodingSetup();
      let finish!: BlobCallback;
      let resume!: () => void;
      const checkpoint = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resume = resolve;
          }),
      );
      const options = { ...state.options, scheduler: new TestWorkScheduler({ checkpoint }) };
      state.encode.mockImplementation((callback, type) => {
        if (type === "image/webp") finish = callback;
        else callback(state.fallback);
      });
      const pending = encodeImageCanvas(state.canvas, "image/png", options);
      expect(state.encode).toHaveBeenCalledOnce();
      expect(checkpoint).not.toHaveBeenCalled();
      finish(null);
      await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
      expect(state.encode).toHaveBeenCalledOnce();
      // Subsequent validation checkpoints do not need another admission hold.
      checkpoint.mockImplementation(() => Promise.resolve());
      if (action === "cancel") state.abort.abort();
      resume();
      if (action === "cancel") {
        await expect(pending).rejects.toThrow();
        expect(state.encode).toHaveBeenCalledOnce();
        expect(state.candidateRead).not.toHaveBeenCalled();
        expect(state.fallbackRead).not.toHaveBeenCalled();
        return;
      }
      expect(await pending).toEqual(state.png);
      expect(state.encode).toHaveBeenCalledTimes(2);
    },
  );

  it("does not start encoding for an already cancelled owner", async () => {
    const state = await encodingSetup();
    state.abort.abort();
    await expect(encodeImageCanvas(state.canvas, "image/png", state.options)).rejects.toThrow();
    expect(state.encode).not.toHaveBeenCalled();
  });

  it("does not start fallback work after cancellation during the first native encode", async () => {
    const state = await encodingSetup();
    state.encode.mockImplementation((callback) => {
      state.abort.abort();
      callback(state.candidate);
    });
    await expect(encodeImageCanvas(state.canvas, "image/png", state.options)).rejects.toThrow();
    expect(state.encode).toHaveBeenCalledOnce();
    expect(state.candidateRead).not.toHaveBeenCalled();
    expect(state.fallbackRead).not.toHaveBeenCalled();
  });

  it("does not read fallback bytes after cancellation while reading the WebP candidate", async () => {
    const state = await encodingSetup();
    state.candidateRead.mockImplementation(async () => {
      state.abort.abort();
      return webpBytes().buffer;
    });
    await expect(encodeImageCanvas(state.canvas, "image/png", state.options)).rejects.toThrow();
    expect(state.encode).toHaveBeenCalledTimes(2);
    expect(state.candidateRead).toHaveBeenCalledOnce();
    expect(state.fallbackRead).not.toHaveBeenCalled();
  });
});

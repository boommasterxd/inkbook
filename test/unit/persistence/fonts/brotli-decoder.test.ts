import { Platform } from "obsidian";
import initialize, { DecompressStream, BrotliStreamResult } from "brotli-dec-wasm/web";
import wasmSource from "brotli-dec-wasm/web/bg.wasm?url&inline";
import { afterEach, expect, it, vi } from "vitest";
import { decodeBrotliFont } from "../../../../src/persistence/fonts/brotli-decoder";
import { decodeFontResource } from "../../../../src/persistence/fonts/font-resources";
import { FONT_LIMITS } from "../../../../src/persistence/fonts/font-container";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

afterEach(() => vi.restoreAllMocks());
const scheduler = new TestWorkScheduler();

async function compressedFixture(bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Platform.isDesktop) {
    const { brotliCompressSync, constants } = await import("node:zlib");
    return new Uint8Array(
      brotliCompressSync(new Uint8Array(bytes), {
        params: { [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_QUALITY]: 1 },
      }),
    );
  }
  throw new Error("Compression fixtures require the desktop test runtime.");
}

it("bounds capacity output, native calls and retained decoder memory and frees native resources", async () => {
  const compressed = await compressedFixture(FONT_LIMITS.decodedBytes);
  const calls = vi.spyOn(DecompressStream.prototype, "decompress");
  const free = vi.spyOn(DecompressStream.prototype, "free");
  const resultFree = vi.spyOn(BrotliStreamResult.prototype, "free");
  const fetch = vi.spyOn(globalThis, "fetch");
  let received = 0;
  let largest = 0;
  await decodeBrotliFont(compressed, FONT_LIMITS.decodedBytes, {
    scheduler,
    receive: (bytes, offset) => {
      expect(offset).toBe(received);
      received += bytes.length;
      largest = Math.max(largest, bytes.length);
    },
  });
  expect(received).toBe(FONT_LIMITS.decodedBytes);
  expect(largest).toBeLessThanOrEqual(4096);
  expect(calls.mock.calls.length).toBeLessThanOrEqual(
    Math.ceil(received / 4096) + Math.ceil(compressed.length / 4096) + 1,
  );
  expect(calls.mock.calls.every(([input, output]) => input.length <= 4096 && output === 4096)).toBe(
    true,
  );
  expect(resultFree).toHaveBeenCalledTimes(calls.mock.calls.length);
  expect(free).toHaveBeenCalledOnce();
  const data = wasmSource.startsWith("data:")
    ? wasmSource.slice(wasmSource.indexOf(",") + 1)
    : wasmSource;
  const runtime = await initialize({
    module_or_path: await decodeFontResource({ data }, scheduler),
  });
  expect(runtime.memory.buffer.byteLength).toBeLessThanOrEqual(64 * 1024 * 1024);
  const retainedBytes = runtime.memory.buffer.byteLength;
  expect(() => runtime.memory.grow(1024)).toThrow();
  expect(runtime.memory.buffer.byteLength).toBe(retainedBytes);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects expansion mismatches and truncated streams while releasing the real native stream", async () => {
  const compressed = await compressedFixture(64 * 1024);
  const free = vi.spyOn(DecompressStream.prototype, "free");
  await expect(
    decodeBrotliFont(compressed, 1024, { scheduler, receive: () => undefined }),
  ).rejects.toThrow();
  await expect(
    decodeBrotliFont(compressed.subarray(0, compressed.length - 1), 64 * 1024, {
      scheduler,
      receive: () => undefined,
    }),
  ).rejects.toThrow();
  expect(free).toHaveBeenCalledTimes(2);
});

it("rejects nonstandard large windows and over-limit output before the native decoder consumes input", async () => {
  const calls = vi.spyOn(DecompressStream.prototype, "decompress");
  await expect(
    decodeBrotliFont(new Uint8Array([0x11, 0x1e]), 1024, { scheduler, receive: () => undefined }),
  ).rejects.toThrow();
  await expect(
    decodeBrotliFont(new Uint8Array([0]), FONT_LIMITS.decodedBytes + 1, {
      scheduler,
      receive: () => undefined,
    }),
  ).rejects.toThrow();
  expect(calls).not.toHaveBeenCalled();
});

it("honors shared-scheduler cancellation and frees a partially decoded native stream", async () => {
  const compressed = await compressedFixture(64 * 1024);
  const controller = new AbortController();
  const calls = vi.spyOn(DecompressStream.prototype, "decompress");
  const free = vi.spyOn(DecompressStream.prototype, "free");
  const admitted = new TestWorkScheduler({
    checkpoint: () => {
      if (calls.mock.calls.length > 0) controller.abort();
    },
  });
  await expect(
    decodeBrotliFont(compressed, 64 * 1024, {
      scheduler: admitted,
      signal: controller.signal,
      receive: () => undefined,
    }),
  ).rejects.toThrow();
  expect(calls).toHaveBeenCalledOnce();
  expect(free).toHaveBeenCalledOnce();
});

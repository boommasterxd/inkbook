import { afterEach, expect, it, vi } from "vitest";

import { adoptUtf8Output } from "../../../src/persistence/scheduling/utf8-adoption";
import { inspectTrustedSvgOutput } from "../../../src/persistence/scheduling/trusted-svg-output";
import * as mainThread from "../../../src/persistence/scheduling/main-thread-yield";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";

afterEach(() => vi.restoreAllMocks());

it("rechecks the live budget between actual hash chunks and preserves abort boundaries", async () => {
  let now = 0;
  let budget = 2;
  let work = 0;
  const slices: number[] = [];
  const abort = new AbortController();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const update = Object.getOwnPropertyDescriptor(ChunkedSha256.prototype, "update")!
    .value as ChunkedSha256["update"];
  const chunks = vi.spyOn(ChunkedSha256.prototype, "update").mockImplementation(function (
    this: ChunkedSha256,
    bytes,
  ) {
    now += 1;
    work += 1;
    return update.call(this, bytes);
  });
  vi.spyOn(mainThread, "yieldToMainThread").mockImplementation(async () => {
    slices.push(work);
    work = 0;
    budget = 1;
    if (slices.length === 3) abort.abort();
  });
  await expect(
    inspectTrustedSvgOutput(new Uint8Array(6 * 64 * 1024), undefined, {
      sliceBudgetMs: () => budget,
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(slices).toEqual([2, 1, 1]);
  expect(chunks).toHaveBeenCalledTimes(4);
  expect(chunks.mock.calls.every(([bytes]) => bytes.byteLength === 64 * 1024)).toBe(true);
});

it("adapts UTF-8 decoding work after the owning display budget changes", async () => {
  let now = 0;
  let budget = 3;
  let work = 0;
  const slices: number[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const decode = Object.getOwnPropertyDescriptor(TextDecoder.prototype, "decode")!
    .value as TextDecoder["decode"];
  const chunks = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
    this: TextDecoder,
    bytes,
    options,
  ) {
    if (bytes !== undefined && bytes.byteLength > 0) {
      now += 1;
      work += 1;
    }
    return decode.call(this, bytes, options);
  });
  vi.spyOn(mainThread, "yieldToMainThread").mockImplementation(async () => {
    slices.push(work);
    work = 0;
    budget = 1;
  });
  await expect(
    adoptUtf8Output(new TextEncoder().encode("abcdefgh"), {
      chunkBytes: 2,
      sliceBudgetMs: () => budget,
    }),
  ).resolves.toBe("abcdefgh");
  expect(slices).toEqual([3, 1]);
  expect(chunks.mock.calls.filter(([bytes]) => bytes !== undefined)).toHaveLength(4);
});

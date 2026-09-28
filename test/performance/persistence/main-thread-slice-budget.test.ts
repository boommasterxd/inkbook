import { afterEach, expect, it, vi } from "vitest";

import { adoptUtf8Output } from "../../../src/persistence/scheduling/utf8-adoption";
import { inspectTrustedSvgOutput } from "../../../src/persistence/scheduling/trusted-svg-output";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import { createTestWorkScheduler } from "../../fixtures/persistence/work-scheduler";

afterEach(() => vi.restoreAllMocks());

function createSliceProbe(initialBudget: number, afterSlice?: (count: number) => void) {
  let now = 0;
  let budget = initialBudget;
  let work = 0;
  const slices: number[] = [];
  const workScheduler = createTestWorkScheduler({
    shouldYield: () => now >= budget,
    checkpoint: async () => {
      if (now < budget) return;
      slices.push(work);
      work = 0;
      now = 0;
      budget = 1;
      afterSlice?.(slices.length);
    },
  });
  return {
    now: () => now,
    observeWork: () => {
      now += 1;
      work += 1;
    },
    slices,
    workScheduler,
  };
}

it("rechecks the live budget between actual hash chunks and preserves abort boundaries", async () => {
  const abort = new AbortController();
  const probe = createSliceProbe(2, (count) => {
    if (count === 3) abort.abort();
  });
  vi.spyOn(performance, "now").mockImplementation(probe.now);
  const update = Object.getOwnPropertyDescriptor(ChunkedSha256.prototype, "update")!
    .value as ChunkedSha256["update"];
  const chunks = vi.spyOn(ChunkedSha256.prototype, "update").mockImplementation(function (
    this: ChunkedSha256,
    bytes,
  ) {
    probe.observeWork();
    return update.call(this, bytes);
  });
  await expect(
    inspectTrustedSvgOutput(new Uint8Array(6 * 64 * 1024), undefined, {
      workScheduler: probe.workScheduler,
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(probe.slices).toEqual([2, 1, 1]);
  expect(chunks).toHaveBeenCalledTimes(4);
  expect(chunks.mock.calls.every(([bytes]) => bytes.byteLength === 64 * 1024)).toBe(true);
});

it("adapts UTF-8 decoding work after the owning display budget changes", async () => {
  const probe = createSliceProbe(3);
  vi.spyOn(performance, "now").mockImplementation(probe.now);
  const decode = Object.getOwnPropertyDescriptor(TextDecoder.prototype, "decode")!
    .value as TextDecoder["decode"];
  const chunks = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
    this: TextDecoder,
    bytes,
    options,
  ) {
    if (bytes !== undefined && bytes.byteLength > 0) probe.observeWork();
    return decode.call(this, bytes, options);
  });
  await expect(
    adoptUtf8Output(new TextEncoder().encode("abcdefgh"), {
      chunkBytes: 2,
      workScheduler: probe.workScheduler,
    }),
  ).resolves.toBe("abcdefgh");
  expect(probe.slices).toEqual([3, 1]);
  expect(chunks.mock.calls.filter(([bytes]) => bytes !== undefined)).toHaveLength(4);
});

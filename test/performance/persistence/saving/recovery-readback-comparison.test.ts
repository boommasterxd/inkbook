import { afterEach, expect, it, vi } from "vitest";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import {
  exactStringEqual,
  exactStringEqualScheduled,
} from "../../../../src/persistence/saving/exact-string-equality";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";

const CHUNK_CODE_UNITS = 256 * 1024;

afterEach(() => vi.restoreAllMocks());

function observeReads(sources: readonly string[], onRead?: () => void) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The observer forwards the actual string receiver with .call.
  const original = String.prototype.slice;
  const reads = { calls: 0, codeUnits: 0, largest: 0 };
  vi.spyOn(String.prototype, "slice").mockImplementation(function (this: string, start, end) {
    const output = original.call(this, start, end);
    if (sources.includes(this)) {
      reads.calls += 1;
      reads.codeUnits += output.length;
      reads.largest = Math.max(reads.largest, output.length);
      onRead?.();
    }
    return output;
  });
  return reads;
}

it("compares full-capacity synchronous content without allocating string slices", () => {
  const source = `${"a".repeat(FILE_SCHEMA_LIMITS.totalInputBytes - 1)}z`;
  const copy = new TextDecoder().decode(new TextEncoder().encode(source));
  const mismatch = `${copy.substring(0, copy.length - 1)}b`;
  const longer = `${copy}a`;
  const reads = observeReads([source, copy, mismatch, longer]);

  expect(exactStringEqual(source, copy)).toBe(true);
  expect(exactStringEqual(source, mismatch)).toBe(false);
  expect(exactStringEqual(source, longer)).toBe(false);
  expect(reads.calls).toBe(0);
  expect(reads.codeUnits).toBe(0);
});

it("reads full ASCII file capacity once per side in bounded chunks without forced handoffs", async () => {
  const source = "a".repeat(FILE_SCHEMA_LIMITS.totalInputBytes);
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const reads = observeReads([source]);
  try {
    expect(await exactStringEqualScheduled(source, source, scheduler)).toBe(true);
    expect(reads.codeUnits).toBe(2 * FILE_SCHEMA_LIMITS.totalInputBytes);
    expect(reads.largest).toBeLessThanOrEqual(CHUNK_CODE_UNITS);
    expect(reads.calls).toBe(2 * Math.ceil(source.length / CHUNK_CODE_UNITS));
    expect(host.frameRequests).toBe(0);
  } finally {
    scheduler.dispose();
  }
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});

it("does no reads for empty or different-length inputs and stops at the first mismatching chunk", async () => {
  const source = "a".repeat(3 * CHUNK_CODE_UNITS);
  const mismatch = `b${source.substring(1)}`;
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const reads = observeReads([source, mismatch]);
  try {
    expect(await exactStringEqualScheduled("", "", scheduler)).toBe(true);
    expect(await exactStringEqualScheduled(source, `${source}a`, scheduler)).toBe(false);
    expect(reads.codeUnits).toBe(0);
    expect(reads.calls).toBe(0);
    expect(await exactStringEqualScheduled(source, mismatch, scheduler)).toBe(false);
    expect(reads.codeUnits).toBe(2 * CHUNK_CODE_UNITS);
    expect(reads.calls).toBe(2);
    expect(reads.largest).toBe(CHUNK_CODE_UNITS);
    expect(host.frameRequests).toBe(0);
  } finally {
    scheduler.dispose();
  }
});

it("waits for central admission before reading the next chunk and resumes the same comparison", async () => {
  const source = "a".repeat(3 * CHUNK_CODE_UNITS);
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  let initialChunk = true;
  const reads = observeReads([source], () => {
    // Simulate budget exhaustion at the actual string-read boundary.
    if (initialChunk) host.time = host.budget;
  });
  try {
    const comparison = exactStringEqualScheduled(source, source, scheduler);
    expect(reads.codeUnits).toBe(2 * CHUNK_CODE_UNITS);
    expect(host.pendingFrames).toBe(1);
    await Promise.resolve();
    expect(reads.codeUnits).toBe(2 * CHUNK_CODE_UNITS);
    initialChunk = false;
    host.time += host.frameInterval;
    host.frame(host.time);
    expect(await comparison).toBe(true);
    expect(reads.codeUnits).toBe(2 * source.length);
    expect(reads.largest).toBe(CHUNK_CODE_UNITS);
    expect(host.frameRequests).toBe(1);
  } finally {
    scheduler.dispose();
  }
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});

it("stops reads when pending admission rejects and releases all scheduler resources", async () => {
  const source = "a".repeat(3 * CHUNK_CODE_UNITS);
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const reads = observeReads([source], () => {
    host.time = host.budget;
  });
  const comparison = exactStringEqualScheduled(source, source, scheduler);
  const rejection = expect(comparison).rejects.toThrow("disposed");
  expect(reads.codeUnits).toBe(2 * CHUNK_CODE_UNITS);
  expect(host.pendingFrames).toBe(1);
  scheduler.dispose();
  await rejection;
  host.frame(host.time + host.frameInterval);
  expect(reads.codeUnits).toBe(2 * CHUNK_CODE_UNITS);
  expect(reads.calls).toBe(2);
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});

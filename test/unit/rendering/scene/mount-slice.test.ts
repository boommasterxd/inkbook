import { describe, expect, it, vi } from "vitest";

import { MountSlice } from "../../../../src/rendering/scene/mount-slice";

describe("MountSlice minimum progress", () => {
  it("admits one bounded element when the 240 Hz deadline is already exhausted", () => {
    const slice = new MountSlice(2.29, () => 3);
    const expensivePath = { geometry: 100_000, strokePoints: 100_000 };

    expect(slice.blockingReason(expensivePath)).toBeUndefined();
    slice.record(expensivePath);
    expect(slice.blockingReason({ geometry: 1, strokePoints: 0 })).toBe("deadline");
    expect(slice.elements).toBe(1);
  });
});

it("makes progress after admission without charging a second deadline probe", () => {
  let time = 0;
  const slice = new MountSlice(10, () => time++);
  const job = { step: vi.fn(() => true) };
  expect(slice.prepare(job)).toBe(true);
  slice.record({ geometry: 1, strokePoints: 1 });
  time = 9;
  expect(slice.blockingReason({ geometry: 1, strokePoints: 1 })).toBeUndefined();
  expect(slice.prepare(job)).toBe(true);
  expect(job.step).toHaveBeenCalledTimes(2);
  expect(slice.blockingReason({ geometry: 1, strokePoints: 1 })).toBe("deadline");
});

it("keeps the preparation allowance shared across admitted jobs", () => {
  const slice = new MountSlice(10, () => 0);
  const completed = { step: vi.fn(() => true) };
  for (let index = 0; index < 63; index++) expect(slice.prepare(completed)).toBe(true);
  const unfinished = { step: vi.fn(() => false) };
  expect(slice.prepare(unfinished)).toBe(false);
  expect(unfinished.step).toHaveBeenCalledOnce();
  expect(slice.prepare(completed)).toBe(false);
  expect(completed.step).toHaveBeenCalledTimes(63);
});

it("waits for a fresh publication allowance when a two-root element cannot fit", () => {
  const partial = new MountSlice(10, () => 0, 1);
  expect(partial.claimPublicationNodes(2)).toBe(false);
  expect(partial.publicationNodes).toBe(0);
  const fresh = new MountSlice(10, () => 0, 64);
  expect(fresh.claimPublicationNodes(2)).toBe(true);
  expect(fresh.claimPublicationNodes(63)).toBe(false);
  expect(fresh.publicationNodes).toBe(2);
});

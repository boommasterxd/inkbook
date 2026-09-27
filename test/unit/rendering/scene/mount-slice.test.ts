import { describe, expect, it, vi } from "vitest";

import { MountSlice } from "../../../../src/rendering/scene/mount-slice";

describe("MountSlice minimum progress", () => {
  it("admits one bounded element when the 240 Hz deadline is already exhausted", () => {
    const slice = new MountSlice(2.29, () => 3);

    expect(slice.blockingReason()).toBeUndefined();
    slice.record();
    expect(slice.blockingReason()).toBe("deadline");
    expect(slice.elements).toBe(1);
  });
});

it("makes progress after admission without charging a second deadline probe", () => {
  let time = 0;
  const slice = new MountSlice(10, () => time++);
  const job = { step: vi.fn(() => true) };
  expect(slice.prepare(job)).toBe(true);
  slice.record();
  time = 9;
  expect(slice.blockingReason()).toBeUndefined();
  expect(slice.prepare(job)).toBe(true);
  expect(job.step).toHaveBeenCalledTimes(2);
  expect(slice.blockingReason()).toBe("deadline");
});

it("continues bounded preparation steps while the shared deadline has room", () => {
  const slice = new MountSlice(10, () => 0);
  const job = { step: vi.fn(() => job.step.mock.calls.length >= 96) };
  expect(slice.prepare(job)).toBe(true);
  expect(job.step).toHaveBeenCalledTimes(96);
});

it("stops between bounded preparation steps when the shared deadline expires", () => {
  let time = 0;
  const slice = new MountSlice(2, () => time);
  const job = {
    step: vi.fn(() => {
      time += 1;
      return false;
    }),
  };
  expect(slice.prepare(job)).toBe(false);
  expect(job.step).toHaveBeenCalledTimes(2);
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

import { describe, expect, it, vi } from "vitest";
import * as strokePosition from "../../../../src/domain/geometry/stroke-position";
import {
  createInitialRecord,
  createInitialRecordSteps,
  createOwnedInitialRecordSteps,
  createOwnedReplacementRecordSteps,
  createReplacementRecord,
  createReplacementRecordSteps,
} from "../../../../src/domain/store/record-factory";
import type { ElementRecord } from "../../../../src/domain/store/types";
import { highlighter } from "./fixtures";

function complete(steps: Generator<void, ElementRecord>): ElementRecord {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

describe("resumable record construction", () => {
  it("copies ordinary candidates and preserves owned identities", () => {
    const source = highlighter();
    const initial = complete(createInitialRecordSteps(source));
    expect(initial).toEqual(createInitialRecord(source));
    expect(initial.element).not.toBe(source);
    expect(initial.element.kind === "stroke" && initial.element.points).not.toBe(source.points);
    source.points[0] = -100;
    expect(initial.element.kind === "stroke" && initial.element.points[0]).toBe(100);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.bounds)).toBe(true);

    const owned = highlighter();
    const transferred = complete(createOwnedInitialRecordSteps(owned));
    expect(transferred.element).toBe(owned);
    expect(Object.isFrozen(owned.points)).toBe(true);
  });

  it("reuses immutable samples and bounds for paint replacements without geometry work", () => {
    const current = createInitialRecord(highlighter());
    const element = current.element as ReturnType<typeof highlighter>;
    const candidate = { ...element, style: { ...element.style, opacity: 0.25 } };
    const transform = vi.spyOn(strokePosition, "strokeWorldPoint");
    try {
      const replacement = complete(createReplacementRecordSteps(candidate, current, 0, 1));
      expect(replacement.bounds).toBe(current.bounds);
      expect(replacement.element.kind === "stroke" && replacement.element.points).toBe(
        element.points,
      );
      expect(replacement).toEqual(createReplacementRecord(candidate, current, 0, 1));
      const owned = complete(createOwnedReplacementRecordSteps(candidate, current, 0, 1));
      expect(owned.element).toBe(candidate);
      expect(owned.bounds).toBe(current.bounds);
      expect(transform).not.toHaveBeenCalled();
    } finally {
      transform.mockRestore();
    }
  });

  it("checks bounds incrementally for owned geometry replacements and cancels pending work", () => {
    const current = createInitialRecord(highlighter());
    const candidate = {
      ...highlighter(),
      points: Array.from({ length: 513 }, (_, index) => [index, index % 7, 0.5]).flat(),
    };
    const transform = vi.spyOn(strokePosition, "strokeWorldPoint");
    try {
      const steps = createOwnedReplacementRecordSteps(candidate, current, 1, 1);
      expect(steps.next().done).toBe(false);
      expect(transform).toHaveBeenCalledTimes(256);
      expect(steps.next().done).toBe(false);
      expect(transform).toHaveBeenCalledTimes(512);
      const result = steps.next();
      expect(result.done).toBe(true);
      expect(transform).toHaveBeenCalledTimes(513);
      expect(result.value).toEqual(createReplacementRecord(candidate, current, 1, 1));

      const cancelled = createOwnedInitialRecordSteps(candidate, 1);
      expect(cancelled.next().done).toBe(false);
      const before = transform.mock.calls.length;
      cancelled.return(current);
      expect(cancelled.next().done).toBe(true);
      expect(transform).toHaveBeenCalledTimes(before);
    } finally {
      transform.mockRestore();
    }
  });
});

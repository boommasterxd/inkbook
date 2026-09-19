import { afterEach, describe, expect, it, vi } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import * as strokePath from "../../../../src/domain/geometry/stroke-path";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";
import { createAllElementSnapshot } from "../../persistence/serialization/fixtures";
import { indexedStroke } from "../../../fixtures/editor/stroke";

const buildCenters = strokePath.transformedStrokeCenters;
afterEach(() => vi.restoreAllMocks());

describe("progressive canonical preview geometry", () => {
  it.each([1, 2, 3, 59, 60, 61, 64, 127, 4096])(
    "matches the committed continuous pressure outline for %i pressure samples at every slice boundary",
    (count) => {
      const element = {
        ...indexedStroke(1),
        rotation: 37,
        points: Array.from({ length: count }, (_, index) => [
          20 + index * 0.1,
          30 + (index % 2) * 5,
          0.1 + (index % 9) / 10,
        ]).flat(),
      };
      const { job, step } = observeProgressivePath(element);
      let steps = 1;
      while (!step()) {
        expect(job.parts).toBeUndefined();
        steps += 1;
      }
      expect(job.parts).toEqual(buildElementPathParts(element));
      if (count === 4096) expect(steps).toBeGreaterThan(60);
    },
  );

  it.each([1, 2, 3, 59, 60, 61, 64, 127, 4096])(
    "keeps one byte-identical centerline across %i non-pressure samples",
    (count) => {
      for (const rotation of [0, 37]) {
        const base = indexedStroke(1);
        const element = {
          ...base,
          rotation,
          style: { ...base.style, pressureEnabled: false },
          points: Array.from({ length: count }, (_, index) => [
            20 + index * 0.1,
            30 + (index % 2),
            0.5,
          ]).flat(),
        };
        const { job, step } = observeProgressivePath(element);
        while (!step()) {
          expect(job.parts).toBeUndefined();
        }
        expect(job.parts).toEqual(buildElementPathParts(element));
        expect(job.parts![0]!.d.match(/M/gu)).toHaveLength(1);
      }
    },
  );

  it("uses the canonical geometry builder for every non-pressure element kind", () => {
    for (const element of createAllElementSnapshot().elements) {
      if (element.kind === "stroke") element.style = { ...element.style, pressureEnabled: false };
      const job = new ProgressivePreviewPath(element);
      expect(job.step()).toBe(true);
      expect(job.parts).toEqual(buildElementPathParts(element));
    }
  });
});

function observeProgressivePath(element: StrokeElementV1) {
  let reads = 0;
  let minimum = Infinity;
  let maximum = -1;
  const centers = vi.spyOn(strokePath, "transformedStrokeCenters").mockImplementation(
    (stroke) =>
      new Proxy(buildCenters(stroke), {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) {
            const index = Number(key);
            reads += 1;
            minimum = Math.min(minimum, index);
            maximum = Math.max(maximum, index);
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
  );
  centers.mockClear();
  const job = new ProgressivePreviewPath(element);
  return {
    job,
    step: () => {
      reads = 0;
      minimum = Infinity;
      maximum = -1;
      const complete = job.step();
      // At most 64 curves plus two boundary centers. Each curve reads three
      // centers; pressure validation adds one read per consumed center.
      const maximumCenters = Math.min(element.points.length / 3, 66);
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(maximumCenters * (element.style.pressureEnabled ? 4 : 3));
      expect(maximum - minimum + 1).toBeLessThanOrEqual(maximumCenters);
      expect(centers).toHaveBeenCalledTimes(1);
      return complete;
    },
  };
}

it("releases smoothed centers and partial strings after completing canonical geometry", () => {
  const element = {
    ...indexedStroke(1),
    points: Array.from({ length: 4096 }, (_, index) => [index, index % 2, 0.5]).flat(),
  };
  const job = new ProgressivePreviewPath(element);
  expect(job.memoryUsage()).toBeGreaterThan(0);
  while (!job.step()) {
    /* Build without retaining completed intermediates. */
  }
  expect(job.memoryUsage()).toBe(job.parts!.reduce((bytes, part) => bytes + part.d.length * 2, 0));
});

it("keeps completed path identity when stepped again", () => {
  const job = new ProgressivePreviewPath(indexedStroke(1));
  while (!job.step()) {
    /* Complete all geometry slices. */
  }
  const parts = job.parts;
  expect(job.step()).toBe(true);
  expect(job.parts).toBe(parts);
});

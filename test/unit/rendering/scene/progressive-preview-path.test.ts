import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";
import { createAllElementSnapshot } from "../../persistence/serialization/fixtures";
import { indexedStroke } from "../../../fixtures/editor/stroke";

describe("progressive canonical preview geometry", () => {
  it.each([1, 2, 3, 59, 60, 61, 64, 127, 4096])(
    "matches the committed swept path for %i pressure samples at every slice boundary",
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
      const job = new ProgressivePreviewPath(element);
      let steps = 1;
      while (!job.step()) {
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
        const job = new ProgressivePreviewPath(element);
        while (!job.step()) {
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

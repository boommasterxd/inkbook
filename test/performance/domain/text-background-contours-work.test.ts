import { expect, it } from "vitest";
import { textBackgroundContoursSteps } from "../../../src/domain/geometry/text-background-contours";
import { finishGeometrySteps } from "../../fixtures/domain/geometry-steps";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";

it("joins two thousand touching strips with bounded edge work and cancels without visiting remaining strips", () => {
  const count = 2000;
  const rectangles = observeSchemaArray(
    Array.from({ length: count }, (_, index) => ({
      x: index % 2 === 0 ? 0 : 20,
      y: index * 20,
      width: index % 2 === 0 ? 100 : 80,
      height: 20,
    })),
  );
  const box = { x: 0, y: 0, width: 100, height: count * 20 };
  let visits = 0;
  const path = finishGeometrySteps(
    textBackgroundContoursSteps(box, rectangles.observed, 0, () => {
      visits += 1;
    }),
  );
  expect(rectangles.work.indexedReads).toBe(count);
  // Eight endpoint events per rectangle, each copied once per merge pass;
  // collection, cancellation and stitching add at most four linear passes.
  expect(visits).toBeLessThanOrEqual(8 * count * (Math.ceil(Math.log2(2 * count)) + 4));
  expect(path.match(/M/gu)).toHaveLength(1);
  expect(path.length).toBeLessThan(100 * count);
  rectangles.work.indexedReads = 0;
  const cancelled = textBackgroundContoursSteps(box, rectangles.observed, 0);
  expect(cancelled.next().done).toBe(false);
  cancelled.return(undefined as never);
  expect(rectangles.work.indexedReads).toBe(1);
  rectangles.work.indexedReads = 0;
  visits = 0;
  const sorting = textBackgroundContoursSteps(box, rectangles.observed, 0, () => {
    visits += 1;
  });
  while (rectangles.work.indexedReads < count) expect(sorting.next().done).toBe(false);
  const collected = visits;
  expect(sorting.next().done).toBe(false);
  expect(visits - collected).toBe(1);
  sorting.return(undefined as never);
  expect(visits).toBe(collected + 1);
});

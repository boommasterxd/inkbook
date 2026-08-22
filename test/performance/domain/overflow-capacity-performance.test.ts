import { expect, it } from "vitest";

import { assertOverflowCapacity } from "../../../src/domain/store/record-factory";
import type { ElementRecord } from "../../../src/domain/store/types";

it("checks overlapping replacement and removal membership in linear time", async ({ annotate }) => {
  const records = Array.from({ length: 20_000 }, (_, index) => record(index));
  const started = performance.now();
  assertOverflowCapacity(0, records, [], records);
  const duration = performance.now() - started;

  await annotate(
    `20k overlapping overflow-capacity check=${duration.toFixed(3)} ms`,
    "performance",
  );
  expect(duration).toBeLessThanOrEqual(40);
});

function record(index: number): ElementRecord {
  return {
    bounds: { maxX: 1, maxY: 1, minX: 0, minY: 0 },
    element: { id: String(index) } as ElementRecord["element"],
    geometryVersion: 0,
    paintVersion: 0,
  };
}

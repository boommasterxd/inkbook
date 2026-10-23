import { expect, it } from "vitest";

import { assertOverflowCapacity } from "../../../src/domain/store/records/record-factory";
import type { ElementRecord } from "../../../src/domain/store/types";
function record(index: number): ElementRecord {
  return {
    bounds: { maxX: 1, maxY: 1, minX: 0, minY: 0 },
    element: { id: String(index) } as ElementRecord["element"],
    geometryVersion: 0,
    paintVersion: 0,
  };
}

it.each([1_000, 20_000])("bounds overlapping membership reads linearly for %i records", (size) => {
  let reads = 0;
  const records = new Proxy(
    Array.from({ length: size }, (_, index) => record(index)),
    {
      get(target, key, receiver) {
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) {
          reads += 1;
          if (reads > size * 4) throw new Error("Overflow membership exceeded linear work.");
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    },
  );

  assertOverflowCapacity(0, records, [], records);

  expect(reads).toBeGreaterThanOrEqual(size);
  expect(reads).toBeLessThanOrEqual(size * 4);
});

import { describe, expect, it } from "vitest";

import { tableLineSegments } from "../../../../src/domain/geometry/public";
import { table } from "./fixtures";

describe("table line segments", () => {
  it("provides every local outline and divider segment", () => {
    expect(tableLineSegments(table())).toEqual([
      [
        { x: 10, y: 20 },
        { x: 160, y: 20 },
      ],
      [
        { x: 160, y: 20 },
        { x: 160, y: 120 },
      ],
      [
        { x: 160, y: 120 },
        { x: 10, y: 120 },
      ],
      [
        { x: 10, y: 120 },
        { x: 10, y: 20 },
      ],
      [
        { x: 10, y: 50 },
        { x: 160, y: 50 },
      ],
      [
        { x: 60, y: 20 },
        { x: 60, y: 120 },
      ],
      [
        { x: 110, y: 20 },
        { x: 110, y: 120 },
      ],
    ]);
  });
});

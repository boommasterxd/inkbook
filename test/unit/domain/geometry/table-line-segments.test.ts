import { describe, expect, it } from "vitest";

import { tableColumnOffsets } from "../../../../src/domain/geometry/public";
import { tableLineSegments } from "../../../../src/domain/geometry/creation";
import { table } from "./fixtures";

describe("table line segments", () => {
  it("uses equal-width separators when no custom offsets are stored", () => {
    expect(tableColumnOffsets(table())).toEqual([50, 100]);
  });

  it("uses persisted separator offsets without emitting an outer frame", () => {
    const custom = table({ columnOffsets: [60, 105] });

    expect(tableColumnOffsets(custom)).toEqual([60, 105]);
    expect(tableLineSegments(custom)).toEqual([
      headerSegment(),
      [
        { x: 70, y: 20 },
        { x: 70, y: 120 },
      ],
      [
        { x: 115, y: 20 },
        { x: 115, y: 120 },
      ],
    ]);
  });

  it("provides the header and every inner divider segment", () => {
    expect(tableLineSegments(table())).toEqual([
      headerSegment(),
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

function headerSegment() {
  return [
    { x: 10, y: 50 },
    { x: 160, y: 50 },
  ];
}

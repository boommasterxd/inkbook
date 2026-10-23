import { describe, expect, it } from "vitest";

import { table } from "../../../domain/geometry/fixtures";
import {
  editTableColumn,
  editTableHeader,
} from "../../../../../src/editor/selection/transform/table-transforms";

describe("table structural transforms", () => {
  it("clamps the header only to the outer top and bottom edges", () => {
    const source = table();

    expect(editTableHeader(source, source.y - 100).headerHeight).toBe(0);
    expect(editTableHeader(source, source.y + source.height + 100).headerHeight).toBe(
      source.height,
    );
    expect(editTableHeader(source, source.y + 42.3456).headerHeight).toBe(42.346);
  });

  it("lets column separators reach the outer edges and cross each other", () => {
    const source = table();

    expect(editTableColumn(source, 0, source.x + 1000).columnOffsets).toEqual([100, 150]);
    expect(editTableColumn(source, 1, source.x - 1000).columnOffsets).toEqual([0, 50]);
    expect(editTableColumn(source, 0, source.x).columnOffsets).toEqual([0, 100]);
  });

  it("rejects invalid separator input without producing partial geometry", () => {
    const source = table();

    expect(() => editTableHeader(source, Number.NaN)).toThrow(RangeError);
    expect(() => editTableColumn(source, -1, source.x)).toThrow(RangeError);
    expect(() => editTableColumn(source, 0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

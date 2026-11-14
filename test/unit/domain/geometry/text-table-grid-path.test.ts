import { expect, it } from "vitest";
import { textTableGridPathSteps } from "../../../../src/domain/geometry/text-table-grid-path";
import { scaledTextContent } from "../../../../src/domain/geometry/text-scale";
import { expandLegacyTextPaddingSteps } from "../../../../src/domain/geometry/text-padding";
import { copyRuntimeElementSteps } from "../../../../src/domain/elements/runtime-element-copy";
import { textElement } from "../../../fixtures/rendering/text";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";

it("shares one field-local grid path and preserves owned frame rows through scaling and legacy padding", () => {
  const element = textElement();
  const table = {
    start: 0,
    end: 5,
    x: 2,
    y: 3,
    width: 100,
    height: 40,
    columns: 2,
    rowHeights: [15, 25],
    borderWidth: 1,
  };
  element.layout.tables = [table];
  const path = finishGeometrySteps(textTableGridPathSteps(table));
  expect(finishGeometrySteps(textTableGridPathSteps({ ...table, width: 0, borderWidth: 0 }))).toBe(
    "",
  );
  expect(path.match(/M/gu)).toHaveLength(6);
  expect(path).toContain("M51.5 3H52.5V43H51.5Z");
  expect(path).toContain("M2 17.5H102V18.5H2Z");
  const copy = finishGeometrySteps(copyRuntimeElementSteps(element));
  table.rowHeights[0] = 16;
  expect(copy.layout.tables![0]!.rowHeights).toEqual([15, 25]);
  const scaled = scaledTextContent(copy, 1.5).layout.tables![0]!;
  expect(scaled).toMatchObject({
    x: 3,
    y: 4.5,
    width: 150,
    height: 60,
    rowHeights: [22.5, 37.5],
    borderWidth: 1.5,
  });
  expect(scaled.start).toBe(table.start);
  const padded = finishGeometrySteps(expandLegacyTextPaddingSteps(copy));
  const frame = padded.layout.tables![0]!;
  expect(padded.x + frame.x).toBe(copy.x + copy.layout.tables![0]!.x);
  expect(padded.y + frame.y).toBe(copy.y + copy.layout.tables![0]!.y);
  expect(frame.rowHeights).toBe(copy.layout.tables![0]!.rowHeights);
});

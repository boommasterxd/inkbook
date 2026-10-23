import { canonicalPoint } from "../../../domain/geometry/public";
import type { InkElementV1 } from "../../../domain/schema/public";

import type { ScaleFactors } from "./transforms";

export function recoverCollapsedScaleSource(element: InkElementV1): {
  readonly element: InkElementV1;
  readonly initial: ScaleFactors;
} {
  if (!("x" in element)) return { element, initial: { x: 1, y: 1 } };
  const width = element.kind === "table" ? element.columns * element.columnWidth : element.width;
  const initial = { x: width === 0 ? 0 : 1, y: element.height === 0 ? 0 : 1 };
  if (initial.x === 1 && initial.y === 1) return { element, initial };
  // A unit basis makes a collapsed axis editable without changing its initial painted size.
  const recoveredWidth = width || (element.kind === "table" ? element.columns : 1);
  const height = element.height || 1;
  const topLeft = canonicalPoint({
    x: element.x - (recoveredWidth - width) / 2,
    y: element.y - (height - element.height) / 2,
  });
  const recovered = { ...element, ...topLeft, height };
  if (recovered.kind !== "table") {
    return { element: { ...recovered, width: recoveredWidth }, initial };
  }
  const { columnOffsets, ...table } = recovered;
  return {
    element: {
      ...table,
      columnWidth: width === 0 ? 1 : table.columnWidth,
      ...(width === 0 || columnOffsets === undefined ? {} : { columnOffsets }),
    },
    initial,
  };
}

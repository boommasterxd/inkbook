import { roundCanonical, tableColumnOffsets } from "../../domain/geometry/public";
import type { InkElementV1 } from "../../domain/schema/public";

type TableElement = Extract<InkElementV1, { kind: "table" }>;

export function editTableHeader(element: TableElement, localY: number): TableElement {
  if (!Number.isFinite(localY)) throw new RangeError("Table header position must be finite.");
  const headerHeight = roundCanonical(Math.max(0, Math.min(element.height, localY - element.y)));
  return { ...element, headerHeight };
}

export function editTableColumn(
  element: TableElement,
  separatorIndex: number,
  localX: number,
): TableElement {
  const offsets = [...tableColumnOffsets(element)];
  if (!Number.isInteger(separatorIndex) || offsets[separatorIndex] === undefined) {
    throw new RangeError("Table separator index is out of range.");
  }
  if (!Number.isFinite(localX)) throw new RangeError("Table separator position must be finite.");
  const width = element.columns * element.columnWidth;
  offsets[separatorIndex] = roundCanonical(Math.max(0, Math.min(width, localX - element.x)));
  offsets.sort((left, right) => left - right);
  if (!hasCustomColumnOffsets(offsets, element.columnWidth)) {
    const { columnOffsets: _columnOffsets, ...withoutOffsets } = element;
    return withoutOffsets;
  }
  return { ...element, columnOffsets: offsets };
}

function hasCustomColumnOffsets(offsets: readonly number[], columnWidth: number): boolean {
  return offsets.some((offset, index) => offset !== roundCanonical((index + 1) * columnWidth));
}

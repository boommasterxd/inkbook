import { roundCanonical, tableColumnOffsets } from "../../domain/geometry/public";
import type { InkElementV1 } from "../../domain/schema/public";

type TableElement = Extract<InkElementV1, { kind: "table" }>;

export const MINIMUM_TABLE_HEADER_HEIGHT = 24;

export function editTableHeader(element: TableElement, localY: number): TableElement {
  if (!Number.isFinite(localY)) throw new RangeError("Table header position must be finite.");
  const headerHeight = roundCanonical(
    Math.max(MINIMUM_TABLE_HEADER_HEIGHT, Math.min(element.height / 2, localY - element.y)),
  );
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
  const previous = separatorIndex === 0 ? 0 : offsets[separatorIndex - 1]!;
  const next =
    separatorIndex === offsets.length - 1
      ? element.columns * element.columnWidth
      : offsets[separatorIndex + 1]!;
  offsets[separatorIndex] = roundCanonical(
    Math.max(previous + 40, Math.min(next - 40, localX - element.x)),
  );
  if (!hasCustomColumnOffsets(offsets, element.columnWidth)) {
    const { columnOffsets: _columnOffsets, ...withoutOffsets } = element;
    return withoutOffsets;
  }
  return { ...element, columnOffsets: offsets };
}

export function minimumTableColumnWidth(element: TableElement): number {
  const boundaries = [0, ...tableColumnOffsets(element), element.columns * element.columnWidth];
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < boundaries.length; index += 1) {
    minimum = Math.min(minimum, boundaries[index]! - boundaries[index - 1]!);
  }
  return minimum;
}

function hasCustomColumnOffsets(offsets: readonly number[], columnWidth: number): boolean {
  return offsets.some((offset, index) => offset !== roundCanonical((index + 1) * columnWidth));
}

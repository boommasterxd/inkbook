import { CANONICAL_LOCKED_BUFFER_LINES, PAGE_LAYOUT_STEP } from "../schema/constants";
import type { PageV1 } from "../schema/types";
import { roundCanonical } from "./primitives";

const MINIMUM_EMPTY_WRITING_LINES = 2.5;

export interface PageExtent {
  activeHeight: number;
  activeWritableBottom: number;
  bufferUnit: number;
  layoutStep: number;
  lockedHeight: number;
  lockedWritableBottom: number;
  occupiedBottom: number;
  occupiedRows: number;
}

export function derivePageExtent(page: PageV1, maximumElementBottom: number | null): PageExtent {
  const layoutStep = PAGE_LAYOUT_STEP;
  const bufferUnit = layoutStep;
  const occupiedBottom =
    maximumElementBottom === null ? page.margin : Math.max(page.margin, maximumElementBottom);
  const occupiedRows = Math.ceil(Math.max(0, occupiedBottom - page.margin) / layoutStep);
  const minimumEmptyRows =
    maximumElementBottom === null ? Math.ceil(MINIMUM_EMPTY_WRITING_LINES) : 0;
  const activeRows = Math.max(occupiedRows + page.activeBufferLines, minimumEmptyRows);
  const activeWritableBottom = roundCanonical(page.margin + activeRows * layoutStep);
  const lockedWritableBottom = deriveLockedWritableBottom(
    page,
    occupiedBottom,
    maximumElementBottom === null,
  );
  return {
    activeHeight: roundCanonical(activeWritableBottom + page.margin),
    activeWritableBottom,
    bufferUnit,
    layoutStep,
    lockedHeight: roundCanonical(lockedWritableBottom + page.margin),
    lockedWritableBottom,
    occupiedBottom,
    occupiedRows,
  };
}

function deriveLockedWritableBottom(page: PageV1, occupiedBottom: number, empty: boolean): number {
  if (empty) {
    return roundCanonical(page.margin + Math.ceil(MINIMUM_EMPTY_WRITING_LINES) * PAGE_LAYOUT_STEP);
  }
  const patternStep = page.background.type === "none" ? PAGE_LAYOUT_STEP : page.background.spacing;
  const occupiedPatternRows = Math.ceil(Math.max(0, occupiedBottom - page.margin) / patternStep);
  return roundCanonical(
    page.margin + (occupiedPatternRows + CANONICAL_LOCKED_BUFFER_LINES) * patternStep,
  );
}

export function alignPageHeightToWritingLine(page: PageV1, minimumHeight: number): number {
  const writableHeight = roundCanonical(Math.max(0, minimumHeight - 2 * page.margin));
  const rows = Math.ceil(writableHeight / PAGE_LAYOUT_STEP);
  return roundCanonical(2 * page.margin + rows * PAGE_LAYOUT_STEP);
}

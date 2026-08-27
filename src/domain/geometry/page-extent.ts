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
  const lockedTrailingRows = CANONICAL_LOCKED_BUFFER_LINES;
  const lockedRows = Math.max(occupiedRows + lockedTrailingRows, minimumEmptyRows);
  const activeWritableBottom = roundCanonical(page.margin + activeRows * layoutStep);
  const lockedWritableBottom = roundCanonical(page.margin + lockedRows * layoutStep);
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

export function alignPageHeightToWritingLine(page: PageV1, minimumHeight: number): number {
  const writableHeight = roundCanonical(Math.max(0, minimumHeight - 2 * page.margin));
  const rows = Math.ceil(writableHeight / PAGE_LAYOUT_STEP);
  return roundCanonical(2 * page.margin + rows * PAGE_LAYOUT_STEP);
}

export function derivePreviousBackgroundAlignedLockedHeight(
  page: PageV1,
  maximumElementBottom: number | null,
): number {
  return derivePreviousBackgroundAlignedExtent(page, maximumElementBottom).lockedHeight;
}

/** Returns the pre-pattern-row locked height accepted only while loading existing version 1 files. */
export function deriveLegacyLockedHeight(
  page: PageV1,
  maximumElementBottom: number | null,
): number {
  const extent = derivePreviousBackgroundAlignedExtent(page, maximumElementBottom);
  const minimumEmptyRows =
    maximumElementBottom === null
      ? Math.ceil((MINIMUM_EMPTY_WRITING_LINES * PAGE_LAYOUT_STEP) / extent.backgroundStep)
      : 0;
  const lockedRows = Math.max(
    extent.occupiedRows + (page.lockedBufferLines * extent.bufferUnit) / extent.backgroundStep,
    minimumEmptyRows,
  );
  return page.margin + lockedRows * extent.backgroundStep + page.margin;
}

interface PreviousBackgroundAlignedExtent {
  readonly backgroundStep: number;
  readonly bufferUnit: number;
  readonly lockedHeight: number;
  readonly occupiedRows: number;
}

function derivePreviousBackgroundAlignedExtent(
  page: PageV1,
  maximumElementBottom: number | null,
): PreviousBackgroundAlignedExtent {
  const backgroundStep = page.background.type === "none" ? 1 : page.background.spacing;
  const bufferUnit = Math.ceil(PAGE_LAYOUT_STEP / backgroundStep) * backgroundStep;
  const occupiedBottom =
    maximumElementBottom === null ? page.margin : Math.max(page.margin, maximumElementBottom);
  const occupiedRows = Math.ceil(Math.max(0, occupiedBottom - page.margin) / backgroundStep);
  const minimumEmptyRows =
    maximumElementBottom === null
      ? Math.ceil((MINIMUM_EMPTY_WRITING_LINES * PAGE_LAYOUT_STEP) / backgroundStep)
      : 0;
  const lockedTrailingRows =
    page.background.type === "none" ? bufferUnit / backgroundStep : CANONICAL_LOCKED_BUFFER_LINES;
  const lockedRows = Math.max(occupiedRows + lockedTrailingRows, minimumEmptyRows);
  return {
    backgroundStep,
    bufferUnit,
    lockedHeight: roundCanonical(2 * page.margin + lockedRows * backgroundStep),
    occupiedRows,
  };
}

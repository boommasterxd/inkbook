import { CANONICAL_LOCKED_BUFFER_LINES } from "../schema/constants";
import type { PageV1 } from "../schema/types";

const MINIMUM_EMPTY_WRITING_LINES = 2.5;

export interface PageExtent {
  activeHeight: number;
  activeWritableBottom: number;
  backgroundStep: number;
  bufferUnit: number;
  lockedHeight: number;
  lockedWritableBottom: number;
  occupiedBottom: number;
  occupiedRows: number;
}

export function derivePageExtent(page: PageV1, maximumElementBottom: number | null): PageExtent {
  const backgroundStep = page.background.type === "none" ? 1 : page.background.spacing;
  const bufferUnit = Math.ceil(page.writingLineHeight / backgroundStep) * backgroundStep;
  const occupiedBottom =
    maximumElementBottom === null ? page.margin : Math.max(page.margin, maximumElementBottom);
  const occupiedRows = Math.ceil(Math.max(0, occupiedBottom - page.margin) / backgroundStep);
  const minimumEmptyRows =
    maximumElementBottom === null
      ? Math.ceil((MINIMUM_EMPTY_WRITING_LINES * page.writingLineHeight) / backgroundStep)
      : 0;
  const activeRows = Math.max(
    occupiedRows + (page.activeBufferLines * bufferUnit) / backgroundStep,
    minimumEmptyRows,
  );
  const lockedTrailingRows =
    page.background.type === "none" ? bufferUnit / backgroundStep : CANONICAL_LOCKED_BUFFER_LINES;
  const lockedRows = Math.max(occupiedRows + lockedTrailingRows, minimumEmptyRows);
  const activeWritableBottom = page.margin + activeRows * backgroundStep;
  const lockedWritableBottom = page.margin + lockedRows * backgroundStep;
  return {
    activeHeight: activeWritableBottom + page.margin,
    activeWritableBottom,
    backgroundStep,
    bufferUnit,
    lockedHeight: lockedWritableBottom + page.margin,
    lockedWritableBottom,
    occupiedBottom,
    occupiedRows,
  };
}

/** Returns the pre-pattern-row locked height accepted only while loading existing version 1 files. */
export function deriveLegacyLockedHeight(
  page: PageV1,
  maximumElementBottom: number | null,
): number {
  const extent = derivePageExtent(page, maximumElementBottom);
  const minimumEmptyRows =
    maximumElementBottom === null
      ? Math.ceil((MINIMUM_EMPTY_WRITING_LINES * page.writingLineHeight) / extent.backgroundStep)
      : 0;
  const lockedRows = Math.max(
    extent.occupiedRows + (page.lockedBufferLines * extent.bufferUnit) / extent.backgroundStep,
    minimumEmptyRows,
  );
  return page.margin + lockedRows * extent.backgroundStep + page.margin;
}

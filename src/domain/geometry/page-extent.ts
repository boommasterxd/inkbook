import type { PageV1 } from "../schema/public";

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
  const activeWritableBottom =
    page.margin +
    (occupiedRows + (page.activeBufferLines * bufferUnit) / backgroundStep) * backgroundStep;
  const lockedWritableBottom =
    page.margin +
    (occupiedRows + (page.lockedBufferLines * bufferUnit) / backgroundStep) * backgroundStep;
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

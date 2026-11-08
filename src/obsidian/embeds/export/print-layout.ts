export interface PrintPage {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

/** Root fragments expose real print boundaries, including preceding forced breaks. */
export function readPrintPages(root: HTMLElement): readonly PrintPage[] {
  const rectangles = Array.from(root.getClientRects());
  if (rectangles.length < 2) return [];
  const pages: PrintPage[] = [];
  for (const rectangle of rectangles) {
    if (
      !Number.isFinite(rectangle.top) ||
      !Number.isFinite(rectangle.height) ||
      rectangle.height <= 0 ||
      rectangle.width <= 0 ||
      (pages.length > 0 && rectangle.top < pages[pages.length - 1]!.bottom - 1)
    )
      return [];
    pages.push({ top: rectangle.top, bottom: rectangle.bottom, height: rectangle.height });
  }
  return pages;
}

/** The final fragment can contain only the document tail, not a complete page. */
export function pageContaining(pages: readonly PrintPage[], top: number): PrintPage | undefined {
  if (!Number.isFinite(top) || top < (pages[0]?.top ?? 0) - 1) return undefined;
  let low = 0;
  let high = Math.max(0, pages.length - 1);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (top < pages[middle]!.bottom - 0.5) high = middle;
    else low = middle + 1;
  }
  return low < pages.length - 1 ? pages[low] : undefined;
}

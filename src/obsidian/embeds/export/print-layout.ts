export interface PrintPage {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

/** Arm print-only sizing before Chromium allocates pages; never resize inside the print callback. */
export function prepareNativePdfRoot(root: HTMLElement, scale: number): (() => void) | undefined {
  if (!(scale >= 0.1 && scale < 1)) return undefined;
  const owner = root.ownerDocument.defaultView;
  const cap = `round(up, calc(100% * ${String(scale)}), 1px)`;
  if (owner === null) return undefined;
  const style = owner.getComputedStyle(root);
  if (!supportedNativePdfBox(style)) return undefined;
  const originalMaximum = style.maxInlineSize || "none";
  const printMaximum = originalMaximum === "none" ? cap : `min(${originalMaximum}, ${cap})`;
  if (!owner.CSS.supports("max-inline-size", printMaximum)) return undefined;
  const maximum = `var(--inkbook-native-pdf-print-maximum, ${originalMaximum})`;
  const previous = ["max-inline-size", "--inkbook-native-pdf-maximum"].map((name) => ({
    name,
    value: root.style.getPropertyValue(name),
    priority: root.style.getPropertyPriority(name),
  }));
  const hadStyle = root.hasAttribute("style");
  const hadMarker = root.classList.contains("inkbook-native-pdf-export");
  const restore = () => {
    for (const { name, value, priority } of previous) {
      if (value) root.style.setProperty(name, value, priority);
      else root.style.removeProperty(name);
    }
    if (!hadMarker) root.classList.remove("inkbook-native-pdf-export");
    if (!hadStyle && root.style.length === 0) root.removeAttribute("style");
  };
  try {
    root.style.setProperty("max-inline-size", maximum, previous[0]!.priority);
    root.style.setProperty("--inkbook-native-pdf-maximum", printMaximum);
    root.classList.add("inkbook-native-pdf-export");
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}

export function supportedNativePdfRoot(root: HTMLElement): boolean {
  const owner = root.ownerDocument.defaultView;
  return owner !== null && supportedNativePdfBox(owner.getComputedStyle(root));
}

function supportedNativePdfBox(style: CSSStyleDeclaration): boolean {
  return (
    style.boxSizing === "border-box" &&
    style.transform === "none" &&
    (style.zoom === "1" || style.zoom === "normal") &&
    style.writingMode === "horizontal-tb"
  );
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

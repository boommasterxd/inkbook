export interface ElementContentBox {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

export interface ElementBoxMeasurement {
  readonly borderBox: DOMRect;
  readonly contentBox: ElementContentBox;
}

export function measureElementBox(element: HTMLElement): ElementBoxMeasurement {
  const borderBox = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  const leftInset = cssPixels(style?.borderLeftWidth) + cssPixels(style?.paddingLeft);
  const rightInset = cssPixels(style?.borderRightWidth) + cssPixels(style?.paddingRight);
  const topInset = cssPixels(style?.borderTopWidth) + cssPixels(style?.paddingTop);
  const bottomInset = cssPixels(style?.borderBottomWidth) + cssPixels(style?.paddingBottom);
  const width = Math.max(0, borderBox.width - leftInset - rightInset);
  const height = Math.max(0, borderBox.height - topInset - bottomInset);
  const left = borderBox.left + leftInset;
  const top = borderBox.top + topInset;
  return {
    borderBox,
    contentBox: {
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
    },
  };
}

function cssPixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

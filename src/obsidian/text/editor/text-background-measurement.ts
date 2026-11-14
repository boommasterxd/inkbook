import type { EditorView } from "@codemirror/view";
import { isRgbaColor, type ColorV1 } from "../../../domain/schema/public";
import type { TextBackgroundRectangle } from "../../../domain/geometry/text-backgrounds";
import type { TextEditingMatrix } from "../../../rendering/scene/text-editing-geometry";
import {
  inlineTextHeight,
  inlineTextRectangle,
  localEditorMatrix,
} from "./text-background-coordinates";
import type { PaintRectangle } from "../../../domain/geometry/rectangle-cutouts";
import { textBackgroundRadius } from "../../../domain/geometry/rounded-background-path";

export interface TextEditorBackgroundBase {
  readonly color: ColorV1 | null;
  readonly opacity: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize?: number;
  readonly ready?: boolean;
}

interface MeasurementContext {
  readonly matrix: TextEditingMatrix;
  readonly view: EditorView;
  readonly styles: Map<Element, CSSStyleDeclaration>;
}

interface LineBand {
  top: number;
  bottom: number;
}

export function measureTextBackground(
  view: EditorView,
  base: TextEditorBackgroundBase,
  measuredStyle?: CSSStyleDeclaration,
) {
  if (base.ready === false) return undefined;
  const window = view.dom.ownerDocument.defaultView;
  if (!window) return undefined;
  const style = measuredStyle ?? window.getComputedStyle(view.dom);
  const width = Number.parseFloat(style.width) || base.width;
  const height = Number.parseFloat(style.height) || base.height;
  const foreign = view.dom.closest<SVGForeignObjectElement>("foreignObject");
  const linear = foreign?.getScreenCTM() ?? {
    a: view.scaleX,
    b: 0,
    c: 0,
    d: view.scaleY,
    e: 0,
    f: 0,
  };
  const context: MeasurementContext = {
    matrix: localEditorMatrix(view.dom.getBoundingClientRect(), linear, width, height),
    view,
    styles: new Map(),
  };
  const lines = new Map<Element, readonly LineBand[]>();
  const rectangles: TextBackgroundRectangle[] = [];
  for (const target of view.dom.querySelectorAll<HTMLElement>("[data-inkbook-text-background]")) {
    const line = target.closest(".cm-line");
    let bands = line ? lines.get(line) : undefined;
    if (line && !bands) {
      bands = measureLineBands(line, context);
      lines.set(line, bands);
    }
    const paint = targetPaint(target, base);
    for (const rectangle of measureTarget(target, context)) {
      const band = bands?.find(
        (candidate) =>
          rectangle.y < candidate.bottom && rectangle.y + rectangle.height > candidate.top,
      );
      rectangles.push({
        ...rectangle,
        ...(band ? { y: band.top, height: band.bottom - band.top } : {}),
        ...paint,
      });
    }
  }
  const box = { x: 0, y: 0, width: base.width, height: Math.max(base.height, height) };
  return {
    box,
    rectangles,
    base,
    radius: textBackgroundRadius(box, base.fontSize ?? (Number.parseFloat(style.fontSize) || 24)),
  };
}

function targetPaint(target: HTMLElement, base: TextEditorBackgroundBase) {
  const color = target.getAttribute("data-inkbook-bg-color");
  const opacity = target.getAttribute("data-inkbook-bg-opacity");
  if (color !== null && color !== "none" && color !== "theme-text" && !isRgbaColor(color))
    throw new TypeError("Invalid runtime text background color.");
  const value = opacity === null ? base.opacity : Number(opacity);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new TypeError("Invalid runtime text background opacity.");
  return {
    color:
      color === null
        ? base.color
        : color === "none"
          ? null
          : color === "theme-text"
            ? { type: "theme-text" as const }
            : { type: "rgba" as const, value: color },
    opacity: value,
  };
}

function styleOf(element: Element, context: MeasurementContext): CSSStyleDeclaration {
  let style = context.styles.get(element);
  if (!style) {
    style = element.ownerDocument.defaultView!.getComputedStyle(element);
    context.styles.set(element, style);
  }
  return style;
}

function measureTarget(target: HTMLElement, context: MeasurementContext): PaintRectangle[] {
  const walker = target.ownerDocument.createTreeWalker(target, 4);
  const first = walker.nextNode();
  let height: number | undefined;
  if (first?.nodeType === 3) {
    const range = target.ownerDocument.createRange();
    range.setStart(first, 0);
    range.collapse(true);
    height = inlineTextHeight(range.getBoundingClientRect(), context.matrix);
  } else height = Number.parseFloat(styleOf(target, context).height);
  if (height === undefined) return [];
  return Array.from(target.getClientRects(), (rect) =>
    inlineTextRectangle(rect, context.matrix, height),
  ).filter((rect): rect is PaintRectangle => rect !== undefined && rect.width > 0);
}

function measureText(node: Text, from: number, to: number, context: MeasurementContext) {
  if (from >= to) return [];
  const range = node.ownerDocument.createRange();
  range.setStart(node, from);
  range.collapse(true);
  const height = inlineTextHeight(range.getBoundingClientRect(), context.matrix);
  if (height === undefined) return [];
  range.setEnd(node, to);
  const result: PaintRectangle[] = [];
  for (const rect of range.getClientRects()) {
    const local = inlineTextRectangle(rect, context.matrix, height);
    if (local && local.width > 0) result.push(local);
  }
  return result;
}

function measureLineBands(line: Element, context: MeasurementContext): readonly LineBand[] {
  const bands: LineBand[] = [];
  const walker = line.ownerDocument.createTreeWalker(line, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    let position: number;
    try {
      position = context.view.posAtDOM(text, 0);
    } catch {
      continue;
    }
    const lineHeight = Number.parseFloat(styleOf(text.parentElement!, context).lineHeight);
    for (const visible of context.view.visibleRanges) {
      for (const rect of measureText(
        text,
        Math.max(0, visible.from - position),
        Math.min(text.length, visible.to - position),
        context,
      )) {
        const leading = Math.max(0, (lineHeight || rect.height) - rect.height) / 2;
        bands.push({ top: rect.y - leading, bottom: rect.y + rect.height + leading });
      }
    }
  }
  for (const widget of line.querySelectorAll<HTMLElement>(".inkbook-text-math-content"))
    for (const rect of measureTarget(widget, context))
      bands.push({ top: rect.y, bottom: rect.y + rect.height });
  bands.sort((left, right) => left.top - right.top);
  const merged: LineBand[] = [];
  for (const band of bands) {
    const previous = merged[merged.length - 1];
    if (previous && sameVisualLine(previous, band))
      previous.bottom = Math.max(previous.bottom, band.bottom);
    else merged.push({ ...band });
  }
  return merged;
}

function sameVisualLine(left: LineBand, right: LineBand): boolean {
  const overlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  return overlap * 2 > Math.min(left.bottom - left.top, right.bottom - right.top);
}

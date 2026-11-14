import type { EditorView } from "@codemirror/view";
import { localEditorMatrix } from "./text-background-coordinates";
import {
  inverseTextMatrix,
  textRectBounds,
  type TextClientRect,
} from "../../../rendering/scene/text-editing-geometry";
import type { TextTableRowRange } from "./text-field-editor-types";

/** Owning clip plus all inverse-transformed viewport corners conservatively retain rotated rows. */
export function visibleTextTableRows(
  view: Pick<EditorView, "scaleX" | "scaleY">,
  node: HTMLElement,
  width: number,
  offsets: readonly number[],
): TextTableRowRange {
  const visible = visibleClientRect(node);
  if (!visible || width <= 0) return { from: 0, to: 0 };
  const total = offsets[offsets.length - 1] ?? 0;
  if (visible.right <= visible.left || visible.bottom <= visible.top) return { from: 0, to: 0 };
  const foreign = node.closest<SVGForeignObjectElement>("foreignObject");
  const linear = foreign?.getScreenCTM?.() ?? {
    a: view.scaleX,
    b: 0,
    c: 0,
    d: view.scaleY,
    e: 0,
    f: 0,
  };
  const inverse = inverseTextMatrix(
    localEditorMatrix(node.getBoundingClientRect(), linear, width, total),
  );
  const bounds = inverse && textRectBounds(visible, inverse);
  if (!bounds || bounds.maxX < 0 || bounds.minX > width || bounds.maxY < 0 || bounds.minY > total)
    return { from: 0, to: 0 };
  const first = Math.max(0, upperBound(offsets, bounds.minY) - 1);
  const last = Math.min(offsets.length - 1, upperBound(offsets, bounds.maxY));
  return { from: Math.max(0, first - 2), to: Math.min(offsets.length - 1, last + 2) };
}

function visibleClientRect(node: HTMLElement): TextClientRect | undefined {
  const window = node.ownerDocument.defaultView;
  if (!window) return undefined;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const visible = {
    left,
    top,
    right: left + (viewport?.width ?? window.innerWidth),
    bottom: top + (viewport?.height ?? window.innerHeight),
  };
  const clip = node.closest<HTMLElement>(".inkbook-text-editor-viewport")?.getBoundingClientRect();
  return clip
    ? {
        left: Math.max(visible.left, clip.left),
        top: Math.max(visible.top, clip.top),
        right: Math.min(visible.right, clip.right),
        bottom: Math.min(visible.bottom, clip.bottom),
      }
    : visible;
}

function upperBound(values: readonly number[], target: number): number {
  let from = 0;
  let to = values.length;
  while (from < to) {
    const middle = (from + to) >>> 1;
    if (values[middle]! <= target) from = middle + 1;
    else to = middle;
  }
  return from;
}

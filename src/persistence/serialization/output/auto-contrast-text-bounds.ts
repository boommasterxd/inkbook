import type { Bounds } from "../../../domain/geometry/primitives";
import type { TextElementV2 } from "../../../domain/schema/public";
import {
  rotatedTextPaintBounds,
  textLayoutPaintBounds,
  textRunPaintBounds,
} from "../../../domain/geometry/text-paint-bounds";
import { textTableGridRectangles } from "../../../domain/geometry/text-table-grid-rectangles";

export class UnpreparedAutoTextError extends Error {
  public constructor() {
    super("Automatic text contrast requires prepared glyph ink bounds.");
    this.name = "UnpreparedAutoTextError";
  }
}

export function* autoTextRunBounds(element: TextElementV2): Generator<Bounds> {
  for (const line of element.layout.lines)
    for (const run of line.runs) {
      if (
        run.text.length > 0 &&
        (run.style?.color ?? element.style.color).type === "theme-text" &&
        run.inkBounds === undefined
      )
        throw new UnpreparedAutoTextError();
      yield rotatedTextPaintBounds(element, textRunPaintBounds(element, line, run));
    }
}

/** Follows precisely the serializer's painted-grid then math-path order. */
export function* autoTrailingTextPathBounds(element: TextElementV2): Generator<Bounds> {
  for (const table of element.layout.tables ?? []) {
    const rectangles = textTableGridRectangles(table);
    const painted = !rectangles.next().done;
    rectangles.return(undefined);
    if (painted) yield rotatedTextPaintBounds(element, textLayoutPaintBounds(element, table));
  }
  for (const math of element.layout.math ?? []) {
    const bounds = rotatedTextPaintBounds(element, textLayoutPaintBounds(element, math));
    for (let index = 0; index < math.paths.length; index += 1) yield bounds;
  }
}

export function nextAutoPaintBounds(iterator: Iterator<Bounds> | undefined, fallback: Bounds) {
  const step = iterator?.next();
  return step !== undefined && !step.done ? step.value : fallback;
}

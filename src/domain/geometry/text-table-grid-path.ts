import type { TextTableLayoutV2 } from "../schema/types";
import { rectangleBackgroundPath } from "./rounded-background-path";
import { textTableGridRectangles } from "./text-table-grid-rectangles";

/** One nonzero field-local fill; callers own element translation, rotation and admission. */
export function* textTableGridPathSteps(table: TextTableLayoutV2): Generator<void, string> {
  const strips: string[] = [];
  let index = 0;
  for (const rectangle of textTableGridRectangles(table)) {
    strips.push(rectangleBackgroundPath(rectangle));
    // Preserve the serializer's existing admission points after its four outer edges.
    if (index++ >= 4) yield;
  }
  return strips.join("");
}

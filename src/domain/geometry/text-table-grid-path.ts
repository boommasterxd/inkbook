import type { TextTableLayoutV2 } from "../schema/types";
import { canonicalizeGeometryNumber as number } from "../schema/canonical";
import { rectangleBackgroundPath } from "./rounded-background-path";

/** One nonzero field-local fill; callers own element translation, rotation and admission. */
export function* textTableGridPathSteps(table: TextTableLayoutV2): Generator<void, string> {
  const { x, y, width, height, borderWidth: border } = table;
  if (border <= 0 || width <= 0 || height <= 0) return "";
  const strips = [
    rectangleBackgroundPath({ x, y, width, height: border }),
    rectangleBackgroundPath({ x, y: number(y + height - border), width, height: border }),
    rectangleBackgroundPath({ x, y, width: border, height }),
    rectangleBackgroundPath({ x: number(x + width - border), y, width: border, height }),
  ];
  for (let column = 1; column < table.columns; column += 1) {
    strips.push(
      rectangleBackgroundPath({
        x: number(x + (width * column) / table.columns - border / 2),
        y,
        width: border,
        height,
      }),
    );
    yield;
  }
  let rowY = y;
  for (let row = 0; row < table.rowHeights.length - 1; row += 1) {
    rowY += table.rowHeights[row]!;
    strips.push(
      rectangleBackgroundPath({ x, y: number(rowY - border / 2), width, height: border }),
    );
    yield;
  }
  return strips.join("");
}

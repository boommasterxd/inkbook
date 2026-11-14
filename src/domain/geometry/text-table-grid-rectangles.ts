import type { TextTableLayoutV2 } from "../schema/types";
import { canonicalizeGeometryNumber as number } from "../schema/canonical";
import type { PaintRectangle } from "./rectangle-cutouts";

/** The shared filled strips used by table rendering and visible-content queries. */
export function* textTableGridRectangles(table: TextTableLayoutV2): Generator<PaintRectangle> {
  const { x, y, width, height, borderWidth: border } = table;
  if (border <= 0 || width <= 0 || height <= 0) return;
  yield { x, y, width, height: border };
  yield { x, y: number(y + height - border), width, height: border };
  yield { x, y, width: border, height };
  yield { x: number(x + width - border), y, width: border, height };
  for (let column = 1; column < table.columns; column += 1)
    yield {
      x: number(x + (width * column) / table.columns - border / 2),
      y,
      width: border,
      height,
    };
  let rowY = y;
  for (let row = 0; row < table.rowHeights.length - 1; row += 1) {
    rowY += table.rowHeights[row]!;
    yield { x, y: number(rowY - border / 2), width, height: border };
  }
}

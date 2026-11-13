import { canonicalizeGeometryNumber as canonical } from "../../domain/schema/canonical";
import { normalizeMathPath } from "./math-path-normalizer";
import { admitTextLayout, type ResolvedTextMath, type TextLayoutPorts } from "./text-layout-types";

/** Operator linebreaking runs first; indivisible matrices/glyph groups retain their aspect ratio. */
export async function fitTextMathGeometry(
  value: ResolvedTextMath,
  availableWidth: number | undefined,
  admission: Pick<TextLayoutPorts, "scheduler" | "signal">,
): Promise<ResolvedTextMath> {
  if (availableWidth === undefined || value.width <= availableWidth || value.width === 0)
    return value;
  const width = Math.max(0, availableWidth);
  const scale = width / value.width;
  const paths: ResolvedTextMath["paths"] = [];
  for (const path of value.paths) {
    await admitTextLayout(admission);
    const fillRule = path.fillRule;
    paths.push({
      d: normalizeMathPath(path.d, [scale, 0, 0, scale, 0, 0]),
      ...(fillRule ? { fillRule } : {}),
    });
  }
  const height = canonical(value.height * scale);
  const ascent = canonical(value.ascent * scale);
  return { width: canonical(width), height, ascent, descent: canonical(height - ascent), paths };
}

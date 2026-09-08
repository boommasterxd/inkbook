import type { ColorV1, StrokeStyleV1 } from "../schema/types";
import { roundCanonical } from "./primitives";

/** Applies color alpha once to the stroke group, keeping overlapping paths opaque. */
export function normalizeStrokePaint(style: StrokeStyleV1): { color: ColorV1; opacity: number } {
  const color = style.color;
  const alpha = color.type === "rgba" ? Number.parseInt(color.value.slice(7, 9), 16) / 255 : 1;
  const opacity = style.opacity * alpha;
  return {
    color: color.type === "rgba" ? { ...color, value: `#${color.value.slice(1, 7)}FF` } : color,
    opacity: style.pressureEnabled ? roundCanonical(opacity, 4) : opacity,
  };
}

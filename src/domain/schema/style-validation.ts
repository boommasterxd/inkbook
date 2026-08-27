import type { ColorV1, OutlineStyleV1, ShapeStyleV1, StrokeStyleV1 } from "./types";
import {
  assertBoolean,
  assertExactKeys,
  assertJsonTree,
  assertLiteral,
  assertOneOf,
  assertRecord,
  assertRgba,
  assertUnitInterval,
  fail,
} from "./validation-internals";

const STROKE_WIDTHS = [2, 4, 8, 14, 22] as const;
const OUTLINE_WIDTHS = [1, 2, 4, 8, 12] as const;
const OUTLINE_STYLES = ["solid", "dashed", "dotted"] as const;

export function isColorV1(value: unknown): value is ColorV1 {
  try {
    assertJsonTree(value, 8);
    assertColor(value, "$");
    return true;
  } catch {
    return false;
  }
}

function assertColor(value: unknown, path: string): asserts value is ColorV1 {
  assertRecord(value, path);
  if (value.type === "theme-text") {
    assertExactKeys(value, ["type"], path);
    return;
  }
  if (value.type === "rgba") {
    assertExactKeys(value, ["type", "value"], path);
    assertRgba(value.value, `${path}.value`);
    return;
  }
  fail("invalid-literal", `${path}.type`, "Unsupported color type.");
}

export function assertStrokeStyle(value: unknown, path: string): asserts value is StrokeStyleV1 {
  assertRecord(value, path);
  assertExactKeys(value, ["color", "width", "opacity", "pressureEnabled", "smoothing"], path);
  assertColor(value.color, `${path}.color`);
  assertOneOf(value.width, STROKE_WIDTHS, `${path}.width`);
  assertUnitInterval(value.opacity, `${path}.opacity`);
  assertBoolean(value.pressureEnabled, `${path}.pressureEnabled`);
  assertLiteral(value.smoothing, 0.5, `${path}.smoothing`);
}

export function assertOutlineStyle(value: unknown, path: string): asserts value is OutlineStyleV1 {
  assertRecord(value, path);
  assertExactKeys(value, ["outlineColor", "outlineWidth", "outlineOpacity", "outlineStyle"], path);
  assertColor(value.outlineColor, `${path}.outlineColor`);
  assertOneOf(value.outlineWidth, OUTLINE_WIDTHS, `${path}.outlineWidth`);
  assertUnitInterval(value.outlineOpacity, `${path}.outlineOpacity`);
  assertOneOf(value.outlineStyle, OUTLINE_STYLES, `${path}.outlineStyle`);
}

export function assertShapeStyle(value: unknown, path: string): asserts value is ShapeStyleV1 {
  assertRecord(value, path);
  assertExactKeys(
    value,
    ["outlineColor", "outlineWidth", "outlineOpacity", "outlineStyle", "fillColor", "fillOpacity"],
    path,
  );
  assertColor(value.outlineColor, `${path}.outlineColor`);
  assertOneOf(value.outlineWidth, OUTLINE_WIDTHS, `${path}.outlineWidth`);
  assertUnitInterval(value.outlineOpacity, `${path}.outlineOpacity`);
  assertOneOf(value.outlineStyle, OUTLINE_STYLES, `${path}.outlineStyle`);
  if (value.fillColor !== null) assertColor(value.fillColor, `${path}.fillColor`);
  assertUnitInterval(value.fillOpacity, `${path}.fillOpacity`);
}

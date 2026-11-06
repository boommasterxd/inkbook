import { linearPivot } from "../../domain/geometry/public";
import type { RecognizedShape } from "../../domain/recognition/stroke-recognition";
import { validateInkElementV1, type InkElementV1 } from "../../domain/schema/public";
import type { ToolDefaultsV1 } from "../../domain/settings/types";
import { createDragElement } from "./creation";

interface RecognizedCreation {
  readonly identity: { readonly id: string; readonly createdAt: number };
  readonly defaults: ToolDefaultsV1;
  readonly recognition: RecognizedShape;
}

/** Native creation owns structure and pattern; recognition preserves the drawing pen's paint. */
export function createRecognizedElement(creation: RecognizedCreation): InkElementV1 {
  const shape = creation.recognition;
  const start = "start" in shape ? shape.start : { x: shape.x, y: shape.y };
  const end = "end" in shape ? shape.end : { x: shape.x + shape.width, y: shape.y + shape.height };
  const base = createDragElement({
    identity: creation.identity,
    defaults: creation.defaults,
    tool: shape.kind,
    start,
    end,
  });
  const geometry =
    "start" in shape
      ? {
          ...shape,
          pivot: linearPivot(shape.start, shape.end, shape.bend),
        }
      : shape;
  const pen = creation.defaults.pen;
  const style = {
    ...base.style,
    outlineColor: structuredClone(pen.color),
    outlineWidth: pen.width,
    outlineOpacity: pen.opacity,
    ...("fillColor" in base.style ? { fillColor: null } : {}),
  };
  const result = validateInkElementV1({ ...base, ...geometry, style });
  if (!result.ok) throw new RangeError(`${result.error.path}: ${result.error.message}`);
  return result.value;
}

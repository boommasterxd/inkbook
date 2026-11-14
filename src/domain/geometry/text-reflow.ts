import type { TextElementV2 } from "../schema/types";
import { canonicalPoint, rotatePointClockwise } from "./primitives";

/** Layout coordinates stay field-local while the visible field origin stays fixed. */
export function preserveTextReflowOrigin(
  source: TextElementV2,
  prepared: TextElementV2,
): TextElementV2 {
  const origin = rotatePointClockwise(source, source.pivot, source.rotation);
  const offset = rotatePointClockwise(
    { x: -prepared.width / 2, y: -prepared.height / 2 },
    { x: 0, y: 0 },
    source.rotation,
  );
  const position = canonicalPoint({
    x: origin.x - offset.x - prepared.width / 2,
    y: origin.y - offset.y - prepared.height / 2,
  });
  return {
    ...prepared,
    ...position,
    rotation: source.rotation,
    pivot: canonicalPoint({
      x: position.x + prepared.width / 2,
      y: position.y + prepared.height / 2,
    }),
  };
}

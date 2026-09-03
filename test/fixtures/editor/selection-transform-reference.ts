import type { InkElementV1, PointV1 } from "../../../src/domain/schema/public";
import {
  minimumUniformScaleForSelection,
  scaleElement,
} from "../../../src/editor/selection/transforms";

export function scaleSelectionUniformForTest(
  elements: readonly InkElementV1[],
  anchor: PointV1,
  factor: number,
): InkElementV1[] {
  const clamped = Math.max(factor, minimumUniformScaleForSelection(elements));
  return elements.map((element) => scaleElement(element, anchor, { x: clamped, y: clamped }));
}

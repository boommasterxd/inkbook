import type { ArrowNodeV1, BoxShapeElementV1, PointV1 } from "../schema/types";

export interface RecognizedLinear {
  kind: "line" | "arrow";
  start: PointV1;
  end: PointV1;
  bend: PointV1 | null;
  startNode: ArrowNodeV1;
  endNode: ArrowNodeV1;
  rotation: 0;
  pivot: PointV1;
}

export type RecognizedClosedShape = Pick<
  BoxShapeElementV1,
  "kind" | "x" | "y" | "width" | "height" | "pivot" | "rotation"
>;

export type RecognizedShape = RecognizedClosedShape | RecognizedLinear;

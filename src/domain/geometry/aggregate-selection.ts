import type { NotePointV1 } from "../model";
import type { GroupRecordV1 } from "../scene";
import type { GeometryResultV1 } from "./projection";
import { geometryFailureV1, geometrySuccessV1 } from "./projection";
import {
  createAreaHandlesV1,
  createOrientedFrameV1,
  frameCornersV1,
  rotateHandlePointV1,
} from "./selection-frames";
import type {
  AggregateSelectionModelV1,
  ElementSelectionModelV1,
} from "./selection-types";

export type AggregateSelectionInputV1 =
  | {
      readonly kind: "group";
      readonly group: GroupRecordV1;
      readonly members: readonly ElementSelectionModelV1[];
    }
  | {
      readonly kind: "multi-selection";
      readonly members: readonly ElementSelectionModelV1[];
    };

function modelControlPoints(
  model: ElementSelectionModelV1,
): readonly NotePointV1[] {
  switch (model.kind) {
    case "linear":
      return [
        model.endpoints[0].point,
        model.endpoints[1].point,
        model.curveHandle,
      ];
    case "area":
      return frameCornersV1(model.frame);
    case "axis-set":
      return model.axes.flatMap((axis) => [axis.start, axis.end]);
  }
}

export function deriveAggregateSelectionModelV1(
  input: AggregateSelectionInputV1,
): GeometryResultV1<AggregateSelectionModelV1> {
  const points = input.members.flatMap(modelControlPoints);
  const rotationRadians =
    input.kind === "group" ? input.group.selectionRotationRadians : 0;
  const frame = createOrientedFrameV1(points, rotationRadians);
  if (frame === null) {
    return geometryFailureV1("selection-empty");
  }
  const geometryTransformAllowed = input.members.every(
    (member) => member.geometryTransformAllowed,
  );
  return geometrySuccessV1(
    Object.freeze({
      kind: "aggregate",
      frame,
      resizeHandles: geometryTransformAllowed
        ? createAreaHandlesV1(frame, { x: false, y: false })
        : Object.freeze([]),
      rotateHandle: geometryTransformAllowed
        ? rotateHandlePointV1(frame)
        : null,
      anchorHandle: frame.center,
      geometryTransformAllowed,
      persistedOrientation: input.kind === "group",
    }),
  );
}

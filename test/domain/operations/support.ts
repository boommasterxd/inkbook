import type {
  ElementId,
  FixedBinding,
  LineElementV1,
  PenElementV1,
  SceneElementV1,
  SceneElementValueV1,
  ShapeElementV1,
} from "../../../src/domain/model";
import {
  createBindingRevision,
  createGeometryRevision,
  createSceneRevision,
  createStyleRevision,
  parseElementId,
  parseHexRgbaV1,
} from "../../../src/domain/model";
import {
  createRuntimeSceneStateV1,
  type RuntimeSceneStateV1,
} from "../../../src/domain/scene";
import type {
  AnnotationOperationV1,
  AnnotationPatchV1,
} from "../../../src/domain/operations";
import {
  createHistoryEpoch,
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";

const ID_PAYLOAD_LENGTH = 26;
const ID_RADIX = 16;
const ID_WIDTH = 8;
const STROKE_BYTES_PER_POINT = 4;

export const NOTE_APPEARANCE = Object.freeze({
  background: "none" as const,
  horizontalSpacing: "standard" as const,
  contrast: "medium" as const,
});

export function fixedBinding(anchor: number): FixedBinding {
  return {
    kind: "fixed",
    anchorX: anchor,
    anchorY: anchor,
    origin: "manual",
    confidence: "high",
    inferenceProfileVersion: 1,
  };
}

export function elementIdFor(index: number): ElementId {
  const suffix = index.toString(ID_RADIX).padStart(ID_WIDTH, "0");
  return parseElementId(
    `el_${"0".repeat(ID_PAYLOAD_LENGTH - suffix.length)}${suffix}`,
  );
}

export function rectangle(index: number, revision = 0): ShapeElementV1 {
  return {
    elementId: elementIdFor(index),
    geometryRevision: createGeometryRevision(revision),
    styleRevision: createStyleRevision(revision),
    bindingRevision: createBindingRevision(revision),
    binding: fixedBinding(index),
    kind: "rectangle",
    geometry: {
      center: { x: index, y: index },
      width: 1,
      height: 1,
      rotationRadians: 0,
    },
    style: {
      color: parseHexRgbaV1("#123456ff"),
      opacity: 1,
      width: 1,
      dash: "solid",
      fill: { kind: "none" },
    },
  };
}

export function line(
  index: number,
  targetElementId: ElementId | null,
  revision = 0,
): LineElementV1 {
  return {
    elementId: elementIdFor(index),
    geometryRevision: createGeometryRevision(revision),
    styleRevision: createStyleRevision(revision),
    bindingRevision: createBindingRevision(revision),
    binding: fixedBinding(0),
    kind: "arrow",
    geometry: {
      start: {
        fallbackPoint: { x: 0, y: 0 },
        attachment:
          targetElementId === null
            ? null
            : { targetElementId, portId: "area:east" },
      },
      end: { fallbackPoint: { x: 10, y: 10 }, attachment: null },
      control: null,
    },
    style: {
      color: "currentColor",
      opacity: 1,
      width: 1,
      dash: "solid",
      startCap: "none",
      endCap: "arrow",
      capSize: 4,
    },
  };
}

export function pen(
  index: number,
  pointCount: number,
  selectionRotationRadians = 0,
  revision = 0,
): PenElementV1 {
  return {
    elementId: elementIdFor(index),
    geometryRevision: createGeometryRevision(revision),
    styleRevision: createStyleRevision(revision),
    bindingRevision: createBindingRevision(revision),
    binding: fixedBinding(0),
    kind: "pen",
    geometry: {
      stroke: {
        codec: "delta-varint-v1",
        pointCount,
        originXQ: 0,
        originYQ: 0,
        pressure: "absent",
        data: "A".repeat((pointCount - 1) * STROKE_BYTES_PER_POINT),
      },
      selectionRotationRadians,
    },
    style: {
      color: parseHexRgbaV1("#123456ff"),
      opacity: 1,
      width: 1,
      dash: "solid",
      pressure: "constant",
      smoothing: 0,
      streamline: 0,
      thinning: 0,
      strokeProfileVersion: 1,
    },
  };
}

export function valueOf(element: SceneElementV1): SceneElementValueV1 {
  const { bindingRevision, geometryRevision, styleRevision, ...value } =
    element;
  if (bindingRevision < 0 || geometryRevision < 0 || styleRevision < 0) {
    throw new Error("Invalid fixture revision");
  }
  return value;
}

export function scene(
  elements: readonly SceneElementV1[],
): RuntimeSceneStateV1 {
  return createRuntimeSceneStateV1({
    revision: createSceneRevision(0),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups: [],
    noteAppearance: NOTE_APPEARANCE,
  });
}

export function operation(
  patch: AnnotationPatchV1,
  expectedRevision = 0,
  operationSuffix = "0",
): AnnotationOperationV1 {
  return {
    operationId: parseOperationId(
      `op_${operationSuffix.repeat(ID_PAYLOAD_LENGTH)}`,
    ),
    historyEntryId: parseHistoryEntryId(`he_${"0".repeat(ID_PAYLOAD_LENGTH)}`),
    direction: "forward",
    expectedSceneRevision: createSceneRevision(expectedRevision),
    historyEpoch: createHistoryEpoch(1),
    patch,
  };
}

import type {
  ElementId,
  FixedBinding,
  ShapeElementV1,
  ShapeStyleV1,
} from "../../../src/domain/model";
import {
  createBindingRevision,
  createGeometryRevision,
  createNotePointV1,
  createStyleRevision,
  parseElementId,
  parseHexRgbaV1,
} from "../../../src/domain/model";

const ID_PAYLOAD_LENGTH = 26;
const HEX_RADIX = 16;
const ID_HEX_WIDTH = 8;

export const FIXED_BINDING: FixedBinding = Object.freeze({
  kind: "fixed",
  anchorX: 0,
  anchorY: 0,
  origin: "manual",
  confidence: "high",
  inferenceProfileVersion: 1,
});

const SHAPE_STYLE: ShapeStyleV1 = Object.freeze({
  color: parseHexRgbaV1("#123456ff"),
  opacity: 1,
  width: 1,
  dash: "solid",
  fill: Object.freeze({ kind: "none" }),
});

export function elementIdFor(index: number): ElementId {
  const suffix = index.toString(HEX_RADIX).padStart(ID_HEX_WIDTH, "0");
  return parseElementId(
    `el_${"0".repeat(ID_PAYLOAD_LENGTH - suffix.length)}${suffix}`,
  );
}

export function rectangleElement(index: number): ShapeElementV1 {
  const revision = index + 1;
  return {
    elementId: elementIdFor(index),
    geometryRevision: createGeometryRevision(revision),
    styleRevision: createStyleRevision(revision),
    bindingRevision: createBindingRevision(revision),
    binding: FIXED_BINDING,
    kind: "rectangle",
    geometry: {
      center: createNotePointV1(index, index),
      width: 1,
      height: 1,
      rotationRadians: 0,
    },
    style: SHAPE_STYLE,
  };
}

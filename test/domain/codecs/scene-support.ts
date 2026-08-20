import type {
  AreaGeometryV1,
  ConstructionStyleV1,
  ElementBinding,
  ElementCommonV1,
  LinearStyleV1,
  SceneElementV1,
  ShapeStyleV1,
} from "../../../src/domain/model";
import {
  createBindingRevision,
  createGeometryRevision,
  createSceneRevision,
  createStyleRevision,
  parseBlockFingerprintV1,
  parseGroupId,
  parseHexRgbaV1,
} from "../../../src/domain/model";
/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact schema fixture indices and boundary values are intentional. */
import type {
  GroupRecordV1,
  SerializedSceneStateV1,
} from "../../../src/domain/scene";
import { elementIdFor } from "../model/support";

const GROUP_ID_PAYLOAD_LENGTH = 26;
const FINGERPRINT = parseBlockFingerprintV1("0".repeat(64));
const AXES_ORIGIN = Object.freeze({ x: 0, y: 0 });
const X_AXIS = Object.freeze({ x: 1, y: 0 });
const Y_AXIS = Object.freeze({ x: 0, y: 1 });

export const FIXED_BINDING: ElementBinding = Object.freeze({
  kind: "fixed",
  anchorX: 0,
  anchorY: 0,
  origin: "inferred",
  confidence: "low",
  inferenceProfileVersion: 1,
});

export const POSITION_BINDING: ElementBinding = Object.freeze({
  kind: "text-position",
  anchor: Object.freeze({
    utf16Offset: 2,
    association: "after",
    blockKind: "paragraph",
    contextBefore: "a",
    contextAfter: "b",
    blockFingerprint: FINGERPRINT,
  }),
  localOffsetX: 1,
  localOffsetY: -1,
  origin: "inferred",
  confidence: "medium",
  inferenceProfileVersion: 1,
});

export const RANGE_BINDING: ElementBinding = Object.freeze({
  kind: "text-range",
  start: Object.freeze({
    utf16Offset: 2,
    association: "after",
    blockKind: "heading",
    contextBefore: "a",
    contextAfter: "b",
    blockFingerprint: FINGERPRINT,
  }),
  end: Object.freeze({
    utf16Offset: 4,
    association: "before",
    blockKind: "heading",
    contextBefore: "c",
    contextAfter: "d",
    blockFingerprint: FINGERPRINT,
  }),
  presentation: "enclosure",
  marginsInLineHeights: Object.freeze({
    top: -1,
    right: 1,
    bottom: 0,
    left: 0,
  }),
  origin: "manual",
  confidence: "high",
  inferenceProfileVersion: 1,
});

const STROKE = Object.freeze({
  codec: "delta-varint-v1" as const,
  pointCount: 1,
  originXQ: 0,
  originYQ: 0,
  pressure: "absent" as const,
  data: "",
});

const STROKE_PAINT = Object.freeze({
  color: parseHexRgbaV1("#123456ff"),
  opacity: 0.58,
  width: 1,
  dash: "solid" as const,
});

function revisions(index: number): {
  readonly geometryRevision: ReturnType<typeof createGeometryRevision>;
  readonly styleRevision: ReturnType<typeof createStyleRevision>;
  readonly bindingRevision: ReturnType<typeof createBindingRevision>;
} {
  const revision = index + 1;
  return {
    geometryRevision: createGeometryRevision(revision),
    styleRevision: createStyleRevision(revision),
    bindingRevision: createBindingRevision(revision),
  };
}

export function groupIdFor(index: number): ReturnType<typeof parseGroupId> {
  const suffix = String(index);
  return parseGroupId(
    `grp_${"0".repeat(GROUP_ID_PAYLOAD_LENGTH - suffix.length)}${suffix}`,
  );
}

function common(
  index: number,
  binding: ElementBinding = FIXED_BINDING,
): ElementCommonV1 {
  return { elementId: elementIdFor(index), ...revisions(index), binding };
}

function sharedRecords(): {
  readonly shapeStyle: ShapeStyleV1;
  readonly area: AreaGeometryV1;
  readonly linearStyle: LinearStyleV1;
  readonly constructionStyle: ConstructionStyleV1;
} {
  const shapeStyle = { ...STROKE_PAINT, fill: { kind: "none" as const } };
  const area = {
    center: { x: 0, y: 0 },
    width: 2,
    height: 2,
    rotationRadians: 0,
  };
  const linearStyle = {
    ...STROKE_PAINT,
    startCap: "none" as const,
    endCap: "arrow" as const,
    capSize: 2,
  };
  const constructionStyle = {
    ...STROKE_PAINT,
    positiveEndCap: "arrow" as const,
    capSize: 2,
  };
  return { shapeStyle, area, linearStyle, constructionStyle };
}

function strokeElements(): readonly SceneElementV1[] {
  return [
    {
      ...common(0, POSITION_BINDING),
      kind: "pen",
      geometry: { stroke: STROKE, selectionRotationRadians: 0 },
      style: {
        ...STROKE_PAINT,
        pressure: "constant",
        smoothing: 0.29,
        streamline: 0.58,
        thinning: 0,
        strokeProfileVersion: 1,
      },
    },
    {
      ...common(1, RANGE_BINDING),
      kind: "highlighter",
      geometry: { stroke: STROKE, selectionRotationRadians: 0 },
      style: { ...STROKE_PAINT, variant: "straight" },
    },
  ];
}

function shapeElements(
  area: AreaGeometryV1,
  shapeStyle: ShapeStyleV1,
): SceneElementV1[] {
  const shapes = [
    "rectangle",
    "ellipse",
    "triangle",
    "diamond",
    "octagon",
  ] as const;
  return shapes.map((kind, offset) => ({
    ...common(offset + 2),
    kind,
    geometry: area,
    style: shapeStyle,
  }));
}

function constructionElements(
  area: AreaGeometryV1,
  linearStyle: LinearStyleV1,
  constructionStyle: ConstructionStyleV1,
): readonly SceneElementV1[] {
  return [
    {
      ...common(7),
      kind: "line",
      geometry: {
        start: { fallbackPoint: { x: 0, y: 0 }, attachment: null },
        end: { fallbackPoint: { x: 1, y: 1 }, attachment: null },
        control: null,
      },
      style: linearStyle,
    },
    {
      ...common(8),
      kind: "arrow",
      geometry: {
        start: {
          fallbackPoint: { x: 0, y: 0 },
          attachment: { targetElementId: elementIdFor(2), portId: "area:east" },
        },
        end: { fallbackPoint: { x: 1, y: 1 }, attachment: null },
        control: { x: 0.5, y: 0.5 },
      },
      style: linearStyle,
    },
    {
      ...common(9),
      kind: "table",
      geometry: {
        ...area,
        rowDividerOffsets: [0],
        columnDividerOffsets: [0],
      },
      style: constructionStyle,
    },
    {
      ...common(10),
      kind: "axes-2d",
      geometry: {
        origin: AXES_ORIGIN,
        xAxis: X_AXIS,
        yAxis: Y_AXIS,
        gridDivisions: 64,
      },
      style: constructionStyle,
    },
    {
      ...common(11),
      kind: "axes-3d",
      geometry: {
        origin: AXES_ORIGIN,
        xAxis: X_AXIS,
        yAxis: Y_AXIS,
        zAxis: { x: 1, y: 1 },
        gridDivisions: 0,
      },
      style: constructionStyle,
    },
  ];
}

export function everyElementKind(): readonly SceneElementV1[] {
  const records = sharedRecords();
  return [
    ...strokeElements(),
    ...shapeElements(records.area, records.shapeStyle),
    ...constructionElements(
      records.area,
      records.linearStyle,
      records.constructionStyle,
    ),
  ];
}

export function completeScene(): SerializedSceneStateV1 {
  const elements = everyElementKind();
  const groups: readonly GroupRecordV1[] = [
    {
      groupId: groupIdFor(0),
      childIds: [groupIdFor(1), elementIdFor(2)],
      selectionRotationRadians: 0,
    },
    {
      groupId: groupIdFor(1),
      childIds: [elementIdFor(0), elementIdFor(1)],
      selectionRotationRadians: 0,
    },
  ];
  return {
    revision: createSceneRevision(elements.length),
    elements,
    objectOrder: elements.map(({ elementId }) => elementId),
    groups,
    noteAppearance: {
      background: "dotted",
      horizontalSpacing: "standard",
      contrast: "medium",
    },
  };
}

/* eslint-disable @typescript-eslint/no-magic-numbers -- Compact canonical geometry fixtures. */

import type {
  AreaGeometryV1,
  Axes2DElementV1,
  Axes3DElementV1,
  ElementBinding,
  LineElementV1,
  NotePointV1,
  ObjectPortAttachmentV1,
  PenElementV1,
  SceneElementV1,
  ShapeElementV1,
  TableElementV1,
} from "../../../src/domain/model";
import type { GeometryProjectionV1 } from "../../../src/domain/geometry";
import {
  createBindingRevision,
  createGeometryRevision,
  createStyleRevision,
  parseBlockFingerprintV1,
  parseElementId,
} from "../../../src/domain/model";

export const FIXED_BINDING: ElementBinding = {
  kind: "fixed",
  anchorX: 0,
  anchorY: 0,
  origin: "manual",
  confidence: "high",
  inferenceProfileVersion: 1,
};

export const RANGE_BINDING: ElementBinding = {
  kind: "text-range",
  presentation: "enclosure",
  start: {
    utf16Offset: 0,
    association: "after",
    blockKind: "paragraph",
    contextBefore: "",
    contextAfter: "a",
    blockFingerprint: parseBlockFingerprintV1("0".repeat(64)),
  },
  end: {
    utf16Offset: 1,
    association: "before",
    blockKind: "paragraph",
    contextBefore: "a",
    contextAfter: "",
    blockFingerprint: parseBlockFingerprintV1("0".repeat(64)),
  },
  marginsInLineHeights: { top: 0, right: 0, bottom: 0, left: 0 },
  origin: "manual",
  confidence: "high",
  inferenceProfileVersion: 1,
};

const shapeStyle = {
  color: "currentColor" as const,
  opacity: 1,
  width: 1,
  dash: "solid" as const,
  fill: { kind: "none" as const },
};
const constructionStyle = {
  color: "currentColor" as const,
  opacity: 1,
  width: 1,
  dash: "solid" as const,
  positiveEndCap: "arrow" as const,
  capSize: 4,
};
const commonRevisions = {
  geometryRevision: createGeometryRevision(0),
  styleRevision: createStyleRevision(0),
  bindingRevision: createBindingRevision(0),
};

export function elementId(suffix: string): ReturnType<typeof parseElementId> {
  return parseElementId(`el_${"0".repeat(25)}${suffix}`);
}

export function shapeElement(
  kind: ShapeElementV1["kind"],
  suffix: string,
  geometry: AreaGeometryV1,
  binding: ElementBinding = FIXED_BINDING,
): ShapeElementV1 {
  return {
    ...commonRevisions,
    elementId: elementId(suffix),
    kind,
    geometry,
    style: shapeStyle,
    binding,
  };
}

export function tableElement(
  suffix: string,
  binding: ElementBinding = FIXED_BINDING,
): TableElementV1 {
  return {
    ...commonRevisions,
    elementId: elementId(suffix),
    kind: "table",
    geometry: {
      center: { x: 10, y: 20 },
      width: 12,
      height: 8,
      rotationRadians: 0,
      rowDividerOffsets: [-2, 1],
      columnDividerOffsets: [-3, 2],
    },
    style: constructionStyle,
    binding,
  };
}

export function axesElement(
  dimensions: "2d" | "3d",
  suffix: string,
): Axes2DElementV1 | Axes3DElementV1 {
  const common = {
    ...commonRevisions,
    elementId: elementId(suffix),
    style: constructionStyle,
    binding: FIXED_BINDING,
  };
  return dimensions === "2d"
    ? {
        ...common,
        kind: "axes-2d",
        geometry: {
          origin: { x: 5, y: 7 },
          xAxis: { x: 4, y: 0 },
          yAxis: { x: 0, y: -3 },
          gridDivisions: 1,
        },
      }
    : {
        ...common,
        kind: "axes-3d",
        geometry: {
          origin: { x: 5, y: 7 },
          xAxis: { x: 4, y: 0 },
          yAxis: { x: 0, y: -3 },
          zAxis: { x: -2, y: 2 },
          gridDivisions: 1,
        },
      };
}

export function lineElement(
  suffix: string,
  attachments: readonly [
    ObjectPortAttachmentV1 | null,
    ObjectPortAttachmentV1 | null,
  ] = [null, null],
  control: NotePointV1 | null = null,
  binding: ElementBinding = FIXED_BINDING,
): LineElementV1 {
  return {
    ...commonRevisions,
    elementId: elementId(suffix),
    kind: "line",
    geometry: {
      start: { fallbackPoint: { x: 0, y: 0 }, attachment: attachments[0] },
      end: { fallbackPoint: { x: 8, y: 4 }, attachment: attachments[1] },
      control,
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
    binding,
  };
}

export function penElement(
  suffix: string,
  rotationRadians: number,
  binding: ElementBinding = FIXED_BINDING,
): PenElementV1 {
  return {
    ...commonRevisions,
    elementId: elementId(suffix),
    kind: "pen",
    geometry: {
      stroke: {
        codec: "delta-varint-v1",
        pointCount: 2,
        originXQ: 0,
        originYQ: 0,
        pressure: "absent",
        data: "",
      },
      selectionRotationRadians: rotationRadians,
    },
    style: {
      color: "currentColor",
      opacity: 1,
      width: 2,
      dash: "solid",
      pressure: "constant",
      smoothing: 0,
      streamline: 0,
      thinning: 0,
      strokeProfileVersion: 1,
    },
    binding,
  };
}

export const identityProjection: GeometryProjectionV1 = {
  token: { availability: "current", invertible: true },
  projectPoint: (_element, point) => ({ ...point }),
  projectArea: (_element, area) => ({ ...area, center: { ...area.center } }),
  projectStroke: (_element, points) => points.map((point) => ({ ...point })),
};

export function translatedProjection(
  x: number,
  y: number,
): GeometryProjectionV1 {
  return {
    ...identityProjection,
    projectPoint: (_element, point) => ({ x: point.x + x, y: point.y + y }),
    projectArea: (_element, area) => ({
      ...area,
      center: { x: area.center.x + x, y: area.center.y + y },
    }),
    projectStroke: (_element, points) =>
      points.map((point) => ({ x: point.x + x, y: point.y + y })),
  };
}

export function elementLookup(
  elements: readonly SceneElementV1[],
): (id: SceneElementV1["elementId"]) => SceneElementV1 | undefined {
  return (id) => elements.find((element) => element.elementId === id);
}

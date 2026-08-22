import type { BoxShapeElementV1, InkSnapshotV1 } from "../../../../../src/domain/schema/public";

const ELEMENT_ID = "00000000-0000-4000-8000-000000000001";

export function rectangle(x = 100): BoxShapeElementV1 {
  return {
    createdAt: 1,
    height: 80,
    id: ELEMENT_ID,
    kind: "rectangle",
    pivot: { x: x + 50, y: 140 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 100,
    x,
    y: 100,
  };
}

export function snapshot(revision = 0, x = 100): InkSnapshotV1 {
  return {
    elements: [rectangle(x)],
    format: "inkbook",
    page: {
      activeBufferLines: 3,
      background: { spacing: 50, type: "lines" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
      writingLineHeight: 100,
    },
    revision,
    version: 1,
  };
}

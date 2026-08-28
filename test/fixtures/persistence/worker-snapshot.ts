import type {
  InkElementV1,
  InkSnapshotV1,
  StrokeElementV1,
} from "../../../src/domain/schema/public";

export function createTestStroke(): StrokeElementV1 {
  return {
    createdAt: 1,
    id: "00000000-0000-4000-8000-000000000001",
    kind: "stroke",
    pivot: { x: 10, y: 10 },
    points: [10, 10, 0.5, 20, 20, 1],
    rotation: 0,
    style: {
      color: { type: "theme-text" },
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 2,
    },
    tool: "pen",
  };
}

export function createWorkerSnapshot(elements: InkElementV1[], revision = 0): InkSnapshotV1 {
  return {
    elements,
    format: "inkbook",
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    revision,
    version: 1,
  };
}

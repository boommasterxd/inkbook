import type {
  InkElementV1,
  InkSnapshotV1,
  StrokeElementV1,
} from "../../../src/domain/schema/public";
import { elementSnapshotVersion } from "../../../src/domain/schema/snapshot-version";

export function createTestStroke(): StrokeElementV1 {
  return {
    createdAt: 1,
    id: "00000000-0000-4000-8000-000000000001",
    kind: "stroke",
    pivot: { x: 10, y: 10 },
    points: [10, 10, 0.5, 20, 20, 1],
    rotation: 0,
    style: {
      color: { type: "rgba" as const, value: "#000000FF" as const },
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 2,
    },
    tool: "pen",
  };
}

/** Spans multiple pressure windows so cancellation can interrupt contour preparation. */
export function createMultiWindowPressureStroke(): StrokeElementV1 {
  return {
    ...createTestStroke(),
    points: Array.from({ length: 192 }, (_, index) => [index, index % 7, (index % 9) / 10]).flat(),
  };
}

export function createWorkerSnapshot(
  elements: InkElementV1[],
  revision = 0,
  version?: InkSnapshotV1["version"],
): InkSnapshotV1 {
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
    version: version ?? elementSnapshotVersion(elements),
  };
}

/** Ten thousand small independent strokes cover a retained scene and export workload. */
export function createCapacityStrokes(): StrokeElementV1[] {
  const original = createTestStroke();
  return Array.from({ length: 10_000 }, (_, index) => {
    const x = 100 + (index % 100) * 12;
    const y = 12 + Math.floor(index / 100) * 9;
    return {
      ...original,
      id: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
      points: [x, y, 0.5, x + 8, y + 3, 0.5],
      style: { ...original.style, pressureEnabled: false },
    };
  });
}
